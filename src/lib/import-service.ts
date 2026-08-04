import "server-only";
import { db, sql } from "@/lib/db";
import {
  importTasks,
  importTaskBatches,
  importTaskErrors,
  eventOutbox,
  batchPerformanceLog,
  traceEvents,
} from "@/lib/db-schema";
import { eq, and, desc, inArray, lte, gte, sql as drizzleSql } from "drizzle-orm";
import { generateId } from "@/lib/utils";
import { serializeParsedFile, deserializeParsedFile } from "@/lib/import-serialize";
import type { ParsedFile, ParseRule, ImportTaskProgress, ImportTaskErrorRow, BatchPerformanceRow, TraceEventRow, MonitorSummary } from "@/types";

// ====== 任务创建 ======
export interface CreateTaskParams {
  fileName: string;
  fileType: "excel" | "pdf";
  ruleId: string;
  parsedFile: ParsedFile;
  batchSize?: number;
}

export interface CreatedTask {
  taskId: string;
  traceId: string;
  totalRows: number;
  totalBatches: number;
}

/**
 * 创建导入任务 + 批次 + Outbox 事件（同一事务）
 * Neon HTTP 的 drizzle transaction 是基于批量 HTTP 请求模拟的，
 * 但仍保证所有语句在一个请求中提交，满足"任务与 Outbox 同事务"要求。
 */
export async function createImportTask(params: CreateTaskParams): Promise<CreatedTask> {
  const taskId = generateId();
  const traceId = `trace_${generateId().replace(/-/g, "").slice(0, 24)}`;
  const batchSize = params.batchSize ?? 1000;
  const totalRows = params.parsedFile.rows.length;
  const totalBatches = Math.max(1, Math.ceil(totalRows / batchSize));

  const fileData = serializeParsedFile(params.parsedFile);

  // 同一事务：建任务 + 建批次 + 写 Outbox 事件 + 写 trace
  await db.transaction(async (tx) => {
    // 1. 任务主记录
    await tx.insert(importTasks).values({
      id: taskId,
      traceId,
      fileName: params.fileName,
      ruleId: params.ruleId,
      fileData,
      fileType: params.fileType,
      status: "PENDING",
      totalRows,
      totalBatches,
      batchSize,
    });

    // 2. 批次记录 + Outbox 事件 + trace 事件
    const batchRows: (typeof importTaskBatches.$inferInsert)[] = [];
    const outboxRows: (typeof eventOutbox.$inferInsert)[] = [];

    for (let i = 0; i < totalBatches; i++) {
      const startRow = i * batchSize;
      const endRow = Math.min(startRow + batchSize, totalRows);
      const unitId = `${taskId.slice(0, 8)}_b${i}`;

      batchRows.push({
        taskId,
        unitId,
        batchIndex: i,
        startRow,
        endRow,
        status: "PENDING",
      });

      outboxRows.push({
        id: generateId(),
        aggregateId: taskId,
        eventType: "ImportBatchCreated",
        schemaVersion: 1,
        traceId,
        payload: {
          event_id: generateId(),
          event_type: "ImportBatchCreated",
          schema_version: 1,
          aggregate_id: taskId,
          trace_id: traceId,
          occurred_at: new Date().toISOString(),
          payload: {
            task_id: taskId,
            unit_id: unitId,
            batch_index: i,
            start_row: startRow,
            end_row: endRow,
          },
        },
        status: "PENDING",
        nextRetryAt: new Date(),
      });
    }

    // 批量插入批次记录
    for (let i = 0; i < batchRows.length; i += 500) {
      await tx.insert(importTaskBatches).values(batchRows.slice(i, i + 500));
    }
    // 批量插入 Outbox
    for (let i = 0; i < outboxRows.length; i += 500) {
      await tx.insert(eventOutbox).values(outboxRows.slice(i, i + 500));
    }

    // trace：任务创建事件
    await tx.insert(traceEvents).values({
      traceId,
      taskId,
      eventName: "ImportTaskCreated",
      eventStatus: "PENDING",
      message: `用户上传文件 ${params.fileName}，共 ${totalRows} 行，拆分为 ${totalBatches} 个处理单元`,
    });
  });

  return { taskId, traceId, totalRows, totalBatches };
}

