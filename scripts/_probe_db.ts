import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ 未找到 DATABASE_URL，请检查 .env.local");
  process.exit(1);
}

// 隐藏密码后打印连接信息
const safe = url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
console.log("连接串：", safe);

const sql = neon(url);

// 整体超时保护：15 秒连不上就判定失败
const guard = new Promise<never>((_, rej) =>
  setTimeout(() => rej(new Error("连接超时（15s），请检查网络/地址/密码")), 15000)
);

async function main() {
  const t0 = Date.now();
  const r = await sql`SELECT 1 AS ok`;
  console.log("✅ 连通性 SELECT 1 成功：", r);

  const info = await sql`SELECT current_database() AS db, version() AS ver`;
  console.log("数据库：", info[0].db);
  console.log("版本：", (info[0].ver as string).split("\n")[0]);

  const ms = Date.now() - t0;
  console.log(`✅ 连接正常，耗时 ${ms} ms`);
}

Promise.race([main(), guard]).catch((e) => {
  console.error("❌ 连接失败：", e?.message || e);
  process.exit(1);
});
