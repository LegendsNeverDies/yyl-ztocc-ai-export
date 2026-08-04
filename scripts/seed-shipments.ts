/**
 * V2 示例运单数据 —— 供 V3 通过接口校验/查询使用
 * 生成 10 条运单（WB10001-WB10010），每条带 2-3 个 SKU 明细
 * 运行：npx tsx scripts/seed-shipments.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

interface DemoShipment {
  code: string;
  store: string;
  name: string;
  phone: string;
  addr: string;
  skus: { code: string; name: string; qty: number; spec: string }[];
}

const SHIPMENTS: DemoShipment[] = [
  { code: "WB10001", store: "海口龙湖天街店", name: "张三", phone: "13800000001", addr: "海口市龙华区龙湖天街1号", skus: [{ code: "SKU1001", name: "矿泉水550ml", qty: 100, spec: "箱" }, { code: "SKU1002", name: "可乐330ml", qty: 50, spec: "箱" }] },
  { code: "WB10002", store: "三亚海棠湾店", name: "李四", phone: "13800000002", addr: "三亚市海棠湾路88号", skus: [{ code: "SKU1003", name: "薯片原味", qty: 80, spec: "箱" }, { code: "SKU1004", name: "巧克力礼盒", qty: 30, spec: "盒" }] },
  { code: "WB10003", store: "琼海嘉积店", name: "王五", phone: "13800000003", addr: "琼海市嘉积镇人民路", skus: [{ code: "SKU1005", name: "洗衣液2L", qty: 60, spec: "瓶" }, { code: "SKU1006", name: "纸巾抽纸", qty: 200, spec: "提" }, { code: "SKU1007", name: "洗发水500ml", qty: 40, spec: "瓶" }] },
  { code: "WB10004", store: "儋州那大店", name: "赵六", phone: "13800000004", addr: "儋州市那大镇中兴大街", skus: [{ code: "SKU1008", name: "方便面整箱", qty: 120, spec: "箱" }, { code: "SKU1009", name: "火腿肠", qty: 90, spec: "包" }] },
  { code: "WB10005", store: "文昌清澜店", name: "孙七", phone: "13800000005", addr: "文昌市清澜开发区", skus: [{ code: "SKU1010", name: "花生油5L", qty: 25, spec: "桶" }, { code: "SKU1011", name: "大米10kg", qty: 70, spec: "袋" }] },
  { code: "WB10006", store: "万宁兴隆店", name: "周八", phone: "13800000006", addr: "万宁兴隆温泉旅游区", skus: [{ code: "SKU1012", name: "咖啡豆250g", qty: 150, spec: "袋" }, { code: "SKU1013", name: "椰子糖", qty: 300, spec: "包" }] },
  { code: "WB10007", store: "东方八所店", name: "吴九", phone: "13800000007", addr: "东方市八所镇东海路", skus: [{ code: "SKU1014", name: "防晒霜SPF50", qty: 45, spec: "瓶" }, { code: "SKU1015", name: "墨镜", qty: 20, spec: "副" }] },
  { code: "WB10008", store: "五指山店", name: "郑十", phone: "13800000008", addr: "五指山市三月三大道", skus: [{ code: "SKU1016", name: "登山杖", qty: 15, spec: "根" }, { code: "SKU1017", name: "运动饮料", qty: 180, spec: "瓶" }] },
  { code: "WB10009", store: "陵水英州店", name: "钱十一", phone: "13800000009", addr: "陵水县英州镇", skus: [{ code: "SKU1018", name: "海鲜酱", qty: 110, spec: "瓶" }, { code: "SKU1019", name: "速溶咖啡", qty: 75, spec: "盒" }] },
  { code: "WB10010", store: "保亭店", name: "冯十二", phone: "13800000010", addr: "保亭县保城镇", skus: [{ code: "SKU1020", name: "热带水果干", qty: 95, spec: "袋" }, { code: "SKU1021", name: "椰子粉", qty: 130, spec: "袋" }] },
];

async function main() {
  console.log(`正在生成 ${SHIPMENTS.length} 条示例运单...`);
  // 先清理同 code 旧数据（cascade 删 orders）
  for (const s of SHIPMENTS) {
    await sql`DELETE FROM shipments WHERE external_code = ${s.code}`;
  }

  for (const s of SHIPMENTS) {
    const batchId = crypto.randomUUID();
    const totalQty = s.skus.reduce((a, b) => a + b.qty, 0);
    const rows = await sql`
      INSERT INTO shipments (external_code, store_name, receiver_name, receiver_phone, receiver_address, sku_count, total_quantity, batch_id, submitted_at)
      VALUES (${s.code}, ${s.store}, ${s.name}, ${s.phone}, ${s.addr}, ${s.skus.length}, ${totalQty.toString()}, ${batchId}, now())
      RETURNING id
    `;
    const sid = rows[0].id as string;
    for (const sk of s.skus) {
      await sql`
        INSERT INTO orders (shipment_id, sku_code, sku_name, sku_quantity, sku_spec)
        VALUES (${sid}, ${sk.code}, ${sk.name}, ${sk.qty.toString()}, ${sk.spec})
      `;
    }
  }
  console.log(`✅ 完成：${SHIPMENTS.length} 条运单 + ${SHIPMENTS.reduce((a, s) => a + s.skus.length, 0)} 条 SKU 明细`);
  console.log("   运单号：WB10001-WB10010，可供 V3 上报/扫描校验使用");
}

main().catch((e) => { console.error("❌ 失败：", e); process.exit(1); });
