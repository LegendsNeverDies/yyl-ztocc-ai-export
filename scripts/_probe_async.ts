/**
 * 探测异步链路数据库状态：检查所有新表是否存在 + 各表数据量
 * 运行：npx tsx scripts/_probe_async.ts
 */
import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);

const REQUIRED_TABLES = [
  "parse_rules",
  "shipments",
  "orders",
  "sku_master",
  "import_tasks",
  "import_task_batches",
  "import_task_errors",
  "event_outbox",
  "batch_performance_log",
  "trace_events",
];

async function main() {
  console.log("=== 异步链路数据库探测 ===\n");

  // 1. 检查所有表是否存在（表名列表拼进 IN，因为是固定白名单，安全）
  const inList = REQUIRED_TABLES.map((t) => `'${t}'`).join(",");
  const tableRows = await sql.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${inList})`
  );
  const existing = new Set(tableRows.map((r: any) => r.table_name));
  console.log("【表存在性检查】");
  for (const t of REQUIRED_TABLES) {
    console.log(`  ${existing.has(t) ? "✅" : "❌"} ${t}`);
  }

  const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));
  if (missing.length > 0) {
    console.log(`\n⚠️  缺失 ${missing.length} 张表：${missing.join(", ")}`);
    console.log("   需运行：npm run db:create-tables");
    return;
  }

  // 2. 各表数据量（表名是白名单，直接拼接）
  console.log("\n【数据量检查】");
  const counts: Array<[string, string]> = [
    ["parse_rules", "解析规则"],
    ["sku_master", "SKU主数据(目标≥20000)"],
    ["shipments", "运单主表"],
    ["orders", "运单明细"],
    ["import_tasks", "导入任务"],
    ["import_task_batches", "处理批次"],
    ["event_outbox", "Outbox事件"],
    ["batch_performance_log", "性能日志"],
    ["trace_events", "Trace事件"],
  ];

  for (const [table, label] of counts) {
    try {
      const r = await sql.query(`SELECT count(*)::int AS c FROM ${table}`);
      console.log(`  ${label}: ${r[0].c} 行`);
    } catch (e) {
      console.log(`  ${label}: 查询失败 - ${(e as Error).message}`);
    }
  }

  // 3. SKU 主数据抽样
  const skuSample = await sql`SELECT sku_code, name FROM sku_master ORDER BY sku_code LIMIT 3`;
  console.log("\n【SKU 主数据抽样】");
  if (skuSample.length === 0) {
    console.log("  ⚠️ sku_master 为空，需运行：npm run db:seed-data");
  } else {
    for (const r of skuSample) console.log(`  ${r.sku_code} | ${r.name}`);
  }

  // 4. 解析规则抽样
  const ruleSample = await sql`SELECT name FROM parse_rules LIMIT 5`;
  console.log("\n【解析规则抽样】");
  if (ruleSample.length === 0) {
    console.log("  ⚠️ parse_rules 为空，需运行：npm run db:seed");
  } else {
    for (const r of ruleSample) console.log(`  - ${r.name}`);
  }

  console.log("\n=== 探测完成 ===");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌ 探测失败:", e);
  process.exit(1);
});