// ====== 任务查询 ======
export async function getTaskProgress(taskId: string): Promise<ImportTaskProgress | null> {
  const rows = await db.select().from(importTasks).where(eq(importTasks.id, taskId)).limit(1);
  if (rows.length === 0) return null;
  const t = rows[0];

  const processed = t.processedRows;
  const success = t.successRows;
  let throughput: number | undefined;
  let etaSeconds: number | null | undefined;

  if (t.startedAt && processed > 0 && processed < t.totalRows) {
    const elapsedMs = (t.startedAt?.getTime?.() ?? Date.parse(t.startedAt as unknown as string)) || 0;
    const now = Date.now();
    const elapsedSec = Math.max(1, (now - elapsedMs) / 1000);
    throughput = processed / elapsedSec;
    const remaining = t.totalRows - processed;
    etaSeconds = throughput > 0 ? Math.ceil(remaining / throughput) : null;
  }
  if (t.status === "COMPLETED" || t.status === "PARTIAL_SUCCESS") {
    etaSeconds = 0;
  }

  return {
    task_id: t.id,
    trace_id: t.traceId,
    status: t.status as ImportTaskProgress["status"],
    file_name: t.fileName,
    total_rows: t.totalRows,
    processed_rows: t.processedRows,
    success_rows: t.successRows,
    failed_rows: t.failedRows,
    total_batches: t.totalBatches,
    completed_batches: t.completedBatches,
    degraded: t.degraded,
    degraded_reason: t.degradedReason,
    created_at: t.createdAt?.toISOString() ?? new Date().toISOString(),
    started_at: t.startedAt?.toISOString?.() ?? null,
    completed_at: t.completedAt?.toISOString?.() ?? null,
    error_message: t.errorMessage,
    throughput,
    eta_seconds: etaSeconds ?? null,
  };
}

// ====== 错误明细查询（分页） ======
export async function getTaskErrors(
  taskId: string,
  params: { batch?: number; errorCode?: string; page: number; pageSize: number }
): Promise<{ rows: ImportTaskErrorRow[]; total: number }> {
  const conditions = [eq(importTaskErrors.taskId, taskId)];
  if (params.batch != null) conditions.push(eq(importTaskErrors.batchIndex, params.batch));
  if (params.errorCode) conditions.push(eq(importTaskErrors.errorCode, params.errorCode));
  const where = and(...conditions);

  const [countResult] = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(importTaskErrors)
    .where(where)
    .execute();
  const total = Number(countResult?.count || 0);

  const rows = await db
    .select()
    .from(importTaskErrors)
    .where(where)
    .orderBy(importTaskErrors.rowNumber)
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      task_id: r.taskId,
      unit_id: r.unitId,
      batch_index: r.batchIndex,
      row_number: r.rowNumber,
      field_name: r.fieldName,
      raw_value: r.rawValue,
      error_code: r.errorCode,
      error_reason: r.errorReason,
      trace_id: r.traceId,
      created_at: r.createdAt?.toISOString() ?? "",
    })),
    total,
  };
}

// ====== 批次性能查询 ======
export async function getTaskBatches(taskId: string): Promise<BatchPerformanceRow[]> {
  const rows = await db
    .select()
    .from(batchPerformanceLog)
    .where(eq(batchPerformanceLog.taskId, taskId))
    .orderBy(batchPerformanceLog.batchIndex);
  return rows.map((r) => ({
    id: r.id,
    task_id: r.taskId,
    unit_id: r.unitId,
    batch_index: r.batchIndex,
    parse_duration_ms: r.parseDurationMs,
    rule_duration_ms: r.ruleDurationMs,
    validate_duration_ms: r.validateDurationMs,
    insert_duration_ms: r.insertDurationMs,
    total_duration_ms: r.totalDurationMs,
    row_count: r.rowCount,
    success_count: r.successCount,
    failed_count: r.failedCount,
    status: r.status,
    trace_id: r.traceId,
    created_at: r.createdAt?.toISOString() ?? "",
  }));
}

