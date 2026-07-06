import { utils, writeFile } from "xlsx";

// 基础数据池
const stores = [
  "尹三顺自助烤肉（银泰店）", "尹三顺自助烤肉（金桥店）", "尹三顺自助烤肉（金银潭店）",
  "黎明屯铁锅炖（海口龙湖天街店）", "欢乐牧场（万达店）", "黔寨寨贵州烙锅（鞍山首店）",
  "尹三顺自助烤肉（五一悦方店）", "欢乐牧场（光谷店）", "黔寨寨贵州烙锅（武汉店）",
  "黎明屯铁锅炖（深圳店）",
];

const receivers = [
  { name: "王店长", phone: "13900001111", addr: "汉口解放大道688号银泰百货B1层" },
  { name: "李经理", phone: "13800002222", addr: "武汉江岸区金桥大道38号永旺梦乐城2F" },
  { name: "张主管", phone: "13700003333", addr: "武汉东西湖区金银潭大道1号永旺梦乐城3F" },
  { name: "张锦峰", phone: "18533660999", addr: "海南省海口市龙华区金宇街道南海大道15号龙湖海口天街" },
  { name: "刘店长", phone: "13600004444", addr: "湖北省武汉市武昌区中北路109号万达广场4F" },
  { name: "荣丽", phone: "13130093946", addr: "辽宁省鞍山市铁东区建国大道700号万象汇" },
  { name: "邹生", phone: "13537459614", addr: "湖南省长沙市天心区坡子街216号坡子街街道办事处" },
  { name: "赵主管", phone: "15900005555", addr: "湖北省武汉市洪山区珞瑜路789号光谷广场3F" },
  { name: "陈经理", phone: "18600006666", addr: "贵州省贵阳市云岩区中华北路100号" },
  { name: "孙店长", phone: "17700007777", addr: "广东省深圳市南山区深南大道9028号益田假日广场B1" },
];

const skuPool = [
  { code: "ZBWP0001", name: "茶语柠听紫苏风味糖浆", spec: "750ml*6瓶/件" },
  { code: "ZBWP0015", name: "寨寨香肠片", spec: "2.5kg*6包/件" },
  { code: "ZBWP0025", name: "麻辣折耳根脆", spec: "1.5kg*6包/件" },
  { code: "ZBWP0028", name: "Q寨寨五常香米", spec: "25kg/包" },
  { code: "ZBWP0030", name: "精品五花肉卷", spec: "10kg/件" },
  { code: "ZBWP0035", name: "雪花肥牛卷", spec: "15kg/件" },
  { code: "ZBWP0040", name: "韩式泡菜", spec: "5kg*4包/件" },
  { code: "ZBWP0005", name: "茶语柠听奶茶基底", spec: "1L*12盒/件" },
  { code: "ZBWP0024", name: "哨末（精）", spec: "500g*20包/件" },
  { code: "ZBWP0027", name: "小脆哨（精）", spec: "500g*20包/件" },
  { code: "ZBWP0127", name: "尹三顺秘制蘸料（特辣）", spec: "1kg*10袋" },
  { code: "ZBWP0144", name: "尹三顺秘制蘸料（香辣）", spec: "1kg*10袋" },
  { code: "ZBWP0269", name: "熹厨工场猪肋排", spec: "15KG/件" },
  { code: "ZBWP0031", name: "树番茄底料", spec: "500g*30包/件" },
  { code: "ZBWP0032", name: "熟烙酱", spec: "500g*30包/件" },
  { code: "ZBWP0042", name: "糊辣椒面", spec: "2.5kg*4包/件" },
  { code: "LMTZ0160009", name: "成品锅包肉(含汁)", spec: "1kg*10袋*箱" },
  { code: "LMTZ1040002", name: "大花工帽鸭舌帽", spec: "1*1顶" },
  { code: "HLMC-00104", name: "冷冻带头带壳生南美白虾 50-60", spec: "9kg" },
  { code: "07010747", name: "26/30海老盒装熟虾4KG", spec: "4KG" },
  { code: "06050143", name: "4490牛胸-抄码", spec: "抄码" },
  { code: "05010138", name: "100g欢乐牧场牛油火锅底料", spec: "100g" },
  { code: "ZBWP0094", name: "后厨上衣 XL码", spec: "XL码" },
  { code: "ZBWP0099", name: "帽子（通用）", spec: "均码" },
  { code: "ZBWP2093", name: "带脂梅花肉", spec: "25kg/件" },
  { code: "ZBWP0192", name: "熹厨工场芝麻酱汁", spec: "1KG*10包" },
  { code: "06030292", name: "雪花猪颈肉（肉青）", spec: "10KG/箱" },
  { code: "ZBWP2247", name: "迪拜风味巧克力千层蛋糕", spec: "380g*16盒/箱" },
  { code: "ZBWP2184", name: "卡玛大板盐冻青虾5060", spec: "6kg*2袋" },
  { code: "ZBWP0279", name: "笔管鱿鱼", spec: "4.7kg" },
];

// 生成一个固定批次号
const batchNo = `PSHZ26060600`;

// 生成 1000 条数据
const rows: Record<string, string | number>[] = [];
let externalCodeCounter = 1;

for (let i = 0; i < 1000; i++) {
  const store = stores[i % stores.length];
  const receiver = receivers[i % receivers.length];
  const sku = skuPool[i % skuPool.length];
  const qty = 1 + Math.floor(Math.random() * 20);

  // 每 1-5 行共享同一个外部编码（模拟聚合场景）
  const groupSize = 1 + (i % 5);
  const ec = `${batchNo}${String(externalCodeCounter).padStart(4, "0")}`;
  if (i > 0 && (i % groupSize !== 0)) {
    // 同组使用相同外部编码
    const last = rows[rows.length - 1];
    rows.push({
      外部编码: last["外部编码"],
      配送单号: `PS260606${String(i + 1).padStart(4, "0")}`,
      收货门店: store,
      收件人姓名: receiver.name,
      收件人电话: receiver.phone,
      收件人地址: receiver.addr,
      "SKU物品编码": sku.code,
      "SKU物品名称": sku.name,
      "SKU发货数量": qty,
      "SKU规格型号": sku.spec,
      发货仓库: "武汉配送中心",
      发货日期: "2026/06/06",
      备注: "",
    });
  } else {
    externalCodeCounter++;
    rows.push({
      外部编码: ec,
      配送单号: `PS260606${String(i + 1).padStart(4, "0")}`,
      收货门店: store,
      收件人姓名: receiver.name,
      收件人电话: receiver.phone,
      收件人地址: receiver.addr,
      "SKU物品编码": sku.code,
      "SKU物品名称": sku.name,
      "SKU发货数量": qty,
      "SKU规格型号": sku.spec,
      发货仓库: "武汉配送中心",
      发货日期: "2026/06/06",
      备注: "",
    });
  }
}

// 写入 Excel
const ws = utils.json_to_sheet(rows);
const wb = utils.book_new();
utils.book_append_sheet(wb, ws, "发货明细");

const filename = "1000条测试运单.xlsx";
writeFile(wb, filename);
console.log(`✅ 已生成 ${filename}，共 ${rows.length} 条数据，${externalCodeCounter - 1} 个独立配送单号`);
