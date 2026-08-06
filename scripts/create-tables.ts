/**
 * 创建/更新 V2 所有数据库表（含新增的异步导入链路表）
 * 直接使用原生 DDL，避免 drizzle-kit push 的交互式挂起
 * 运行：npx tsx scripts/create-tables.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const DDL: string[] = [
  // 已有表（CREATE IF NOT EXISTS，幂等）
  `CREATE TABLE IF NOT EXISTS parse_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(255) NOT NULL,
    description text,
    config jsonb NOT NULL,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS shipments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_code varchar(255),
    store_name varchar(255),
    receiver_name varchar(255),
    receiver_phone varchar(50),
    receiver_address text,
    remark text,
    sku_count integer NOT NULL DEFAULT 0,
    total_quantity numeric NOT NULL DEFAULT '0',
    batch_id uuid NOT NULL,
    submitted_at timestamp DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    sku_code varchar(255) NOT NULL,
    sku_name varchar(500) NOT NULL,
    sku_quantity numeric NOT NULL,
    sku_spec varchar(500),
    remark text
  )`,

  // ====== 新增表 ======
  `CREATE TABLE IF NOT EXISTS sku_master (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sku_code varchar(255) NOT NULL,
    name varchar(500) NOT NULL,
    spec varchar(500),
    unit varchar(50),
    created_at timestamp DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS import_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id varchar(64) NOT NULL,
    file_name varchar(500) NOT NULL,
    rule_id uuid NOT NULL,
    file_data jsonb NOT NULL,
    file_type varchar(20) NOT NULL,
    status varchar(32) NOT NULL DEFAULT 'PENDING',
    total_rows integer NOT NULL DEFAULT 0,
    processed_rows integer NOT NULL DEFAULT 0,
    success_rows integer NOT NULL DEFAULT 0,
    failed_rows integer NOT NULL DEFAULT 0,
    total_batches integer NOT NULL DEFAULT 0,
    completed_batches integer NOT NULL DEFAULT 0,
    degraded boolean NOT NULL DEFAULT false,
    degraded_reason text,
    error_message text,
    batch_size integer NOT NULL DEFAULT 1000,
    created_at timestamp DEFAULT now(),
    started_at timestamp,
    completed_at timestamp
  )`,

  `CREATE TABLE IF NOT EXISTS import_task_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES import_tasks(id) ON DELETE CASCADE,
    unit_id varchar(64) NOT NULL,
    batch_index integer NOT NULL,
    start_row integer NOT NULL,
    end_row integer NOT NULL,
    status varchar(32) NOT NULL DEFAULT 'PENDING',
    retry_count integer NOT NULL DEFAULT 0,
    locked_at timestamp,
    processed_rows integer NOT NULL DEFAULT 0,
    success_rows integer NOT NULL DEFAULT 0,
    failed_rows integer NOT NULL DEFAULT 0,
    error_message text,
    created_at timestamp DEFAULT now(),
    completed_at timestamp
  )`,

  `CREATE TABLE IF NOT EXISTS import_task_errors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES import_tasks(id) ON DELETE CASCADE,
    unit_id varchar(64) NOT NULL,
    batch_index integer NOT NULL,
    row_number integer NOT NULL,
    field_name varchar(100) NOT NULL,
    raw_value text,
    error_code varchar(20) NOT NULL,
    error_reason text NOT NULL,
    trace_id varchar(64) NOT NULL,
    created_at timestamp DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS event_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id varchar(64) NOT NULL,
    event_type varchar(64) NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    trace_id varchar(64) NOT NULL,
    payload jsonb NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'PENDING',
    retry_count integer NOT NULL DEFAULT 0,
    next_retry_at timestamp DEFAULT now(),
    created_at timestamp DEFAULT now(),
    sent_at timestamp
  )`,

  `CREATE TABLE IF NOT EXISTS batch_performance_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL,
    unit_id varchar(64) NOT NULL,
    batch_index integer NOT NULL,
    parse_duration_ms integer NOT NULL DEFAULT 0,
    rule_duration_ms integer NOT NULL DEFAULT 0,
    validate_duration_ms integer NOT NULL DEFAULT 0,
    insert_duration_ms integer NOT NULL DEFAULT 0,
    total_duration_ms integer NOT NULL DEFAULT 0,
    row_count integer NOT NULL DEFAULT 0,
    success_count integer NOT NULL DEFAULT 0,
    failed_count integer NOT NULL DEFAULT 0,
    status varchar(32) NOT NULL,
    trace_id varchar(64) NOT NULL,
    created_at timestamp DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS trace_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id varchar(64) NOT NULL,
    task_id uuid,
    unit_id varchar(64),
    event_name varchar(64) NOT NULL,
    event_status varchar(32),
    message text,
    occurred_at timestamp DEFAULT now()
  )`,

  // 解析结果分批存储（上传时解析一次，worker 只读切片）
  `CREATE TABLE IF NOT EXISTS import_task_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES import_tasks(id) ON DELETE CASCADE,
    batch_index integer NOT NULL,
    start_row integer NOT NULL,
    end_row integer NOT NULL,
    rows jsonb NOT NULL,
    created_at timestamp DEFAULT now()
  )`,
];

// 索引（CREATE INDEX IF NOT EXISTS，幂等）
const INDEXES: string[] = [
  // 幂等：external_code 非空时唯一（部分唯一索引，匹配 ON CONFLICT ... WHERE external_code IS NOT NULL）
  // 先 drop 旧普通索引（若存在），再建部分唯一索引；IF NOT EXISTS 不会升级已有普通索引
  `DROP INDEX IF EXISTS shipments_external_code_idx`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shipments_external_code_uniq ON shipments(external_code) WHERE external_code IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS shipments_batch_id_idx ON shipments(batch_id)`,
  `CREATE INDEX IF NOT EXISTS orders_shipment_id_idx ON orders(shipment_id)`,
  `CREATE INDEX IF NOT EXISTS orders_sku_code_idx ON orders(sku_code)`,
  // 幂等唯一索引：同一出库单内同一 SKU 不重复（UNNEST + ON CONFLICT 用）
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_shipment_sku ON orders(shipment_id, sku_code)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS sku_master_sku_code_uniq ON sku_master(sku_code)`,

  `CREATE INDEX IF NOT EXISTS import_tasks_status_created_idx ON import_tasks(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS import_tasks_trace_id_idx ON import_tasks(trace_id)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS import_task_batches_task_unit_uniq ON import_task_batches(task_id, unit_id)`,
  `CREATE INDEX IF NOT EXISTS import_task_batches_task_status_idx ON import_task_batches(task_id, status)`,

  `CREATE INDEX IF NOT EXISTS import_task_errors_task_unit_idx ON import_task_errors(task_id, unit_id)`,
  `CREATE INDEX IF NOT EXISTS import_task_errors_error_code_idx ON import_task_errors(error_code)`,
  `CREATE INDEX IF NOT EXISTS import_task_errors_task_row_idx ON import_task_errors(task_id, row_number)`,

  `CREATE INDEX IF NOT EXISTS event_outbox_status_next_retry_idx ON event_outbox(status, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS event_outbox_aggregate_idx ON event_outbox(aggregate_id)`,

  `CREATE INDEX IF NOT EXISTS batch_performance_log_task_unit_idx ON batch_performance_log(task_id, unit_id)`,
  `CREATE INDEX IF NOT EXISTS batch_performance_log_created_idx ON batch_performance_log(created_at)`,

  `CREATE INDEX IF NOT EXISTS trace_events_trace_occurred_idx ON trace_events(trace_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS trace_events_task_idx ON trace_events(task_id)`,

  // import_task_rows 索引
  `CREATE UNIQUE INDEX IF NOT EXISTS import_task_rows_task_batch_uniq ON import_task_rows(task_id, batch_index)`,
];

async function main() {
  console.log("🔧 开始创建/更新数据库表...");
  for (const stmt of DDL) {
    await sql.query(stmt);
  }
  console.log(`✅ 已创建 ${DDL.length} 张表`);

  console.log("🔧 开始创建索引...");
  for (const stmt of INDEXES) {
    await sql.query(stmt);
  }
  console.log(`✅ 已创建 ${INDEXES.length} 个索引`);

  console.log("\n全部完成。");
}

main().catch((e) => {
  console.error("❌ 失败：", e);
  process.exit(1);
});
