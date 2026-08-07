import "server-only";
import { db, query, withTransaction } from "@/lib/db";
import {
  importTasks,
  importTaskBatches,
  traceEvents,
  shipments,
  skuMaster,
} from "@/lib/db-schema";
import { eq, and, inArray, sql as drizzleSql } from "drizzle-orm";
import { generateId } from "@/lib/utils";
import { validateOrders, checkReceiverConsistency } from "@/lib/validators";
import { maskSensitive } from "@/lib/import-serialize";
import { CONFIG, ERROR_CODES } from "@/lib/config";
import { LRUCache } from "lru-cache";
import type { OrderRow, ValidationError } from "@/types";

// ====== SKU LRU 缓存（进程内，10min TTL，压测命中率近 100%）======
const skuExistsCache = new LRUCache<string, boolean>({
  max: CONFIG.SKU_LRU_MAX,
  ttl: CONFIG.SKU_LRU_TTL,
});

interface ProcessBatchResult {
  unitId: string;
  batchIndex: number;
  status: "COMPLETED" | "FAILED";
  rowCount: number;
  successCount: number;
  failedCount: number;
  parseMs: number;
  ruleMs: number;
  validateMs: number;
  insertMs: number;
  totalMs: number;
  error?: string;
}

/**
 * Worker 主入口：拉取 PENDING 批次并处理
 *
 * 优化（借鉴 oms-v4）：
 * - 原子 CAS claim：UPDATE ... WHERE status IN ('PENDING','FAILED') RETURNING（防竞态）
 * - 读 import_task_rows 切片，不再重读原文件/重新解析
 * - UNNEST + ON CONFLICT 批量幂等 UPSERT
 * - 进度由 batches 表派生（单一真相源），避免重复累计
 */
