import { Pool, neon, types } from "@neondatabase/serverless";
import type { PoolClient } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

// bigint → number（COUNT(*) 在 pg 中是 bigint，drizzle 默认返回字符串）
types.setTypeParser(types.builtins.INT8, (val: string) => (val === null ? null : Number(val)));

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function ensureInit() {
  if (_db) return;
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL 未配置，请在环境变量中设置 DATABASE_URL");
  }

  // 使用 neon-serverless 的 Pool（基于 WebSocket），支持真事务（BEGIN/COMMIT/ROLLBACK）。
  // 这是与旧 neon-http 驱动的核心区别：HTTP 驱动无状态，不支持事务；
  // Pool 基于 WebSocket 长连接，可在 Vercel Serverless 上跑真事务。
  // 注意：连接串需使用 Neon 的 pooler host（带 -pooler 的那个），否则无法建立 WebSocket。
  _pool = new Pool({ connectionString: DATABASE_URL });
  _db = drizzle({ client: _pool });
}

/** 获取 drizzle 实例（支持 transaction） */
export function getDb() {
  ensureInit();
  return _db as ReturnType<typeof drizzle>;
}

/** 获取原始 Pool（供需要原生 SQL 的场景使用，如 UNNEST UPSERT） */
export function getPool() {
  ensureInit();
  return _pool as Pool;
}

/**
 * 执行原生 SQL 参数化查询，返回行数组。
 * 用于 UNNEST 批量写入等 drizzle 不便表达的场景。
 */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  ensureInit();
  const res = await (_pool as Pool).query(text, params as unknown[]);
  return { rows: res.rows as T[], rowCount: res.rowCount };
}

/**
 * 在一个真实数据库事务内执行 fn（BEGIN/COMMIT/ROLLBACK）。
 * 用于 Outbox 模式：任务 + 批次 + outbox 必须同事务原子写入。
 */
export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  ensureInit();
  const client = await (_pool as Pool).connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 兼容旧导入：继续导出 `db` 和 `sql`，但延迟初始化。
// 现有代码 `import { db, sql } from "@/lib/db"` 无需修改。
// 注意：`sql` 标签函数在 neon-serverless 下不再使用（改用 query()），
// 但保留导出以兼容可能存在的旧调用点。
export const sql = new Proxy({} as ReturnType<typeof neon>, {
  get(_, prop) {
    ensureInit();
    return (_pool as any)[prop as any];
  },
}) as unknown as ReturnType<typeof neon>;

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_, prop) {
    ensureInit();
    const v = (_db as any)[prop as any];
    if (typeof v === "function") return v.bind(_db);
    return v;
  },
}) as ReturnType<typeof drizzle>;