// ====== Trace 检索 ======
export async function getTraceEvents(traceId: string): Promise<TraceEventRow[]> {
  const rows = await db
    .select()
    .from(traceEvents)
    .where(eq(traceEvents.traceId, traceId))
    .orderBy(traceEvents.occurredAt);
  return rows.map((r) => ({
    id: r.id,
    trace_id: r.traceId,
    task_id: r.taskId ?? null,
    unit_id: r.unitId ?? null,
    event_name: r.eventName,
    event_status: r.eventStatus ?? null,
    message: r.message ?? null,
    occurred_at: r.occurredAt?.toISOString() ?? "",
  }));
}

// ====== 监控聚合 ======
export async function getMonitorSummary(): Promise<MonitorSummary> {
  // 1. 最近5分钟吞吐：按 completed_at 分钟分桶聚合 success_rows（从 import_tasks）
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const throughputRows = await db
    .select({
      minute: drizzleSql<string>`to_char(date_trunc('minute', ${importTasks.completedAt}), 'HH24:MI')`,
      success_rows: drizzleSql<number>`sum(${importTasks.successRows})`,
    })
    .from(importTasks)
    .where(and(gte(importTasks.completedAt, fiveMinAgo), inArray(importTasks.status, ["COMPLETED", "PARTIAL_SUCCESS"])))
    .groupBy(drizzleSql`date_trunc('minute', ${importTasks.completedAt})`)
    .orderBy(drizzleSql`date_trunc('minute', ${importTasks.completedAt})`);

  // 2. 队列积压：pending 批次数 + 对应行数
  const backlogRows = await db
    .select({
      pending_batches: drizzleSql<number>`count(*)`,
      pending_rows: drizzleSql<number>`coalesce(sum(${importTaskBatches.endRow} - ${importTaskBatches.startRow}), 0)`,
    })
    .from(importTaskBatches)
    .where(eq(importTaskBatches.status, "PENDING"));
  const pendingBatches = Number(backlogRows[0]?.pending_batches ?? 0);
  const pendingRows = Number(backlogRows[0]?.pending_rows ?? 0);
  const backlogStatus: "ok" | "warning" | "critical" =
    pendingBatches === 0 ? "ok" : pendingRows > 5000 ? "warning" : "ok";

  // 3. 阶段耗时分布（基于 batch_performance_log 最近1小时）
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const stageRows = await db
    .select({
      parse_p50: drizzleSql<number>`coalesce(percentile_cont(0.5) within group (order by ${batchPerformanceLog.parseDurationMs}), 0)`,
      parse_p95: drizzleSql<number>`coalesce(percentile_cont(0.95) within group (order by ${batchPerformanceLog.parseDurationMs}), 0)`,
      parse_p99: drizzleSql<number>`coalesce(percentile_cont(0.99) within group (order by ${batchPerformanceLog.parseDurationMs}), 0)`,
      rule_p50: drizzleSql<number>`coalesce(percentile_cont(0.5) within group (order by ${batchPerformanceLog.ruleDurationMs}), 0)`,
      rule_p95: drizzleSql<number>`coalesce(percentile_cont(0.95) within group (order by ${batchPerformanceLog.ruleDurationMs}), 0)`,
      rule_p99: drizzleSql<number>`coalesce(percentile_cont(0.99) within group (order by ${batchPerformanceLog.ruleDurationMs}), 0)`,
      validate_p50: drizzleSql<number>`coalesce(percentile_cont(0.5) within group (order by ${batchPerformanceLog.validateDurationMs}), 0)`,
      validate_p95: drizzleSql<number>`coalesce(percentile_cont(0.95) within group (order by ${batchPerformanceLog.validateDurationMs}), 0)`,
      validate_p99: drizzleSql<number>`coalesce(percentile_cont(0.99) within group (order by ${batchPerformanceLog.validateDurationMs}), 0)`,
      insert_p50: drizzleSql<number>`coalesce(percentile_cont(0.5) within group (order by ${batchPerformanceLog.insertDurationMs}), 0)`,
      insert_p95: drizzleSql<number>`coalesce(percentile_cont(0.95) within group (order by ${batchPerformanceLog.insertDurationMs}), 0)`,
      insert_p99: drizzleSql<number>`coalesce(percentile_cont(0.99) within group (order by ${batchPerformanceLog.insertDurationMs}), 0)`,
    })
    .from(batchPerformanceLog)
    .where(gte(batchPerformanceLog.createdAt, oneHourAgo));
  const sr = stageRows[0] ?? {};
  const stageDuration = [
    { stage: "解析", p50: Number(sr.parse_p50 ?? 0), p95: Number(sr.parse_p95 ?? 0), p99: Number(sr.parse_p99 ?? 0) },
    { stage: "规则", p50: Number(sr.rule_p50 ?? 0), p95: Number(sr.rule_p95 ?? 0), p99: Number(sr.rule_p99 ?? 0) },
    { stage: "校验", p50: Number(sr.validate_p50 ?? 0), p95: Number(sr.validate_p95 ?? 0), p99: Number(sr.validate_p99 ?? 0) },
    { stage: "写入", p50: Number(sr.insert_p50 ?? 0), p95: Number(sr.insert_p95 ?? 0), p99: Number(sr.insert_p99 ?? 0) },
  ];

  // 4. 错误类型分布
  const errorDistRows = await db
    .select({
      error_code: importTaskErrors.errorCode,
      count: drizzleSql<number>`count(*)`,
    })
    .from(importTaskErrors)
    .where(gte(importTaskErrors.createdAt, oneHourAgo))
    .groupBy(importTaskErrors.errorCode)
    .orderBy(desc(drizzleSql`count(*)`));

  // 5. 慢批次 TOP 10
  const slowRows = await db
    .select()
    .from(batchPerformanceLog)
    .where(gte(batchPerformanceLog.createdAt, oneHourAgo))
    .orderBy(desc(batchPerformanceLog.totalDurationMs))
    .limit(10);
  const slowBatchesTop10 = slowRows.map((r) => ({
    id: r.id,
    task_id: r.taskId,
    unit_id: r.unitId,
    batch_index: r.batchIndex,
    parse_duration_ms: r.parseDurationMs,
    rule_duration_ms: r.ruleDurationMs,
    validate_duration_ms: r.validateDurationMs,
    insert_duration_ms: r.insertDurationMs,
    total_duration_ms: r.totalDurationMs,
    row_count: r.rowCount,
    success_count: r.successCount,
    failed_count: r.failedCount,
    status: r.status,
    trace_id: r.traceId,
    created_at: r.createdAt?.toISOString() ?? "",
  }));

  // 6. 最近失败任务
  const failedTasks = await db
    .select({
      id: importTasks.id,
      file_name: importTasks.fileName,
      failed_rows: importTasks.failedRows,
      created_at: importTasks.createdAt,
    })
    .from(importTasks)
    .where(inArray(importTasks.status, ["FAILED", "PARTIAL_SUCCESS"]))
    .orderBy(desc(importTasks.createdAt))
    .limit(10);
  const failedTasksRecent = failedTasks.map((r) => ({
    id: r.id,
    file_name: r.file_name,
    failed_rows: r.failed_rows,
    created_at: r.created_at?.toISOString() ?? "",
  }));

  return {
    throughput: throughputRows.map((r) => ({
      minute: r.minute,
      success_rows: Number(r.success_rows ?? 0),
    })),
    queue_backlog: {
      pending_batches: pendingBatches,
      pending_rows: pendingRows,
      status: backlogStatus,
    },
    stage_duration: stageDuration,
    error_distribution: errorDistRows.map((r) => ({
      error_code: r.error_code,
      count: Number(r.count),
      reason: "",
    })),
    slow_batches_top10: slowBatchesTop10,
    failed_tasks_recent: failedTasksRecent,
  };
}

// ====== 内部：读取任务原始文件并重建 ParsedFile ======
export async function loadTaskFileData(taskId: string): Promise<ParsedFile | null> {
  const rows = await db
    .select({ fileData: importTasks.fileData, ruleId: importTasks.ruleId })
    .from(importTasks)
    .where(eq(importTasks.id, taskId))
    .limit(1);
  if (rows.length === 0) return null;
  return deserializeParsedFile(rows[0].fileData);
}

export async function loadTaskRule(taskId: string): Promise<ParseRule | null> {
  const rows = await db
    .select({ ruleId: importTasks.ruleId })
    .from(importTasks)
    .where(eq(importTasks.id, taskId))
    .limit(1);
  if (rows.length === 0) return null;
  const ruleId = rows[0].ruleId;
  // 复用已有 getRule
  const { getRule } = await import("@/lib/server-actions");
  return getRule(ruleId);
}
