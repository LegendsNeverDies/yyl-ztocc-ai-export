"use server";

import { db } from "@/lib/db";
import { parseRules } from "@/lib/db-schema";
import { inArray } from "drizzle-orm";
import { generateId } from "@/lib/utils";

const DEMO_RULES = [
  // ====== 1. 黎明屯配送发货单 ======
  // 结构: R1-R3干扰头 | R4表头(42列) | R5-R6数据 | R7合计 | R8元信息 | R9收货人KV | R10底部
  {
    name: "黎明屯配送发货单",
    description: "42列标准表格，前3行干扰头部，第4行表头，第5-6行数据，第7行合计，底部8-9行为KV对格式的元信息和收货人信息",
    config: {
      name: "黎明屯配送发货单",
      description: "42列标准表格，前3行干扰头部，第4行表头，第5-6行数据，第7行合计，底部8-9行为KV对格式的元信息和收货人信息",
      fileType: "excel",
      parseMode: "standard",
      excel: {
        headerRows: 0,
        footerRows: 3,                // 末尾3行(R8单据号/R9收货人/R10底部)由kvExtract处理，数据循环跳过
        dataStartRow: 4,              // R5 = index 4 (第一条数据行)
        skipIfFirstColContains: ["合计", "总计"],
      },
      fieldMappings: [
        { fromCol: 2, toField: "skuCode", aiConfidence: "high" },     // R5 col3 物品编码
        { fromCol: 3, toField: "skuName", aiConfidence: "high" },     // R5 col4 物品名称
        { fromCol: 5, toField: "skuSpec", aiConfidence: "medium" },   // R5 col6 规格型号
        { fromCol: 14, toField: "skuQuantity", aiConfidence: "high" },// R5 col15 发货数量
        { fromCol: 41, toField: "remark", aiConfidence: "low" },      // R5 col42 备注
      ],
      kvExtract: [
        {
          rows: [3],   // R8 元信息行(单据号等)
          entries: [
            { label: "单据号", toField: "externalCode" },
          ],
        },
        {
          rows: [4],   // R9 收货信息行
          entries: [
            { label: "收货人", toField: "receiverName" },
            { label: "收货电话", toField: "receiverPhone" },
            { label: "收货地址", toField: "receiverAddress" },
          ],
        },
      ],
      defaults: {},
    },
  },

  // ====== 2. 湖南仓发货明细 ======
  // 结构: R1说明 | R2表头(32列) | R3起167行数据，每行自带收货人/电话/地址，按配送汇总单号聚合
  {
    name: "湖南仓发货明细",
    description: "32列表格，第1行说明文字，第2行表头，第3行起数据(167行)，每行自带收货人信息，按配送汇总单号聚合",
    config: {
      name: "湖南仓发货明细",
      description: "32列表格，第1行说明文字，第2行表头，第3行起数据(167行)，每行自带收货人信息，按配送汇总单号聚合",
      fileType: "excel",
      parseMode: "aggregate",
      excel: {
        headerRows: 0,
        footerRows: 0,
        dataStartRow: 2,              // R3 = index 2
      },
      fieldMappings: [
        { fromCol: 0, toField: "storeName", aiConfidence: "high" },      // R3 col1 收货机构
        { fromCol: 1, toField: "externalCode", aiConfidence: "high" },   // R3 col2 配送汇总单号
        { fromCol: 5, toField: "skuCode", aiConfidence: "high" },        // R3 col6 物品编码
        { fromCol: 6, toField: "skuName", aiConfidence: "high" },        // R3 col7 物品名称
        { fromCol: 8, toField: "skuSpec", aiConfidence: "high" },        // R3 col9 规格型号
        { fromCol: 12, toField: "skuQuantity", aiConfidence: "high" },   // R3 col13 发货数量
        { fromCol: 26, toField: "receiverName", aiConfidence: "high" },  // R3 col27 收货人
        { fromCol: 27, toField: "receiverPhone", aiConfidence: "high" }, // R3 col28 收货电话
        { fromCol: 28, toField: "receiverAddress", aiConfidence: "high" },// R3 col29 收货地址
      ],
      aggregate: {
        groupByCol: 1,
        groupByField: "externalCode",
        sharedFields: ["storeName", "receiverName", "receiverPhone", "receiverAddress", "externalCode"],
      },
    },
  },

  // ====== 3. 欢乐牧场模板(矩阵转置) ======
  // 结构: R1表头(仓库/货主/SKU信息+5个门店名) | R2起114行SKU×门店数量矩阵
  {
    name: "欢乐牧场模板(矩阵)",
    description: "SKU×门店矩阵，第1行表头含门店名(银泰/金银潭/金桥/门店B/门店D在col14-18)，第2行起为各SKU在各门店的数量",
    config: {
      name: "欢乐牧场模板(矩阵)",
      description: "SKU×门店矩阵，第1行表头含门店名(银泰/金银潭/金桥/门店B/门店D在col14-18)，第2行起为各SKU在各门店的数量",
      fileType: "excel",
      parseMode: "matrix",
      excel: {
        headerRows: 0,
        footerRows: 0,
        dataStartRow: 0,
      },
      fieldMappings: [],
      matrix: {
        storeHeaderRow: 0,           // R1 = index 0 (表头行含门店名)
        storeStartCol: 13,           // col14 = index 13 (银泰)
        storeEndCol: 17,             // col18 = index 17 (门店D)
        quantityField: "skuQuantity",
        storeNameField: "storeName",
        fixedColMappings: [
          { fromCol: 2, toField: "skuName", aiConfidence: "high" },    // col3 SKU名称
          { fromCol: 3, toField: "skuCode", aiConfidence: "high" },    // col4 SKU条码
          { fromCol: 7, toField: "skuSpec", aiConfidence: "medium" },  // col8 规格
        ],
      },
    },
  },

  // ====== 4. 黔寨寨配送单(PDF) ======
  // 结构: 2页，P1头部元信息+表格行1-35 | P2表格行36-41+合计+底部收货人纯文本
  // PDF文件在解析时已经按文本行+表格抽取，本规则配置标准模式即可
  {
    name: "黔寨寨配送单(PDF)",
    description: "PDF 2页，头部元信息+跨页标准表格+尾部收货人文本区",
    config: {
      name: "黔寨寨配送单(PDF)",
      description: "PDF 2页，头部元信息+跨页标准表格+尾部收货人文本区",
      fileType: "pdf",
      parseMode: "standard",
      pdf: {
        tableStartMarker: "物品类别",
        tableEndMarker: "合计",
      },
      fieldMappings: [
        { fromCol: 2, toField: "skuCode", aiConfidence: "high" },     // 列对齐网格 col3 物品编码
        { fromCol: 3, toField: "skuName", aiConfidence: "high" },     // col4 物品名称
        { fromCol: 4, toField: "skuSpec", aiConfidence: "medium" },   // col5 规格型号
        { fromCol: 6, toField: "skuQuantity", aiConfidence: "high" }, // col7 发货数量
      ],
      kvExtract: [
        {
          // 不限定行：全表扫描，提取头部"收货机构"与尾部"收货人/电话/地址"（同格 label：value）
          entries: [
            { label: "收货机构", toField: "storeName" },
            { label: "收货人", toField: "receiverName" },
            { label: "收货电话", toField: "receiverPhone" },
            { label: "收货地址", toField: "receiverAddress" },
          ],
        },
      ],
    },
  },

  // ====== 5. 多门店分Sheet出库单 ======
  // 结构: 3个Sheet(银泰店/金桥店/金银潭店)，每Sheet: R1标题 | R2元信息 | R4表头 | R5-R11数据 | R12合计 | R14-R15 KV对收货信息
  {
    name: "多门店分Sheet出库单",
    description: "3个Sheet(银泰店/金桥店/金银潭店)，每Sheet结构相同：标题→表头→数据→合计→底部KV对收货信息",
    config: {
      name: "多门店分Sheet出库单",
      description: "3个Sheet(银泰店/金桥店/金银潭店)，每Sheet结构相同：标题→表头→数据→合计→底部KV对收货信息",
      fileType: "excel",
      parseMode: "multi-sheet",
      excel: {
        headerRows: 0,
        footerRows: 0,
        dataStartRow: 3,              // R4=index3 起为数据（R1标题/R2元信息/R3表头）
        skipIfFirstColContains: ["合计", "收货门店", "联系电话", "制单人"], // 排除尾部命名行，不依赖固定行数
      },
      fieldMappings: [
        { fromCol: 1, toField: "skuCode", aiConfidence: "high" },     // col2物品编码
        { fromCol: 2, toField: "skuName", aiConfidence: "high" },     // col3物品名称
        { fromCol: 3, toField: "skuSpec", aiConfidence: "high" },     // col4规格型号
        { fromCol: 5, toField: "skuQuantity", aiConfidence: "high" }, // col6出库数量
        { fromCol: 7, toField: "remark", aiConfidence: "low" },       // col8备注
      ],
      kvExtract: [
        {
          rows: [-3, -2],  // 倒数第3行(收货门店/联系人)、倒数第2行(联系电话/收货地址)
          entries: [
            { label: "收货门店", toField: "storeName" },
            { label: "联系人", toField: "receiverName" },
            { label: "联系电话", toField: "receiverPhone" },
            { label: "收货地址", toField: "receiverAddress" },
          ],
        },
      ],
    },
  },

  // ====== 6. 卡片式调拨单 ======
  // 结构: R1标题 | R2元信息 | R4▶调拨记录#1 | R5门店/收货人KV | R6地址 | R7物品表头 | R8-R10数据 | 空行 | ▶#2...
  {
    name: "卡片式调拨单",
    description: "卡片式布局，▶ 调拨记录 #N 为卡片边界，每卡片含调入门店/收货人KV对+物品数据小表",
    config: {
      name: "卡片式调拨单",
      description: "卡片式布局，▶ 调拨记录 #N 为卡片边界，每卡片含调入门店/收货人KV对+物品数据小表",
      fileType: "excel",
      parseMode: "card",
      card: {
        boundaryPattern: "▶.*调拨记录",
        cardMetaMappings: [
          { label: "调入门店", toField: "storeName" },
          { label: "收货人", toField: "receiverName" },
          { label: "电话", toField: "receiverPhone" },
          { label: "收货地址", toField: "receiverAddress" },
        ],
        dataFieldMappings: [
          { fromCol: 0, toField: "skuCode", aiConfidence: "high" },     // col1 物品编码
          { fromCol: 1, toField: "skuName", aiConfidence: "high" },     // col2 物品名称
          { fromCol: 2, toField: "skuSpec", aiConfidence: "high" },     // col3 规格
          { fromCol: 3, toField: "skuQuantity", aiConfidence: "high" }, // col4 数量
        ],
      },
      fieldMappings: [],
    },
  },
];

export async function seedDemoRules() {
  const names = DEMO_RULES.map((r) => r.name);
  // 先删除同名旧规则，再插入新规则
  await db.delete(parseRules).where(inArray(parseRules.name, names));

  for (const rule of DEMO_RULES) {
    const configCopy = JSON.parse(JSON.stringify(rule.config));
    await db.insert(parseRules).values({
      id: generateId(),
      name: rule.name,
      description: rule.description,
      config: configCopy,
    });
  }
  return DEMO_RULES.length;
}
