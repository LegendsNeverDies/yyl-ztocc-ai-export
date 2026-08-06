/**
 * 把 test-data/bench-rule.json 导入 parse_rules 表（upsert by name）
 * 运行：npx tsx scripts/_import-bench-rule.ts
 */
import fs from "fs";
import * as path from "path";
const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const ruleFile = path.resolve(process.cwd(), "test-data/bench-rule.json");
  if (!fs.existsSync(ruleFile)) {
    throw new Error("未找到 test-data/bench-rule.json，请先运行 npm run db:seed-data");
  }
  const rule = JSON.parse(fs.readFileSync(ruleFile, "utf-8"));
  console.log(`导入规则：${rule.name}`);

  // 检查是否已存在同名规则
  const existing = await sql`SELECT id FROM parse_rules WHERE name = ${rule.name} LIMIT 1`;

  // config = 除了 name/description 之外的全部字段
  const { name, description, ...config } = rule;

  if (existing.length > 0) {
    // 更新
    await sql`
      UPDATE parse_rules
      SET description = ${description}, config = ${config}, updated_at = now()
      WHERE name = ${name}
    `;
    console.log(`✅ 已更新规则（id=${existing[0].id}）`);
  } else {
    // 插入
    await sql`
      INSERT INTO parse_rules (name, description, config)
      VALUES (${name}, ${description}, ${config})
    `;
    console.log("✅ 已插入新规则");
  }

  // 返回规则 ID
  const row = await sql`SELECT id, name FROM parse_rules WHERE name = ${rule.name}`;
  console.log(`\n规则 ID: ${row[0].id}`);
  console.log(`\n压测时使用：`);
  console.log(`  BENCH_RULE_ID=${row[0].id} npx tsx scripts/benchmark.ts`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌ 失败:", e);
  process.exit(1);
});
