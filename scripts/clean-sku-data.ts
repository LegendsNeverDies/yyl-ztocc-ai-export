/**
 * 清理压测数据脚本
 *
 * 默认只清空 sku_master 表（压测 SKU 主数据），重置自增序列。
 * 加 --all 同时清理压测产生的运单与异步任务链路数据：
 *   - import_task_errors / import_task_batches / import_tasks
 *   - batch_performance_log / trace_events / event_outbox
 *   - orders / shipments
 *   - sku_master
 *
 * 运行：
 *   npx tsx scripts/clean-sku-data.ts          # 仅清 SKU 主数据
 *   npx tsx scripts/clean-sku-data.ts --all    # 清理全部压测数据
 *
 * 说明：sku_master 无外键被引用，可安全 TRUNCATE；
 *       其余表按外键依赖顺序删除，RESTART IDENTITY 重置序列。
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

// 仅清理 SKU 主数据
const SKU_ONLY_TABLES = ["sku_master"];

// 全量清理：按外键依赖顺序（子表先于父表）
const ALL_TABLES = [
  "import_task_errors",
  "import_task_batches",
  "batch_performance_log",
  "trace_events",
  "event_outbox",
  "import_tasks",
  "orders",
  "shipments",
  "sku_master",
];

async function countRows(table: string): Promise<number> {
  const rows = await sql`SELECT COUNT(*)::int AS cnt FROM ${sql(table)}`;
  return rows[0]?.cnt ?? 0;
}

async function main() {
  const cleanAll = process.argv.includes("--all");
  const tables = cleanAll ? ALL_TABLES : SKU_ONLY_TABLES;

  console.log("=========================================");
  console.log("  V2 压测数据清理");
  console.log(`  模式：${cleanAll ? "全量清理（--all）" : "仅清理 SKU 主数据"}`);
  console.log("=========================================\n");

  // 先统计各表行数
  console.log("清理前各表行数：");
  for (const t of tables) {
    const cnt = await countRows(t);
    console.log(`  ${t.padEnd(28)} ${cnt}`);
  }
  console.log("");

  // 逐表 TRUNCATE（含 RESTART IDENTITY 重置自增序列）
  // 注意：orders → shipments 有 FK，TRUNCATE 时加 CASCADE 更稳妥
  for (const t of tables) {
    console.log(`  清理 ${t} ...`);
    await sql`TRUNCATE TABLE ${sql(t)} RESTART IDENTITY CASCADE`;
  }

  console.log("\n✅ 清理完成");

  // 清理后复核
  console.log("\n清理后各表行数：");
  for (const t of tables) {
    const cnt = await countRows(t);
    console.log(`  ${t.padEnd(28)} ${cnt}`);
  }

  console.log("\n下一步：");
  if (cleanAll) {
    console.log("  1. 重建压测数据：npm run db:seed-data");
    console.log("  2. 重新压测：npm run benchmark");
  } else {
    console.log("  1. 重新灌入 SKU 主数据：npm run db:seed-data");
  }
}

main().catch((e) => {
  console.error("❌ 失败：", e);
  process.exit(1);
});
