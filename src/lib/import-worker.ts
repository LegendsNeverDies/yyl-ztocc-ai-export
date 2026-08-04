import "server-only";
import { db } from "@/lib/db";
import {
  importTasks,
  importTaskBatches,
  importTaskErrors,
  batchPerformanceLog,
  traceEvents,
  shipments,
  orders,
  skuMaster,
} from "@/lib/db-schema";
import { eq, and, inArray, sql as drizzleSql } from "drizzle-orm";
import { generateId } from "@/lib/utils";
import { parseFile } from "@/lib/parse-engine";
import { validateOrders, checkReceiverConsistency } from "@/lib/validators";
import { maskSensitive } from "@/lib/import-serialize";
import { loadTaskFileData, loadTaskRule } from "@/lib/import-service";
import type { OrderRow, ValidationError } from "@/types";
import { ERROR_CODES } from "@/types";

// SKU 查询超时阈值，超过则触发降级
const SKU_QUERY_TIMEOUT_MS = 3000;
// 单 Worker 一次处理的最大批次数（控制单次函数执行时长）
const MAX_BATCHES_PER_RUN = 5;
// 卡死恢复：processing 超过该时间视为卡死
const STUCK_BATCH_TIMEOUT_MS = 2 * 60 * 1000;

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
 * 设计为幂等、可重入：通过 atomic CAS 抢占批次（PENDING → PROCESSING）
 */
