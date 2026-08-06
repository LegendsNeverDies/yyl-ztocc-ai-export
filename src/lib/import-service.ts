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
import { ERROR_CODE_LABELS } from "@/types";

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
  const normalizedBatchSize = Math.max(250, Math.min(2000, batchSize));
  const totalBatches = Math.max(1, Math.ceil(totalRows / normalizedBatchSize));

  const fileData = serializeParsedFile(params.parsedFile);

  type TaskExecutor = Pick<typeof db, "insert">;
  const executeTaskCreation = async (executor: TaskExecutor) => {
    // 1. 任务主记录
    await executor.insert(importTasks).values({
      id: taskId,
      traceId,
      fileName: params.fileName,
      ruleId: params.ruleId,
      fileData,
      fileType: params.fileType,
      status: "PENDING",
      totalRows,
      totalBatches,
      batchSize: normalizedBatchSize,
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
      await executor.insert(importTaskBatches).values(batchRows.slice(i, i + 500));
    }
    // 批量插入 Outbox
    for (let i = 0; i < outboxRows.length; i += 500) {
      await executor.insert(eventOutbox).values(outboxRows.slice(i, i + 500));
    }

    // trace：任务创建事件
    await executor.insert(traceEvents).values({
      traceId,
      taskId,
      eventName: "ImportTaskCreated",
      eventStatus: "PENDING",
      message: `用户上传文件 ${params.fileName}，共 ${totalRows} 行，拆分为 ${totalBatches} 个处理单元`,
    });
  };

  // neon-http 可能不支持 transaction，若不支持则降级为顺序执行。
  if (typeof db.transaction === "function") {
    try {
      await db.transaction(async (tx) => {
        await executeTaskCreation(tx as TaskExecutor);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("No transactions support in neon-http driver")) {
        console.warn("[import-service] neon-http 不支持事务，已降级为非事务性导入任务创建");
        await executeTaskCreation(db);
      } else {
        throw error;
      }
    }
  } else {
    await executeTaskCreation(db);
  }

  return { taskId, traceId, totalRows, totalBatches };
}

// ====== 任务创建（基于元数据：先创建任务，延后上传文件） ======
export interface CreateTaskFromMetaParams {
  fileName: string;
  fileType: "excel" | "pdf";
  ruleId: string;
  totalRows: number;
  batchSize?: number;
}

/**
 * 基于前端预扫描得到的 totalRows 创建任务（不包含 parsedFile），返回 taskId + traceId
 * 同样会创建 import_task_batches + outbox 以便 Dispatcher 投递。
 */
export async function createImportTaskFromMeta(params: CreateTaskFromMetaParams): Promise<CreatedTask> {
  const taskId = generateId();
  const traceId = `trace_${generateId().replace(/-/g, "").slice(0, 24)}`;
  const batchSize = params.batchSize ?? 1000;
  const normalizedBatchSize = Math.max(250, Math.min(2000, batchSize));
  const totalRows = Math.max(0, Math.floor(params.totalRows));
  const totalBatches = Math.max(1, Math.ceil(totalRows / normalizedBatchSize));

  // placeholder fileData，上传后会由 attachParsedFileToTask 替换
  const fileData = serializeParsedFile({ fileType: params.fileType, sheets: [], rows: [] as any[] });

  const executeTaskCreation = async (executor: Pick<typeof db, "insert"> | typeof db) => {
    await executor.insert(importTasks).values({
      id: taskId,
      traceId,
      fileName: params.fileName,
      ruleId: params.ruleId,
      fileData,
      fileType: params.fileType,
      status: "PENDING",
      totalRows,
      totalBatches,
      batchSize: normalizedBatchSize,
    });

    const batchRows: (typeof importTaskBatches.$inferInsert)[] = [];
    const outboxRows: (typeof eventOutbox.$inferInsert)[] = [];

    for (let i = 0; i < totalBatches; i++) {
      const startRow = i * normalizedBatchSize;
      const endRow = Math.min(startRow + normalizedBatchSize, totalRows);
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

    for (let i = 0; i < batchRows.length; i += 500) {
      await executor.insert(importTaskBatches).values(batchRows.slice(i, i + 500));
    }
    for (let i = 0; i < outboxRows.length; i += 500) {
      await executor.insert(eventOutbox).values(outboxRows.slice(i, i + 500));
    }

    await executor.insert(traceEvents).values({
      traceId,
      taskId,
      eventName: "ImportTaskCreated",
      eventStatus: "PENDING",
      message: `用户预注册任务 ${params.fileName}，共 ${totalRows} 行，拆分为 ${totalBatches} 个处理单元 (meta)`,
    });
  };

  if (typeof db.transaction === "function") {
    try {
      await db.transaction(async (tx) => {
        await executeTaskCreation(tx as any);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("No transactions support in neon-http driver")) {
        console.warn("[import-service] neon-http 不支持事务，已降级为非事务性导入任务创建 (meta)");
        await executeTaskCreation(db);
      } else {
        throw error;
      }
    }
  } else {
    await executeTaskCreation(db);
  }

  return { taskId, traceId, totalRows, totalBatches };
}

/**
 * 上传后把 parsedFile 附加到已创建的任务上，并在同一事务中重建批次/Outbox（如果 totalRows 发生变化）
 */
export async function attachParsedFileToTask(taskId: string, parsedFile: ParsedFile): Promise<void> {
  const rows = parsedFile.rows || [];
  const totalRows = rows.length;

  const taskRows = await db.select().from(importTasks).where(eq(importTasks.id, taskId)).limit(1);
  if (taskRows.length === 0) throw new Error(`task ${taskId} not found`);
  const existing = taskRows[0];
  const batchSize = existing.batchSize ?? 1000;
  const normalizedBatchSize = Math.max(250, Math.min(2000, batchSize));
  const totalBatches = Math.max(1, Math.ceil(totalRows / normalizedBatchSize));

  const fileData = serializeParsedFile(parsedFile);

  // 重建批次与 outbox 的执行体
  const executeAttach = async (executor: typeof db) => {
    // 1. 更新 import_tasks 基础字段与 fileData
    await executor
      .update(importTasks)
      .set({ fileData, totalRows, totalBatches, batchSize: normalizedBatchSize })
      .where(eq(importTasks.id, taskId));

    // 2. 删除旧的批次与 outbox
    await executor.delete(importTaskBatches).where(eq(importTaskBatches.taskId, taskId));
    await executor.delete(eventOutbox).where(eq(eventOutbox.aggregateId, taskId));

    // 3. 重新创建批次与 outbox
    const batchRows: (typeof importTaskBatches.$inferInsert)[] = [];
    const outboxRows: (typeof eventOutbox.$inferInsert)[] = [];
    for (let i = 0; i < totalBatches; i++) {
      const startRow = i * normalizedBatchSize;
      const endRow = Math.min(startRow + normalizedBatchSize, totalRows);
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
        traceId: existing.traceId,
        payload: {
          event_id: generateId(),
          event_type: "ImportBatchCreated",
          schema_version: 1,
          aggregate_id: taskId,
          trace_id: existing.traceId,
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

    for (let i = 0; i < batchRows.length; i += 500) {
      await executor.insert(importTaskBatches).values(batchRows.slice(i, i + 500));
    }
    for (let i = 0; i < outboxRows.length; i += 500) {
      await executor.insert(eventOutbox).values(outboxRows.slice(i, i + 500));
    }

    await executor.insert(traceEvents).values({
      traceId: existing.traceId,
      taskId,
      eventName: "ImportFileAttached",
      eventStatus: "PENDING",
      message: `任务 ${taskId} 附加了文件，totalRows=${totalRows}，重建 ${totalBatches} 个批次`,
    });
  };

  if (typeof db.transaction === "function") {
    try {
      await db.transaction(async (tx) => {
        await executeAttach(tx as any);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("No transactions support in neon-http driver")) {
        console.warn("[import-service] neon-http 不支持事务，已降级为非事务性 attachParsedFileToTask");
        await executeAttach(db);
      } else {
        throw error;
      }
    }
  } else {
    await executeAttach(db);
  }
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

// ====== Trace 多条件搜索 ======
// 模块九要求：支持按 task_id / trace_id / 文件名 / 批次号 / 行号范围 / 错误码 搜索
export interface TraceSearchParams {
  trace_id?: string;
  task_id?: string;
  file_name?: string;
  batch_index?: number;
  row_start?: number;
  row_end?: number;
  error_code?: string;
  page: number;
  pageSize: number;
}

export interface TraceSearchResultItem {
  type: "trace_event" | "error";
  trace_id: string;
  task_id: string | null;
  unit_id: string | null;
  batch_index: number | null;
  row_number?: number;
  field_name?: string;
  raw_value?: string | null;
  error_code?: string;
  error_reason?: string;
  event_name?: string;
  event_status?: string | null;
  message?: string | null;
  occurred_at: string;
}

export async function searchTraces(params: TraceSearchParams): Promise<{
  rows: TraceSearchResultItem[];
  total: number;
}> {
  const conditions = [];
  let hasFilter = false;

  // 构建 trace_events 查询条件
  if (params.trace_id) {
    conditions.push(eq(traceEvents.traceId, params.trace_id));
    hasFilter = true;
  }
  if (params.task_id) {
    conditions.push(eq(traceEvents.taskId, params.task_id));
    hasFilter = true;
  }

  const traceResults: TraceSearchResultItem[] = [];
  let errorResults: TraceSearchResultItem[] = [];

  // 真实分页：先取两张表全部匹配项（带安全上限），合并排序后再做 offset/limit。
  // 上限避免内存爆炸，正常使用场景远小于该值。
  const FETCH_LIMIT = 1000;

  // 1. 查询 trace_events（按 trace_id / task_id）
  if (conditions.length > 0) {
    const where = and(...conditions);
    const traceRows = await db
      .select()
      .from(traceEvents)
      .where(where)
      .orderBy(desc(traceEvents.occurredAt))
      .limit(FETCH_LIMIT);

    traceResults.push(...traceRows.map((r) => ({
      type: "trace_event" as const,
      trace_id: r.traceId,
      task_id: r.taskId ?? null,
      unit_id: r.unitId ?? null,
      batch_index: null,
      event_name: r.eventName,
      event_status: r.eventStatus ?? null,
      message: r.message ?? null,
      occurred_at: r.occurredAt?.toISOString() ?? "",
    })));
  }

  // 2. 查询错误明细（支持 file_name / batch_index / row_start~row_end / error_code）
  // file_name 需要 join import_tasks 表
  const errorConditions = [];
  if (params.task_id) {
    errorConditions.push(eq(importTaskErrors.taskId, params.task_id));
    hasFilter = true;
  }
  if (params.batch_index != null) {
    errorConditions.push(eq(importTaskErrors.batchIndex, params.batch_index));
    hasFilter = true;
  }
  if (params.row_start != null) {
    errorConditions.push(gte(importTaskErrors.rowNumber, params.row_start));
    hasFilter = true;
  }
  if (params.row_end != null) {
    errorConditions.push(lte(importTaskErrors.rowNumber, params.row_end));
    hasFilter = true;
  }
  if (params.error_code) {
    errorConditions.push(eq(importTaskErrors.errorCode, params.error_code));
    hasFilter = true;
  }

  if (errorConditions.length > 0) {
    const errorWhere = and(...errorConditions);
    const errRows = await db
      .select()
      .from(importTaskErrors)
      .where(errorWhere)
      .orderBy(importTaskErrors.rowNumber)
      .limit(FETCH_LIMIT);

    errorResults = errRows.map((r) => ({
      type: "error" as const,
      trace_id: r.traceId,
      task_id: r.taskId,
      unit_id: r.unitId,
      batch_index: r.batchIndex,
      row_number: r.rowNumber,
      field_name: r.fieldName,
      raw_value: r.rawValue,
      error_code: r.errorCode,
      error_reason: r.errorReason,
      occurred_at: r.createdAt?.toISOString() ?? "",
    }));
  }

  // 3. file_name 搜索：先从 import_tasks 找到匹配的 task_id，再查 trace_events
  if (params.file_name && !hasFilter) {
    hasFilter = true;
    const pattern = "%" + params.file_name + "%";
    const taskRows = await db
      .select({ id: importTasks.id, traceId: importTasks.traceId })
      .from(importTasks)
      .where(drizzleSql`${importTasks.fileName} ILIKE ${pattern}`)
      .limit(20);

    const traceIds = taskRows.map((r) => r.traceId);
    const taskIds = taskRows.map((r) => r.id);

    if (traceIds.length > 0) {
      const traceRows = await db
        .select()
        .from(traceEvents)
        .where(inArray(traceEvents.traceId, traceIds))
        .orderBy(desc(traceEvents.occurredAt))
        .limit(FETCH_LIMIT);
      traceResults.push(...traceRows.map((r) => ({
        type: "trace_event" as const,
        trace_id: r.traceId,
        task_id: r.taskId ?? null,
        unit_id: r.unitId ?? null,
        batch_index: null,
        event_name: r.eventName,
        event_status: r.eventStatus ?? null,
        message: r.message ?? null,
        occurred_at: r.occurredAt?.toISOString() ?? "",
      })));

      // 同时查错误明细
      if (taskIds.length > 0) {
        const errRows = await db
          .select()
          .from(importTaskErrors)
          .where(inArray(importTaskErrors.taskId, taskIds))
          .orderBy(importTaskErrors.rowNumber)
          .limit(FETCH_LIMIT);
        errorResults = errRows.map((r) => ({
          type: "error" as const,
          trace_id: r.traceId,
          task_id: r.taskId,
          unit_id: r.unitId,
          batch_index: r.batchIndex,
          row_number: r.rowNumber,
          field_name: r.fieldName,
          raw_value: r.rawValue,
          error_code: r.errorCode,
          error_reason: r.errorReason,
          occurred_at: r.createdAt?.toISOString() ?? "",
        }));
      }
    }
  }

  // 如果没有任何过滤条件，返回空（避免全表扫描）
  if (!hasFilter) {
    return { rows: [], total: 0 };
  }

  // 合并结果并按时间倒序排序
  const allRows = [...traceResults, ...errorResults].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );

  // 真实分页：基于合并后的总数做 offset/limit
  const total = allRows.length;
  const offset = (params.page - 1) * params.pageSize;
  const pageRows = allRows.slice(offset, offset + params.pageSize);

  return { rows: pageRows, total };
}

// ====== 监控聚合 ======
export async function getMonitorSummary(): Promise<MonitorSummary> {
  const emptySummary: MonitorSummary = {
    throughput: [],
    queue_backlog: {
      pending_batches: 0,
      pending_rows: 0,
      status: "ok",
    },
    stage_duration: [],
    error_distribution: [],
    slow_batches_top10: [],
    failed_tasks_recent: [],
    debug_message: "监控汇总查询失败",
    debug_details: ["数据库连接异常", "相关表不存在或字段不匹配", "SQL 聚合表达式报错"],
  };

  try {
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
  // 队列积压预警：>5000 行橙色预警；查询本身失败或积压超过 20000 行红色告警
  let backlogStatus: "ok" | "warning" | "critical" = "ok";
  if (pendingRows > 20000) backlogStatus = "critical";
  else if (pendingRows > 5000) backlogStatus = "warning";

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
        reason: ERROR_CODE_LABELS[r.error_code] || r.error_code,
      })),
      slow_batches_top10: slowBatchesTop10,
      failed_tasks_recent: failedTasksRecent,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    console.error("getMonitorSummary failed", error);
    return {
      ...emptySummary,
      debug_message: message,
      debug_details: [
        "监控汇总查询失败",
        message,
        "请检查数据库连接、相关表是否存在以及 SQL 是否兼容当前环境",
      ],
    };
  }
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
