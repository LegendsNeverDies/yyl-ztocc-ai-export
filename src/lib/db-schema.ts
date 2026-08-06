import { pgTable, uuid, varchar, text, numeric, integer, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

// ====== 已有表（保持兼容） ======

export const parseRules = pgTable("parse_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 出库单主表：按外部编码聚合，存收货信息与冗余汇总
export const shipments = pgTable("shipments", {
  id: uuid("id").defaultRandom().primaryKey(),
  externalCode: varchar("external_code", { length: 255 }),
  storeName: varchar("store_name", { length: 255 }),
  receiverName: varchar("receiver_name", { length: 255 }),
  receiverPhone: varchar("receiver_phone", { length: 50 }),
  receiverAddress: text("receiver_address"),
  remark: text("remark"),
  skuCount: integer("sku_count").notNull().default(0),
  totalQuantity: numeric("total_quantity").notNull().default("0"),
  batchId: uuid("batch_id").notNull(),
  submittedAt: timestamp("submitted_at").defaultNow(),
}, (t) => [
  // 唯一索引：external_code 非空时唯一（PG 中多个 NULL 不冲突，无需部分索引）
  // 对应 UNNEST + ON CONFLICT (external_code) DO NOTHING 幂等写入
  uniqueIndex("shipments_external_code_uniq").on(t.externalCode),
  index("shipments_batch_id_idx").on(t.batchId),
]);

// SKU 明细子表：关联到 shipments
// uniq_shipment_sku 唯一索引用于 UNNEST + ON CONFLICT 幂等写入（同一出库单内同一 SKU 不重复）
export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id").notNull().references(() => shipments.id, { onDelete: "cascade" }),
  skuCode: varchar("sku_code", { length: 255 }).notNull(),
  skuName: varchar("sku_name", { length: 500 }).notNull(),
  skuQuantity: numeric("sku_quantity").notNull(),
  skuSpec: varchar("sku_spec", { length: 500 }),
  remark: text("remark"),
}, (t) => [
  index("orders_shipment_id_idx").on(t.shipmentId),
  index("orders_sku_code_idx").on(t.skuCode),
  uniqueIndex("uniq_shipment_sku").on(t.shipmentId, t.skuCode),
]);

// ====== 新增：异步导入链路相关表 ======

