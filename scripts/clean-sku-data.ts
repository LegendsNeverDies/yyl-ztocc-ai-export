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
  // 表名为脚本内硬编码常量，无注入风险；neon 的 sql 仅支持 tagged template，
  // 动态表名需用 sql.query 执行原生 SQL。
  const rows = await sql.query(`SELECT COUNT(*)::int AS cnt FROM ${table}`);
  return rows[0]?.cnt ?? 0;
}

async function main() {
  // 支持三种触发方式（任一即可）：
  //   1. npm run db:clean-all            （package.json 里已写死 --all）
  //   2. npm run db:clean-sku -- --all   （常规透传）
  //   3. CLEAN_ALL=1 npx tsx scripts/clean-sku-data.ts
  // 注：Windows + PowerShell 下 npx 对 "--" 后参数的透传不稳定，
  //     推荐直接用 npm run db:clean-all。
  const cleanAll =
    process.argv.includes("--all") ||
    process.env.CLEAN_ALL === "1" ||
    process.env.CLEAN_ALL === "true";
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
    await sql.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
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
