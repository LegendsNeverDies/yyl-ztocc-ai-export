import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  try {
    const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('shipments','parse_rules','orders')`;
    console.log("V2 tables present:", t.map((r:any)=>r.table_name).join(", ") || "NONE");
  } catch (e) { console.error("table check failed:", (e as Error).message); }
  try {
    const c = await sql`SELECT count(*)::int AS c FROM shipments`;
    console.log("shipments rows:", c[0].c);
    if (c[0].c > 0) {
      const s = await sql`SELECT external_code FROM shipments ORDER BY external_code LIMIT 5`;
      console.log("sample codes:", s.map((r:any)=>r.external_code).join(", "));
    }
  } catch (e) { console.error("shipments query failed:", (e as Error).message); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
