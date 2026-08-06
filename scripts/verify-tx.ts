/**
 * 验证真事务支持（最小化，不依赖 server-only 模块）
 * 运行：npx tsx scripts/verify-tx.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { Pool } from "@neondatabase/serverless";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  console.log("=== 真事务验证 ===\n");

  // 测试 1: COMMIT
  const t1 = `tx_verify_${Date.now()}`;
  await tx(async (c) => {
    await c.query(`INSERT INTO trace_events (trace_id, event_name, message) VALUES ($1,$2,$3)`, [t1, "T", "commit"]);
  });
  const r1 = await pool.query(`SELECT count(*)::int FROM trace_events WHERE trace_id=$1`, [t1]);
  console.log(`COMMIT count=${r1.rows[0].count} (预期 1)`);

  // 测试 2: ROLLBACK
  try {
    await tx(async (c) => {
      await c.query(`INSERT INTO trace_events (trace_id, event_name, message) VALUES ($1,$2,$3)`, [t1, "T", "rollback"]);
      throw new Error("INTENTIONAL");
    });
  } catch {}
  const r2 = await pool.query(`SELECT count(*)::int FROM trace_events WHERE trace_id=$1`, [t1]);
  console.log(`ROLLBACK count=${r2.rows[0].count} (预期仍 1)`);

  // 清理
  await pool.query(`DELETE FROM trace_events WHERE trace_id=$1`, [t1]);

  if (r1.rows[0].count === 1 && r2.rows[0].count === 1) {
    console.log("\n✅ 真事务生效！BEGIN/COMMIT/ROLLBACK 正常工作。");
    console.log("   Outbox 同事务原子写入要求已满足。");
  } else {
    console.log("\n❌ 事务未生效！");
    process.exit(1);
  }

  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