export async function runWorker(): Promise<{ processed: number; results: ProcessBatchResult[] }> {
  const results: ProcessBatchResult[] = [];
  const startedAt = Date.now();

  // 1. 恢复卡死的批次（processing 超时 → 标记 FAILED，不重试防死循环）
  await recoverStuckBatches();

  // 2. 原子 CAS 抢占待处理批次
  const claimed = await query<{
    id: string;
    task_id: string;
    unit_id: string;
    batch_index: number;
    start_row: number;
    end_row: number;
  }>(
    `UPDATE import_task_batches
       SET status = 'PROCESSING', locked_at = NOW()
     WHERE id IN (
       SELECT b.id
       FROM import_task_batches b
       JOIN import_task_rows r ON b.task_id = r.task_id AND b.batch_index = r.batch_index
       WHERE b.status = 'PENDING'
       ORDER BY b.batch_index ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, task_id, unit_id, batch_index, start_row, end_row`,
    [CONFIG.MAX_BATCHES_PER_RUN]
  );

  if (claimed.rows.length === 0) {
    return { processed: 0, results };
  }

  // 把任务标记为 PROCESSING（如果还是 PENDING）
  const taskIds = Array.from(new Set(claimed.rows.map((b) => b.task_id)));
  for (const taskId of taskIds) {
    await db
      .update(importTasks)
      .set({ status: "PROCESSING", startedAt: new Date() })
      .where(and(eq(importTasks.id, taskId), eq(importTasks.status, "PENDING")));
  }

  // 3. 逐个处理批次；超时前尽量处理完当前轮次
  for (const batch of claimed.rows) {
    if (Date.now() - startedAt > CONFIG.MAX_RUN_DURATION_MS) {
      break;
    }
    const traceIdRow = await db
      .select({ traceId: importTasks.traceId })
      .from(importTasks)
      .where(eq(importTasks.id, batch.task_id))
      .limit(1);
    const traceId = traceIdRow[0]?.traceId ?? "";

    await recordTrace(traceId, batch.task_id, batch.unit_id, "ImportBatchStarted", "PROCESSING", `开始处理单元 ${batch.unit_id}（第 ${batch.batch_index} 批，行 ${batch.start_row}-${batch.end_row}）`);

    try {
      const result = await processSingleBatch(batch.task_id, batch.unit_id, batch.batch_index, batch.start_row, batch.end_row, traceId);
      results.push(result);
      await recordTrace(traceId, batch.task_id, batch.unit_id, result.status === "COMPLETED" ? "ImportBatchSucceeded" : "ImportBatchFailed", result.status, `单元 ${batch.unit_id} 完成：成功 ${result.successCount} 行，失败 ${result.failedCount} 行${result.error ? "，错误：" + result.error : ""}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      results.push({
        unitId: batch.unit_id,
        batchIndex: batch.batch_index,
        status: "FAILED",
        rowCount: 0,
        successCount: 0,
        failedCount: 0,
        parseMs: 0,
        ruleMs: 0,
        validateMs: 0,
        insertMs: 0,
        totalMs: 0,
        error: errMsg,
      });
      await recordTrace(traceId, batch.task_id, batch.unit_id, "ImportBatchFailed", "FAILED", `单元 ${batch.unit_id} 异常：${errMsg}`);
    }

    // 4. 任务终态聚合：进度由 batches 派生（单一真相源）
    await aggregateTask(batch.task_id, traceId);
  }

  return { processed: results.length, results };
}

/**
 * 处理单个批次（幂等）
 *
 * 关键优化：
 * - 从 import_task_rows 读切片（上传时已解析），不再重读原文件
 * - UNNEST + ON CONFLICT 批量 UPSERT（幂等）
 * - 错误明细批量写
 */
async function processSingleBatch(
  taskId: string,
  unitId: string,
  batchIndex: number,
  startRow: number,
  endRow: number,
  traceId: string
): Promise<ProcessBatchResult> {
  const t0 = Date.now();

  // 阶段1：读 import_task_rows 切片（上传时已解析，无需重读原文件）
  const tRead = Date.now();
  const rowsRes = await query<{ rows: OrderRow[] }>(
    `SELECT rows FROM import_task_rows WHERE task_id = $1 AND batch_index = $2`,
    [taskId, batchIndex]
  );
  const batchRows: OrderRow[] = rowsRes.rows[0]?.rows || [];
  const ruleMs = Date.now() - tRead; // 含切片读取（解析已在请求内完成）
  const parseMs = 0; // 解析已在上传时完成

  if (batchRows.length === 0) {
    // 空批次直接完成
    await finalizeBatch(taskId, unitId, batchIndex, 0, 0, 0, 0, 0, 0, 0, "COMPLETED", traceId);
    return {
      unitId, batchIndex, status: "COMPLETED", rowCount: 0, successCount: 0, failedCount: 0,
      parseMs, ruleMs, validateMs: 0, insertMs: 0, totalMs: Date.now() - t0,
    };
  }

  // 阶段2：批量校验
  const tValidate = Date.now();
  const { validRows, errors } = await validateBatch(taskId, unitId, batchIndex, batchRows, traceId);
  const validateMs = Date.now() - tValidate;

  // 阶段3：批量 UPSERT 写入运单（UNNEST + ON CONFLICT）
  const tInsert = Date.now();
  let successCount = 0;
  let insertErrorMsg: string | undefined;
  if (validRows.length > 0) {
    try {
      successCount = await batchUpsertOrders(validRows, taskId);
    } catch (e) {
      insertErrorMsg = e instanceof Error ? e.message : String(e);
      for (const r of validRows) {
        errors.push({
          rowIndex: r.rowIndex,
          field: "_db",
          message: `数据库写入失败：${insertErrorMsg}`,
          code: ERROR_CODES.DB_INSERT_FAILED,
          rawValue: r.skuCode || "",
        } as ValidationError & { code: string; rawValue: string });
      }
    }
  }
  const insertMs = Date.now() - tInsert;
  const totalMs = Date.now() - t0;

  const failedCount = errors.length;
  const status: "COMPLETED" | "FAILED" = failedCount === batchRows.length && successCount === 0 ? "FAILED" : "COMPLETED";

  // 写性能日志 + 错误明细 + 批次终态（一个事务）
  await finalizeBatch(taskId, unitId, batchIndex, batchRows.length, successCount, failedCount, parseMs, ruleMs, validateMs, insertMs, status, traceId, errors, insertErrorMsg);

  return {
    unitId, batchIndex, status, rowCount: batchRows.length, successCount, failedCount,
    parseMs, ruleMs, validateMs, insertMs, totalMs, error: insertErrorMsg,
  };
}

// ====== 批量校验 ======
interface BatchValidationResult {
  validRows: OrderRow[];
  errors: (ValidationError & { code: string; rawValue?: string })[];
}

async function validateBatch(
  taskId: string,
  unitId: string,
  batchIndex: number,
  rows: OrderRow[],
  traceId: string
): Promise<BatchValidationResult> {
  const errors: (ValidationError & { code: string; rawValue?: string })[] = [];

  const rowMap = new Map<number, OrderRow>();
  for (const r of rows) rowMap.set(r.rowIndex, r);

  // 1. 本地格式校验（复用现有 validators）
  const localErrors = validateOrders(rows);
  for (const e of localErrors) {
    let code: string = ERROR_CODES.REQUIRED_MISSING;
    if (e.field === "receiverPhone") code = ERROR_CODES.PHONE_FORMAT;
    else if (e.field === "skuQuantity") code = ERROR_CODES.QTY_NOT_POSITIVE;
    else if (e.field === "skuCode" || e.field === "skuName") code = ERROR_CODES.REQUIRED_MISSING;
    const origRow = rowMap.get(e.rowIndex);
    const rawVal = origRow ? String((origRow as unknown as Record<string, unknown>)[e.field] ?? "") : "";
    errors.push({ ...e, code, rawValue: rawVal });
  }

  // 一致性校验
  const consistencyErrors = checkReceiverConsistency(rows);
  for (const e of consistencyErrors) {
    const origRow = rowMap.get(e.rowIndex);
    const rawVal = origRow ? String((origRow as unknown as Record<string, unknown>)[e.field] ?? "") : "";
    errors.push({ ...e, code: ERROR_CODES.REQUIRED_MISSING, rawValue: rawVal });
  }

  // 2. SKU 批量校验：LRU 缓存 + ANY 查询 + 3s 超时降级
  const skuCodes = Array.from(new Set(rows.map((r) => r.skuCode?.trim()).filter(Boolean) as string[]));
  const existingSkuCodes = new Set<string>();
  let degraded = false;

  if (skuCodes.length > 0) {
    // 先查 LRU 缓存
    const toQuery: string[] = [];
    for (const code of skuCodes) {
      if (skuExistsCache.has(code)) {
        if (skuExistsCache.get(code)) existingSkuCodes.add(code);
      } else {
        toQuery.push(code);
      }
    }

    // 未命中的批量查 DB
    if (toQuery.length > 0) {
      try {
        const skuQueryPromise = db
          .select({ skuCode: skuMaster.skuCode })
          .from(skuMaster)
          .where(inArray(skuMaster.skuCode, toQuery));
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SKU 查询超时")), CONFIG.SKU_DEGRADE_TIMEOUT_MS)
        );
        const skuRows = await Promise.race([skuQueryPromise, timeoutPromise]);
        const foundSet = new Set(skuRows.map((r) => r.skuCode));
        for (const code of toQuery) {
          if (foundSet.has(code)) {
            existingSkuCodes.add(code);
            skuExistsCache.set(code, true);
          } else {
            skuExistsCache.set(code, false);
          }
        }
      } catch {
        // 降级模式
        degraded = true;
        await db
          .update(importTasks)
          .set({ degraded: true, degradedReason: "SKU 主数据查询超时或失败，已跳过 SKU 校验" })
          .where(eq(importTasks.id, taskId));
        await recordTrace(traceId, taskId, unitId, "ImportTaskDegraded", "DEGRADED", "SKU 查询超时，进入降级模式：跳过 SKU 主数据校验，仅做本地格式校验");
      }
    }
  }

  // 标记 SKU 不存在的错误（非降级模式下）
  if (!degraded) {
    for (const r of rows) {
      const code = r.skuCode?.trim();
      if (code && !existingSkuCodes.has(code)) {
        errors.push({
          rowIndex: r.rowIndex,
          field: "skuCode",
          message: `SKU"${code}"在主数据中不存在`,
          code: ERROR_CODES.SKU_NOT_EXIST,
          rawValue: code,
        });
      }
    }
  }

  // 3. 外部编码重复检测（与数据库已有数据对比）
  const externalCodes = Array.from(new Set(rows.map((r) => r.externalCode?.trim()).filter(Boolean) as string[]));
  if (externalCodes.length > 0) {
    const dupRows = await db
      .select({ code: shipments.externalCode })
      .from(shipments)
      .where(and(drizzleSql`${shipments.externalCode} IS NOT NULL`, inArray(shipments.externalCode, externalCodes)));
    const dupSet = new Set(dupRows.map((r) => r.code).filter(Boolean) as string[]);
    const reported = new Set<string>();
    for (const r of rows) {
      const code = r.externalCode?.trim();
      if (code && dupSet.has(code) && !reported.has(code)) {
        reported.add(code);
        errors.push({
          rowIndex: r.rowIndex,
          field: "externalCode",
          message: `外部编码"${code}"已存在于数据库中`,
          code: ERROR_CODES.EXTERNAL_CODE_DUP,
        });
      }
    }
  }

  // 4. 过滤出有效行（不含任何错误的行）
  const errorRowIndex = new Set(errors.map((e) => e.rowIndex));
  const validRows = rows.filter((r) => !errorRowIndex.has(r.rowIndex));

  return { validRows, errors };
}

// ====== 批量 UPSERT 写入运单（主子表，UNNEST + ON CONFLICT 幂等）======
async function batchUpsertOrders(orderRows: OrderRow[], taskId: string): Promise<number> {
  // 分组：有外编码按编码聚合，无编码每行独立
  const groups = new Map<string, OrderRow[]>();
  orderRows.forEach((row) => {
    const code = row.externalCode?.trim();
    const key = code ? `code:${code}` : `row:${row.rowIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  });

  const batchId = taskId;
  const shipmentRows: { id: string; externalCode: string | null; storeName: string | null; receiverName: string | null; receiverPhone: string | null; receiverAddress: string | null; remark: string | null; skuCount: number; totalQuantity: number; batchId: string }[] = [];
  const orderRowsAll: { shipmentId: string; skuCode: string; skuName: string; skuQuantity: string; skuSpec: string | null; remark: string | null }[] = [];

  for (const group of groups.values()) {
    const shipmentId = generateId();
    const code = group[0].externalCode?.trim() || null;
    const pick = (f: keyof OrderRow): string | null => {
      for (const r of group) {
        const v = String(r[f] ?? "").trim();
        if (v) return v;
      }
      return null;
    };
    const totalQty = group.reduce((s, r) => s + (Number(r.skuQuantity) || 0), 0);

    shipmentRows.push({
      id: shipmentId,
      externalCode: code,
      storeName: pick("storeName"),
      receiverName: pick("receiverName"),
      receiverPhone: pick("receiverPhone"),
      receiverAddress: pick("receiverAddress"),
      remark: pick("remark"),
      skuCount: group.length,
      totalQuantity: totalQty,
      batchId,
    });

    for (const r of group) {
      orderRowsAll.push({
        shipmentId,
        skuCode: r.skuCode,
        skuName: r.skuName,
        skuQuantity: String(r.skuQuantity),
        skuSpec: r.skuSpec || null,
        remark: r.remark || null,
      });
    }
  }

  // 批量 UPSERT shipments（ON CONFLICT external_code DO NOTHING，防重复投递）
  // 注意：numeric 列用 ::text[] 传入，在 SELECT 中 ::numeric 强制转换，避免 UNNEST 类型推断失败
  if (shipmentRows.length > 0) {
    await query(
      `INSERT INTO shipments (id, external_code, store_name, receiver_name, receiver_phone, receiver_address, remark, sku_count, total_quantity, batch_id)
       SELECT id::uuid, external_code, store_name, receiver_name, receiver_phone, receiver_address, remark, sku_count::int, total_quantity::numeric, batch_id::uuid
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
         AS t(id, external_code, store_name, receiver_name, receiver_phone, receiver_address, remark, sku_count, total_quantity, batch_id)
       ON CONFLICT (external_code) WHERE external_code IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        shipmentRows.map((s) => s.id),
        shipmentRows.map((s) => s.externalCode),
        shipmentRows.map((s) => s.storeName),
        shipmentRows.map((s) => s.receiverName),
        shipmentRows.map((s) => s.receiverPhone),
        shipmentRows.map((s) => s.receiverAddress),
        shipmentRows.map((s) => s.remark),
        shipmentRows.map((s) => String(s.skuCount)),
        shipmentRows.map((s) => String(s.totalQuantity)),
        shipmentRows.map((s) => s.batchId),
      ]
    );
  }

  // 批量 UPSERT orders（ON CONFLICT (shipment_id, sku_code) DO NOTHING，幂等）
  // 同样用 ::text[] + ::numeric 避免 numeric 类型推断问题
  if (orderRowsAll.length > 0) {
    await query(
      `INSERT INTO orders (shipment_id, sku_code, sku_name, sku_quantity, sku_spec, remark)
       SELECT shipment_id::uuid, sku_code, sku_name, sku_quantity::numeric, sku_spec, remark
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         AS t(shipment_id, sku_code, sku_name, sku_quantity, sku_spec, remark)
       ON CONFLICT (shipment_id, sku_code) DO NOTHING
       RETURNING id`,
      [
        orderRowsAll.map((o) => o.shipmentId),
        orderRowsAll.map((o) => o.skuCode),
        orderRowsAll.map((o) => o.skuName),
        orderRowsAll.map((o) => String(o.skuQuantity)),
        orderRowsAll.map((o) => o.skuSpec),
        orderRowsAll.map((o) => o.remark),
      ]
    );
  }

  return orderRows.length;
}

// ====== 批次终态写入（性能日志 + 错误明细 + 批次状态，一个事务）======
async function finalizeBatch(
  taskId: string,
  unitId: string,
  batchIndex: number,
  rowCount: number,
  successCount: number,
  failedCount: number,
  parseMs: number,
  ruleMs: number,
  validateMs: number,
  insertMs: number,
  status: "COMPLETED" | "FAILED",
  traceId: string,
  errors?: (ValidationError & { code: string; rawValue?: string })[],
  errorMsg?: string | undefined
): Promise<void> {
  const totalMs = parseMs + ruleMs + validateMs + insertMs;

  await withTransaction(async (tx) => {
    // 错误明细批量写（UNNEST）
    if (errors && errors.length > 0) {
      await tx.query(
        `INSERT INTO import_task_errors (task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, trace_id)
         SELECT $1, $2, $3, row_number, field_name, raw_value, error_code, error_reason, $4
         FROM UNNEST($5::int[], $6::text[], $7::text[], $8::text[], $9::text[])
           AS t(row_number, field_name, raw_value, error_code, error_reason)`,
        [
          taskId, unitId, batchIndex, traceId,
          errors.map((e) => e.rowIndex),
          errors.map((e) => e.field),
          errors.map((e) => maskSensitive(e.field, e.rawValue ?? "")),
          errors.map((e) => e.code),
          errors.map((e) => e.message),
        ]
      );
    }

    // 性能日志
    await tx.query(
      `INSERT INTO batch_performance_log (task_id, unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms, insert_duration_ms, total_duration_ms, row_count, success_count, failed_count, status, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [taskId, unitId, batchIndex, parseMs, ruleMs, validateMs, insertMs, totalMs, rowCount, successCount, failedCount, status, traceId]
    );

    // 批次终态
    await tx.query(
      `UPDATE import_task_batches SET status = $3, processed_rows = $4, success_rows = $5, failed_rows = $6, completed_at = $7, error_message = $8, locked_at = NULL
       WHERE task_id = $1 AND unit_id = $2`,
      [taskId, unitId, status, rowCount, successCount, failedCount, status === "COMPLETED" ? new Date() : null, errorMsg ?? null]
    );
  });
}

// ====== 任务终态聚合：进度由 batches 表派生（单一真相源）======
async function aggregateTask(taskId: string, traceId: string): Promise<void> {
  // 从 batches 表派生进度（重复消费不会让 processed 翻倍）
  const progressRes = await query<{
    processed_rows: number;
    success_rows: number;
    failed_rows: number;
    completed_batches: number;
    total_batches: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('COMPLETED','FAILED') THEN processed_rows ELSE 0 END), 0)::int AS processed_rows,
       COALESCE(SUM(success_rows), 0)::int AS success_rows,
       COALESCE(SUM(failed_rows), 0)::int AS failed_rows,
       COUNT(*) FILTER (WHERE status IN ('COMPLETED','FAILED'))::int AS completed_batches,
       COUNT(*)::int AS total_batches
     FROM import_task_batches WHERE task_id = $1`,
    [taskId]
  );
  const p = progressRes.rows[0];
  if (!p) return;

  const allCompleted = p.completed_batches === p.total_batches;
  const allFailed = allCompleted && p.success_rows === 0 && p.processed_rows > 0;

  let newStatus: string;
  if (!allCompleted) {
    newStatus = "PROCESSING";
  } else if (allFailed) {
    newStatus = "FAILED";
  } else if (p.failed_rows > 0) {
    newStatus = "PARTIAL_SUCCESS";
  } else {
    newStatus = "COMPLETED";
  }

  // 原子更新任务进度（绝对值，由 batches 派生，避免重复累计）
  await db
    .update(importTasks)
    .set({
      processedRows: p.processed_rows,
      successRows: p.success_rows,
      failedRows: p.failed_rows,
      completedBatches: p.completed_batches,
      status: newStatus,
      completedAt: allCompleted ? new Date() : null,
    })
    .where(eq(importTasks.id, taskId));

  // 记录 trace：任务完成事件
  if (allCompleted) {
    const eventName = newStatus === "COMPLETED" ? "ImportTaskCompleted" : newStatus === "PARTIAL_SUCCESS" ? "ImportTaskPartialSuccess" : "ImportTaskFailed";
    await recordTrace(traceId, taskId, null, eventName, newStatus, `任务完成：状态 ${newStatus}，总 ${p.processed_rows} 行，成功 ${p.success_rows}，失败 ${p.failed_rows}`);
  }
}

// ====== 卡死恢复：processing 超时 → 标记 FAILED（不重置 PENDING，防死循环）======
async function recoverStuckBatches(): Promise<void> {
  const stuckThreshold = new Date(Date.now() - CONFIG.STUCK_BATCH_MS);
  await db
    .update(importTaskBatches)
    .set({
      status: "FAILED",
      errorMessage: "processing 超时被 recover-stuck 标记",
      completedAt: new Date(),
      lockedAt: null,
    })
    .where(
      and(
        eq(importTaskBatches.status, "PROCESSING"),
        drizzleSql`${importTaskBatches.lockedAt} < ${stuckThreshold}`
      )
    );
}

// ====== Trace 事件记录 ======
export async function recordTrace(
  traceId: string,
  taskId: string | null,
  unitId: string | null,
  eventName: string,
  eventStatus: string | null,
  message: string
): Promise<void> {
  await db.insert(traceEvents).values({
    traceId,
    taskId: taskId || null,
    unitId: unitId || null,
    eventName,
    eventStatus,
    message,
  });
}
