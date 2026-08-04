/**
 * 压测数据准备脚本：
 * 1. 清空并重建 sku_master 表数据，灌入 20,000 条 SKU 主数据
 * 2. 生成 10,000 行 Excel 压测文件 test-data/10000-orders.xlsx
 *    其中故意混入少量非法 SKU（约 1%）用于验证错误定位能力
 *
 * 运行：npx tsx scripts/seed-data.ts
 * 可重复执行：每次先 TRUNCATE sku_master，再重新生成
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

const sql = neon(process.env.DATABASE_URL!);

const SKU_COUNT = 20000;
const ORDER_COUNT = 10000;
const INVALID_SKU_RATIO = 0.01; // 1% 非法 SKU

// 商品名称素材池
const BRANDS = ["农夫山泉", "可口可乐", "康师傅", "统一", "娃哈哈", "百事", "蒙牛", "伊利", "盼盼", "达利园", "王老吉", "加多宝", "六神", "海天", "太太乐", "金龙鱼", "福临门", "鲁花", "洁柔", "清风"];
const CATEGORIES = ["矿泉水", "可乐", "方便面", "薯片", "饼干", "牛奶", "酸奶", "巧克力", "果汁", "茶饮", "洗发水", "沐浴露", "洗衣液", "纸巾", "大米", "食用油", "酱油", "醋", "牙膏", "毛巾"];
const SPECS = ["500ml", "330ml", "550ml", "1L", "2L", "5L", "100g", "200g", "500g", "1kg", "5kg", "10kg", "箱", "包", "瓶", "袋", "盒", "桶", "提", "副"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seedSkuMaster() {
  console.log(`🔧 开始清理并灌入 ${SKU_COUNT} 条 SKU 主数据...`);
  await sql`TRUNCATE TABLE sku_master RESTART IDENTITY`;

  const BATCH = 1000;
  const allCodes: string[] = [];
  for (let i = 0; i < SKU_COUNT; i++) {
    allCodes.push(`SKU_${String(i + 1).padStart(5, "0")}`);
  }

  for (let i = 0; i < allCodes.length; i += BATCH) {
    const chunk = allCodes.slice(i, i + BATCH);
    // chunk 内参数从 1 开始
    const chunkParams: unknown[] = [];
    chunk.forEach((code) => {
      const name = `${pick(BRANDS)}${pick(CATEGORIES)}`;
      const spec = pick(SPECS);
      const unit = pick(["瓶", "箱", "包", "袋", "盒", "桶", "提", "副"]);
      chunkParams.push(code, name, spec, unit);
    });
    const placeholders = chunk.map((_, idx) => `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`).join(", ");
    await sql.query(
      `INSERT INTO sku_master (sku_code, name, spec, unit) VALUES ${placeholders}`,
      chunkParams
    );
    process.stdout.write(`\r  已写入 ${Math.min(i + BATCH, SKU_COUNT)}/${SKU_COUNT}`);
  }
  console.log("\n✅ SKU 主数据灌入完成");
  return allCodes;
}

function generateOrdersExcel(validSkuCodes: string[]) {
  console.log(`\n📦 开始生成 ${ORDER_COUNT} 行 Excel 压测文件...`);

  const invalidCount = Math.floor(ORDER_COUNT * INVALID_SKU_RATIO);
  const validCount = ORDER_COUNT - invalidCount;

  // 门店与收货人池
  const STORES = ["海口龙湖天街店", "三亚海棠湾店", "琼海嘉积店", "儋州那大店", "文昌清澜店", "万宁兴隆店", "东方八所店", "五指山店", "陵水英州店", "保亭店"];
  const NAMES = ["张三", "李四", "王五", "赵六", "孙七", "周八", "吴九", "郑十", "钱十一", "冯十二"];
  const CITIES = ["海口市", "三亚市", "琼海市", "儋州市", "文昌市", "万宁市", "东方市", "五指山市", "陵水县", "保亭县"];

  const rows: (string | number)[][] = [];
  // 表头
  rows.push(["外部编码", "收货门店", "收件人", "收件电话", "收件地址", "SKU编码", "SKU名称", "数量", "规格"]);

  // 先生成有效的 SKU 行
  // SKU 名称池：用主数据随机抽样
  const skuNameMap = new Map<string, string>();
  // 简化：为每个被抽中的 SKU 生成一个名字
  for (let i = 0; i < ORDER_COUNT; i++) {
    const code = pick(validSkuCodes);
    if (!skuNameMap.has(code)) {
      skuNameMap.set(code, `${pick(BRANDS)}${pick(CATEGORIES)}`);
    }
  }

  const allRows: {
    externalCode: string;
    store: string;
    name: string;
    phone: string;
    addr: string;
    skuCode: string;
    skuName: string;
    qty: number;
    spec: string;
    isValid: boolean;
  }[] = [];

  for (let i = 0; i < ORDER_COUNT; i++) {
    const isValid = i >= invalidCount; // 最后 invalidCount 行为非法
    const skuCode = isValid
      ? pick(validSkuCodes)
      : `INVALID_${String(i).padStart(5, "0")}`; // 故意构造不存在的 SKU
    const skuName = isValid ? (skuNameMap.get(skuCode) || `${pick(BRANDS)}${pick(CATEGORIES)}`) : `未知商品${i}`;
    const storeIdx = randomInt(0, STORES.length - 1);
    allRows.push({
      externalCode: `WB${String(10000 + i).padStart(5, "0")}`,
      store: STORES[storeIdx],
      name: NAMES[storeIdx % NAMES.length],
      phone: `138${String(randomInt(10000000, 99999999)).padStart(8, "0")}`,
      addr: `${CITIES[storeIdx]}${pick(["人民路", "解放路", "中山路", "建国路", "和平路"])}${randomInt(1, 200)}号`,
      skuCode,
      skuName,
      qty: randomInt(1, 500),
      spec: pick(SPECS),
      isValid,
    });
  }

  // 打乱顺序，让非法行分散
  for (let i = allRows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allRows[i], allRows[j]] = [allRows[j], allRows[i]];
  }

  for (const r of allRows) {
    rows.push([r.externalCode, r.store, r.name, r.phone, r.addr, r.skuCode, r.skuName, r.qty, r.spec]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");

  const outDir = path.resolve(process.cwd(), "test-data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "10000-orders.xlsx");
  XLSX.writeFile(wb, outFile);

  const stat = fs.statSync(outFile);
  console.log(`✅ Excel 压测文件生成完成：${outFile}`);
  console.log(`   总行数：${ORDER_COUNT}（其中有效 ${validCount} 行，非法 ${invalidCount} 行）`);
  console.log(`   文件大小：${(stat.size / 1024).toFixed(1)} KB`);

  // 同时生成一个对应的解析规则 JSON，便于测试时绑定（standard 模式）
  const ruleJson = {
    name: "压测标准规则",
    description: "适用于 10000-orders.xlsx 的 standard 解析规则",
    fileType: "excel",
    parseMode: "standard",
    excel: {
      headerRows: 1,
      footerRows: 0,
      dataStartRow: 1,
    },
    fieldMappings: [
      { fromCol: 0, toField: "externalCode" },
      { fromCol: 1, toField: "storeName" },
      { fromCol: 2, toField: "receiverName" },
      { fromCol: 3, toField: "receiverPhone" },
      { fromCol: 4, toField: "receiverAddress" },
      { fromCol: 5, toField: "skuCode" },
      { fromCol: 6, toField: "skuName" },
      { fromCol: 7, toField: "skuQuantity" },
      { fromCol: 8, toField: "skuSpec" },
    ],
    defaults: {},
  };
  const ruleFile = path.join(outDir, "bench-rule.json");
  fs.writeFileSync(ruleFile, JSON.stringify(ruleJson, null, 2), "utf-8");
  console.log(`✅ 配套解析规则文件：${ruleFile}`);
}

async function main() {
  console.log("=========================================");
  console.log("  V2 压测数据准备");
  console.log("=========================================\n");

  const codes = await seedSkuMaster();
  generateOrdersExcel(codes);

  console.log("\n=========================================");
  console.log("  全部完成");
  console.log("=========================================");
  console.log("下一步：");
  console.log("  1. 在 Web 端用『压测标准规则』上传 test-data/10000-orders.xlsx");
  console.log("  2. 或运行压测脚本：npx tsx scripts/benchmark.ts");
}

main().catch((e) => {
  console.error("❌ 失败：", e);
  process.exit(1);
});
