import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

let _sql: ReturnType<typeof neon> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function ensureInit() {
	if (!_sql) {
		const DATABASE_URL = process.env.DATABASE_URL;
		if (!DATABASE_URL) {
			throw new Error("DATABASE_URL 未配置，请在环境变量中设置 DATABASE_URL");
		}
		_sql = neon(DATABASE_URL);
		_db = drizzle({ client: _sql });
	}
}

export function getSql() {
	ensureInit();
	return _sql as ReturnType<typeof neon>;
}

export function getDb() {
	ensureInit();
	return _db as ReturnType<typeof drizzle>;
}

// 兼容旧导入：继续导出 `db` 和 `sql`，但延迟初始化。
// 这样现有代码 `import { db, sql } from "@/lib/db"` 无需修改。
export const sql = new Proxy({} as ReturnType<typeof neon>, {
	get(_, prop) {
		ensureInit();
		return (_sql as any)[prop as any];
	},
	apply(_, thisArg, args) {
		ensureInit();
		return (_sql as any).apply(thisArg, args);
	},
}) as ReturnType<typeof neon>;

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
	get(_, prop) {
		ensureInit();
		const v = (_db as any)[prop as any];
		if (typeof v === "function") return v.bind(_db);
		return v;
	},
	apply(_, thisArg, args) {
		ensureInit();
		return (_db as any).apply(thisArg, args);
	},
}) as ReturnType<typeof drizzle>;