export async function runWorker(): Promise<{ processed: number; results: ProcessBatchResult[] }> {
  const results: ProcessBatchResult[] = [];

  // 1. 恢复卡死的批次（processing 超时 → 重置为 PENDING，retryCount+1）
  await recoverStuckBatches();

  // 2. 抢占待处理批次：用原子 UPDATE ... WHERE status='PENDING' RETURNING
  const claimed = await db
    .update(importTaskBatches)
    .set({ status: "PROCESSING", lockedAt: new Date() })
    .where(
      and(
        eq(importTaskBatches.status, "PENDING"),
        // 限制单次拉取数量
        drizzleSql`${importTaskBatches.id} IN (
          SELECT id FROM ${importTaskBatches} WHERE status = 'PENDING'
          ORDER BY batch_index ASC LIMIT ${MAX_BATCHES_PER_RUN} FOR UPDATE SKIP LOCKED
        )`
      )
    )
    .returning();

  if (claimed.length === 0) {
    return { processed: 0, results };
  }

  // 把任务标记为 PROCESSING（如果还是 PENDING）
  const taskIds = Array.from(new Set(claimed.map((b) => b.taskId)));
  for (const taskId of taskIds) {
    await db
      .update(importTasks)
      .set({ status: "PROCESSING", startedAt: new Date() })
      .where(and(eq(importTasks.id, taskId), eq(importTasks.status, "PENDING")));
  }

  // 3. 逐个处理批次
  for (const batch of claimed) {
    const traceIdRow = await db
      .select({ traceId: importTasks.traceId })
      .from(importTasks)
      .where(eq(importTasks.id, batch.taskId))
      .limit(1);
    const traceId = traceIdRow[0]?.traceId ?? "";

    await recordTrace(traceId, batch.taskId, batch.unitId, "ImportBatchStarted", "PROCESSING", `开始处理单元 ${batch.unitId}（第 ${batch.batchIndex} 批，行 ${batch.startRow}-${batch.endRow}）`);

    try {
      const result = await processSingleBatch(batch.taskId, batch.unitId, batch.batchIndex, batch.startRow, batch.endRow, traceId);
      results.push(result);
      await recordTrace(traceId, batch.taskId, batch.unitId, result.status === "COMPLETED" ? "ImportBatchSucceeded" : "ImportBatchFailed", result.status, `单元 ${batch.unitId} 完成：成功 ${result.successCount} 行，失败 ${result.failedCount} 行${result.error ? "，错误：" + result.error : ""}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      results.push({
        unitId: batch.unitId,
        batchIndex: batch.batchIndex,
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
      await recordTrace(traceId, batch.taskId, batch.unitId, "ImportBatchFailed", "FAILED", `单元 ${batch.unitId} 异常：${errMsg}`);
    }

    // 4. 任务聚合：更新任务总数并判断是否完成
    await aggregateTask(batch.taskId, traceId);
  }

  return { processed: results.length, results };
}

/**
 * 处理单个批次：幂等
 * 重复消费时若批次已是 COMPLETED，直接跳过
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

  // 幂等检查：若已是 COMPLETED，直接返回
  const existing = await db
    .select({ status: importTaskBatches.status })
    .from(importTaskBatches)
    .where(and(eq(importTaskBatches.taskId, taskId), eq(importTaskBatches.unitId, unitId)))
    .limit(1);
  if (existing[0]?.status === "COMPLETED") {
    return {
      unitId, batchIndex, status: "COMPLETED", rowCount: 0, successCount: 0, failedCount: 0,
      parseMs: 0, ruleMs: 0, validateMs: 0, insertMs: 0, totalMs: 0,
    };
  }

  // 阶段1：读取原始文件 + 规则
  const tParse0 = Date.now();
  const parsedFile = await loadTaskFileData(taskId);
  const rule = await loadTaskRule(taskId);
  if (!parsedFile || !rule) {
    throw new Error("无法加载任务文件数据或解析规则");
  }
  const parseMs = Date.now() - tParse0;

  // 阶段2：复用规则引擎解析（全量解析后按行号切片，确保 KV/聚合等跨行规则正确）
  const tRule0 = Date.now();
  const allRows = parseFile(parsedFile, rule);
  const batchRows = allRows.filter((r) => r.rowIndex >= startRow && r.rowIndex < endRow);
  const ruleMs = Date.now() - tRule0;

  // 阶段3：批量校验
  const tValidate0 = Date.now();
  const { validRows, errors } = await validateBatch(taskId, unitId, batchIndex, batchRows, traceId);
  const validateMs = Date.now() - tValidate0;

  // 阶段4：批量写入运单
  const tInsert0 = Date.now();
  let successCount = 0;
  let insertErrorMsg: string | undefined;
  if (validRows.length > 0) {
    try {
      successCount = await batchInsertOrders(validRows, taskId);
    } catch (e) {
      insertErrorMsg = e instanceof Error ? e.message : String(e);
      // 把整批标记为 DB 写入失败错误
      for (const r of validRows) {
        errors.push({
          rowIndex: r.rowIndex,
          field: "_db",
          message: `数据库写入失败：${insertErrorMsg}`,
          code: ERROR_CODES.DB_INSERT_FAILED,
          rawValue: r.skuCode || "",
        });
      }
      // 写入错误明细
      await persistErrors(taskId, unitId, batchIndex, errors, traceId);
    }
  }
  const insertMs = Date.now() - tInsert0;
  const totalMs = Date.now() - t0;

  const failedCount = errors.length;
  const status: "COMPLETED" | "FAILED" = failedCount === batchRows.length && successCount === 0 ? "FAILED" : "COMPLETED";

  // 写性能日志
  await db.insert(batchPerformanceLog).values({
    taskId,
    unitId,
    batchIndex,
    parseDurationMs: parseMs,
    ruleDurationMs: ruleMs,
    validateDurationMs: validateMs,
    insertDurationMs: insertMs,
    totalDurationMs: totalMs,
    rowCount: batchRows.length,
    successCount,
    failedCount,
    status,
    traceId,
  });

  // 更新批次状态：原子更新 processedRows/successRows/failedRows
  // 注意：幂等——重复消费时本批次已是 COMPLETED，前面已 return
  await db
    .update(importTaskBatches)
    .set({
      status,
      processedRows: batchRows.length,
      successRows: successCount,
      failedRows: failedCount,
      completedAt: new Date(),
      errorMessage: insertErrorMsg,
    })
    .where(and(eq(importTaskBatches.taskId, taskId), eq(importTaskBatches.unitId, unitId)));

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

  // 行索引 → 原始行映射，用于提取 rawValue
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

  // 2. SKU 批量校验：收集所有 skuCode，批量查询 sku_master
  const skuCodes = Array.from(new Set(rows.map((r) => r.skuCode?.trim()).filter(Boolean) as string[]));
  let existingSkuCodes = new Set<string>();
  let degraded = false;

  if (skuCodes.length > 0) {
    try {
      // 使用 Promise.race 模拟超时控制（Neon HTTP 不支持 statement_timeout 直接设置）
      const skuQueryPromise = db
        .select({ skuCode: skuMaster.skuCode })
        .from(skuMaster)
        .where(inArray(skuMaster.skuCode, skuCodes));
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SKU 查询超时")), SKU_QUERY_TIMEOUT_MS)
      );
      const skuRows = await Promise.race([skuQueryPromise, timeoutPromise]);
      existingSkuCodes = new Set(skuRows.map((r) => r.skuCode));
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

  // 4. 持久化错误明细
  await persistErrors(taskId, unitId, batchIndex, errors, traceId);

  // 5. 过滤出有效行（不含任何错误的行）
  const errorRowIndex = new Set(errors.map((e) => e.rowIndex));
  const validRows = rows.filter((r) => !errorRowIndex.has(r.rowIndex));

  return { validRows, errors };
}

// ====== 持久化错误明细（脱敏） ======
async function persistErrors(
  taskId: string,
  unitId: string,
  batchIndex: number,
  errors: (ValidationError & { code: string; rawValue?: string })[],
  traceId: string
): Promise<void> {
  if (errors.length === 0) return;
  const rows = errors.map((e) => {
    const rawValue = e.rawValue ?? "";
    return {
      taskId,
      unitId,
      batchIndex,
      rowNumber: e.rowIndex,
      fieldName: e.field,
      rawValue: maskSensitive(e.field, rawValue),
      errorCode: e.code,
      errorReason: e.message,
      traceId,
    };
  });
  // 分批写入（500/批）
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(importTaskErrors).values(rows.slice(i, i + 500));
  }
}

// ====== 批量写入运单（主子表） ======
// 复用现有 submitOrders 的分组逻辑，但改为接收已校验行
async function batchInsertOrders(orderRows: OrderRow[], taskId: string): Promise<number> {
  type SubmitRow = { externalCode: string; storeName: string; receiverName: string; receiverPhone: string; receiverAddress: string; skuCode: string; skuName: string; skuQuantity: number; skuSpec: string; remark: string; rowIndex: number };
  const rows: SubmitRow[] = orderRows.map((r) => ({
    externalCode: r.externalCode,
    storeName: r.storeName,
    receiverName: r.receiverName,
    receiverPhone: r.receiverPhone,
    receiverAddress: r.receiverAddress,
    skuCode: r.skuCode,
    skuName: r.skuName,
    skuQuantity: r.skuQuantity,
    skuSpec: r.skuSpec,
    remark: r.remark,
    rowIndex: r.rowIndex,
  }));

  // 分组：有外编码按编码聚合，无编码每行独立
  const groups = new Map<string, SubmitRow[]>();
  rows.forEach((row, idx) => {
    const code = row.externalCode?.trim();
    const key = code ? `code:${code}` : `row:${row.rowIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  });

  const batchId = taskId; // 复用 taskId 作为 batchId
  const shipmentRows: (typeof shipments.$inferInsert)[] = [];
  const orderRowsAll: (typeof orders.$inferInsert)[] = [];

  for (const group of groups.values()) {
    const shipmentId = generateId();
    const code = group[0].externalCode?.trim() || null;
    const pick = (f: keyof SubmitRow): string | null => {
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
      totalQuantity: String(totalQty),
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

  // 批量插入：先主表（100/批）后子表（500/批），并发
  const SHIPMENT_BATCH = 100;
  const ORDER_BATCH = 500;

  const shipmentBatches: Promise<unknown>[] = [];
  for (let i = 0; i < shipmentRows.length; i += SHIPMENT_BATCH) {
    shipmentBatches.push(db.insert(shipments).values(shipmentRows.slice(i, i + SHIPMENT_BATCH)));
  }
  await Promise.all(shipmentBatches);

  const orderBatches: Promise<unknown>[] = [];
  for (let i = 0; i < orderRowsAll.length; i += ORDER_BATCH) {
    orderBatches.push(db.insert(orders).values(orderRowsAll.slice(i, i + ORDER_BATCH)));
  }
  await Promise.all(orderBatches);

  return rows.length;
}

// ====== 任务聚合：更新任务进度并判断是否完成 ======
async function aggregateTask(taskId: string, traceId: string): Promise<void> {
  // 查询所有批次状态
  const batches = await db
    .select({
      status: importTaskBatches.status,
      processedRows: importTaskBatches.processedRows,
      successRows: importTaskBatches.successRows,
      failedRows: importTaskBatches.failedRows,
    })
    .from(importTaskBatches)
    .where(eq(importTaskBatches.taskId, taskId));

  const total = batches.length;
  const completed = batches.filter((b) => b.status === "COMPLETED" || b.status === "FAILED").length;
  const allCompleted = completed === total;
  const processedRows = batches.reduce((s, b) => s + b.processedRows, 0);
  const successRows = batches.reduce((s, b) => s + b.successRows, 0);
  const failedRows = batches.reduce((s, b) => s + b.failedRows, 0);
  const allFailed = allCompleted && successRows === 0;

  let newStatus: string;
  if (!allCompleted) {
    newStatus = "PROCESSING";
  } else if (allFailed) {
    newStatus = "FAILED";
  } else if (failedRows > 0) {
    newStatus = "PARTIAL_SUCCESS";
  } else {
    newStatus = "COMPLETED";
  }

  // 原子更新任务进度（使用 processed_rows/success_rows/failed_rows 绝对值，避免重复累计）
  await db
    .update(importTasks)
    .set({
      processedRows,
      successRows,
      failedRows,
      completedBatches: completed,
      status: newStatus,
      completedAt: allCompleted ? new Date() : null,
    })
    .where(eq(importTasks.id, taskId));

  // 记录 trace：任务完成事件
  if (allCompleted) {
    const eventName = newStatus === "COMPLETED" ? "ImportTaskCompleted" : newStatus === "PARTIAL_SUCCESS" ? "ImportTaskPartialSuccess" : "ImportTaskFailed";
    await recordTrace(traceId, taskId, null, eventName, newStatus, `任务完成：状态 ${newStatus}，总 ${processedRows} 行，成功 ${successRows}，失败 ${failedRows}`);
  }
}

// ====== 卡死恢复 ======
async function recoverStuckBatches(): Promise<void> {
  const stuckThreshold = new Date(Date.now() - STUCK_BATCH_TIMEOUT_MS);
  // 把 processing 超过阈值的批次重置为 PENDING，retryCount+1
  await db
    .update(importTaskBatches)
    .set({
      status: "PENDING",
      lockedAt: null,
      retryCount: drizzleSql`${importTaskBatches.retryCount} + 1`,
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