// SKU 主数据表（压测与校验依赖）
export const skuMaster = pgTable("sku_master", {
  id: uuid("id").defaultRandom().primaryKey(),
  skuCode: varchar("sku_code", { length: 255 }).notNull(),
  name: varchar("name", { length: 500 }).notNull(),
  spec: varchar("spec", { length: 500 }),
  unit: varchar("unit", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("sku_master_sku_code_uniq").on(t.skuCode),
]);

// 导入任务主表：一次上传=一个任务
export const importTasks = pgTable("import_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  traceId: varchar("trace_id", { length: 64 }).notNull(),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  ruleId: uuid("rule_id").notNull(),
  // 任务原始文件数据（RawRow[] / sheets），Worker 重读解析
  fileData: jsonb("file_data").notNull(),
  fileType: varchar("file_type", { length: 20 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("PENDING"), // PENDING/PROCESSING/COMPLETED/PARTIAL_SUCCESS/FAILED
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  successRows: integer("success_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  totalBatches: integer("total_batches").notNull().default(0),
  completedBatches: integer("completed_batches").notNull().default(0),
  degraded: boolean("degraded").notNull().default(false),
  degradedReason: text("degraded_reason"),
  errorMessage: text("error_message"),
  batchSize: integer("batch_size").notNull().default(1000),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (t) => [
  index("import_tasks_status_created_idx").on(t.status, t.createdAt),
  index("import_tasks_trace_id_idx").on(t.traceId),
]);

// 处理单元（批次）状态表
export const importTaskBatches = pgTable("import_task_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => importTasks.id, { onDelete: "cascade" }),
  unitId: varchar("unit_id", { length: 64 }).notNull(), // task_id + batch_index 组合的稳定标识
  batchIndex: integer("batch_index").notNull(),
  startRow: integer("start_row").notNull(),
  endRow: integer("end_row").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("PENDING"), // PENDING/PROCESSING/COMPLETED/FAILED
  retryCount: integer("retry_count").notNull().default(0),
  lockedAt: timestamp("locked_at"),
  processedRows: integer("processed_rows").notNull().default(0),
  successRows: integer("success_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
}, (t) => [
  uniqueIndex("import_task_batches_task_unit_uniq").on(t.taskId, t.unitId),
  index("import_task_batches_task_status_idx").on(t.taskId, t.status),
]);

// 行级错误明细
export const importTaskErrors = pgTable("import_task_errors", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => importTasks.id, { onDelete: "cascade" }),
  unitId: varchar("unit_id", { length: 64 }).notNull(),
  batchIndex: integer("batch_index").notNull(),
  rowNumber: integer("row_number").notNull(),
  fieldName: varchar("field_name", { length: 100 }).notNull(),
  rawValue: text("raw_value"),
  errorCode: varchar("error_code", { length: 20 }).notNull(),
  errorReason: text("error_reason").notNull(),
  traceId: varchar("trace_id", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("import_task_errors_task_unit_idx").on(t.taskId, t.unitId),
  index("import_task_errors_error_code_idx").on(t.errorCode),
  index("import_task_errors_task_row_idx").on(t.taskId, t.rowNumber),
]);

// 本地可靠事件表（Outbox 模式）
export const eventOutbox = pgTable("event_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  aggregateId: varchar("aggregate_id", { length: 64 }).notNull(), // task_id
  eventType: varchar("event_type", { length: 64 }).notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  traceId: varchar("trace_id", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("PENDING"), // PENDING/SENT/FAILED
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  sentAt: timestamp("sent_at"),
}, (t) => [
  index("event_outbox_status_next_retry_idx").on(t.status, t.nextRetryAt),
  index("event_outbox_aggregate_idx").on(t.aggregateId),
]);

// 处理单元性能日志
export const batchPerformanceLog = pgTable("batch_performance_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull(),
  unitId: varchar("unit_id", { length: 64 }).notNull(),
  batchIndex: integer("batch_index").notNull(),
  parseDurationMs: integer("parse_duration_ms").notNull().default(0),
  ruleDurationMs: integer("rule_duration_ms").notNull().default(0),
  validateDurationMs: integer("validate_duration_ms").notNull().default(0),
  insertDurationMs: integer("insert_duration_ms").notNull().default(0),
  totalDurationMs: integer("total_duration_ms").notNull().default(0),
  rowCount: integer("row_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  status: varchar("status", { length: 32 }).notNull(),
  traceId: varchar("trace_id", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("batch_performance_log_task_unit_idx").on(t.taskId, t.unitId),
  index("batch_performance_log_created_idx").on(t.createdAt),
]);

// 链路时间线事件
export const traceEvents = pgTable("trace_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  traceId: varchar("trace_id", { length: 64 }).notNull(),
  taskId: uuid("task_id"),
  unitId: varchar("unit_id", { length: 64 }),
  eventName: varchar("event_name", { length: 64 }).notNull(),
  eventStatus: varchar("event_status", { length: 32 }),
  message: text("message"),
  occurredAt: timestamp("occurred_at").defaultNow(),
}, (t) => [
  index("trace_events_trace_occurred_idx").on(t.traceId, t.occurredAt),
  index("trace_events_task_idx").on(t.taskId),
]);

// 解析结果分批存储（上传时解析一次，worker 只读切片，避免重复解析原文件）
// 每批的 OrderRow[] 以 JSONB 存储，worker 按 (task_id, batch_index) 读取对应批次
export const importTaskRows = pgTable("import_task_rows", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => importTasks.id, { onDelete: "cascade" }),
  batchIndex: integer("batch_index").notNull(),
  startRow: integer("start_row").notNull(),
  endRow: integer("end_row").notNull(),
  rows: jsonb("rows").notNull(), // OrderRow[] 的 JSONB
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("import_task_rows_task_batch_uniq").on(t.taskId, t.batchIndex),
]);
