import type { ParsedFile, ParseRule, OrderRow, RawRow, KvExtractConfig, KvEntry, FieldMapping } from "@/types";

// 整行拼接为文本（用于 marker / 边界匹配）
function rowToText(row: RawRow): string {
  return row.cells.map((c) => String(c ?? "")).join(" ");
}

// ====== KV 对提取 ======
// 在一行中按 entry 提取值，支持两种形态：
//  1) 同一单元格内 "标签：值"（PDF 列对齐后常见）
//  2) 标签单独成格，值在右侧相邻列（Excel 散落信息常见）
function scanKvOnRow(row: RawRow, entries: KvEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (result[entry.toField]) continue;
    for (let ci = 0; ci < row.cells.length; ci++) {
      const cellText = String(row.cells[ci] ?? "").trim();
      if (!cellText) continue;

      // 形态1：同格 "标签：值"
      const m = cellText.match(/^(.+?)[：:]\s*(.*)$/);
      if (m && m[1].trim() === entry.label && m[2].trim()) {
        result[entry.toField] = m[2].trim();
        break;
      }
      // 形态2：单元格恰为标签（忽略末尾冒号），取右侧第一个非空列
      const cellClean = cellText.replace(/[：:]\s*$/, "");
      if (cellClean === entry.label) {
        const val = String(row.cells[ci + 1] ?? "").trim();
        if (val) {
          result[entry.toField] = val;
          break;
        }
      }
    }
  }
  return result;
}

// 提取头部/尾部非表格区的 KV 对。config.rows 缺省/空 => 扫描所有行（散落信息友好）
function extractKvPairs(
  rows: RawRow[],
  kvConfigs: KvExtractConfig[] | undefined,
  dataStartRow: number,
  totalRows: number
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!kvConfigs) return result;

  for (const config of kvConfigs) {
    let targetRows: number[];
    if (!config.rows || config.rows.length === 0) {
      targetRows = rows.map((_, i) => i); // 全表扫描
    } else {
      // 正数：从 dataStartRow 起偏移；负数：从末尾倒数
      targetRows = config.rows.map((r) => (r >= 0 ? dataStartRow + r : totalRows + r));
    }

    for (const actualRow of targetRows) {
      if (actualRow < 0 || actualRow >= totalRows) continue;
      const row = rows[actualRow];
      if (!row) continue;
      const found = scanKvOnRow(row, config.entries);
      for (const k in found) {
        if (!result[k]) result[k] = found[k]; // 先到先得，不覆盖
      }
    }
  }
  return result;
}

// ====== 数据区列映射 ======
function applyFieldMappings(row: RawRow, mappings: FieldMapping[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const m of mappings) {
    const val = String(row.cells[m.fromCol] ?? "").trim();
    record[m.toField] = val;
  }
  return record;
}

// 由 mapped 记录 + KV + 默认值构造一条 OrderRow
function buildOrderRow(
  record: Record<string, string>,
  kv: Record<string, string>,
  defaults: Record<string, string> | undefined,
  rowIndex: number
): OrderRow {
  const pick = (f: string) => record[f] || kv[f] || defaults?.[f] || "";
  return {
    id: crypto.randomUUID(),
    rowIndex,
    externalCode: pick("externalCode"),
    storeName: pick("storeName"),
    receiverName: pick("receiverName"),
    receiverPhone: pick("receiverPhone"),
    receiverAddress: pick("receiverAddress"),
    skuCode: pick("skuCode"),
    skuName: pick("skuName"),
    skuQuantity: Number(record["skuQuantity"] || defaults?.["skuQuantity"] || 0) || 0,
    skuSpec: pick("skuSpec"),
    remark: pick("remark"),
  };
}

// ====== 主解析函数 ======
export function parseFile(file: ParsedFile, rule: ParseRule): OrderRow[] {
  // 多 Sheet 合并：以规则模式为准，而非文件 sheet 数
  if (rule.parseMode === "multi-sheet" && file.sheets && file.sheets.length > 0) {
    return parseMultiSheet(file, rule);
  }
  return parseRows(file.rows, rule, 0);
}

// ====== 模式分派 ======
function parseRows(rows: RawRow[], rule: ParseRule, rowIndexOffset: number): OrderRow[] {
  if (rows.length === 0) return [];

  switch (rule.parseMode) {
    case "matrix":
      return parseMatrix(rows, rule, rowIndexOffset);
    case "card":
      return parseCards(rows, rule, rowIndexOffset);
    case "aggregate":
      return parseAggregate(rows, rule, rowIndexOffset);
    default: // standard / multi-sheet(每 sheet)
      return collectStandardRows(rows, rule, rowIndexOffset);
  }
}

// ====== 标准模式抽取（standard / aggregate / multi-sheet 共用） ======
function collectStandardRows(rows: RawRow[], rule: ParseRule, rowIndexOffset: number): OrderRow[] {
  const total = rows.length;
  const excel = rule.excel;
  const pdf = rule.pdf;

  let dataStartRow = excel?.dataStartRow ?? 0;
  let dataEndRow = total - (excel?.footerRows ?? 0); // 不含
  const skipIfFirstCol = excel?.skipIfFirstColContains ?? [];
  const skipRows = new Set(excel?.skipRows?.map((r) => r - 1) ?? []); // skipRows 为 1-based

  // PDF：用表格 marker 定位数据区
  if (pdf?.tableStartMarker) {
    for (let i = 0; i < total; i++) {
      if (rowToText(rows[i]).includes(pdf.tableStartMarker)) {
        dataStartRow = i + 1; // 表头下一行
        break;
      }
    }
  }
  if (pdf?.tableEndMarker) {
    for (let i = dataStartRow; i < total; i++) {
      if (rowToText(rows[i]).includes(pdf.tableEndMarker)) {
        dataEndRow = Math.min(dataEndRow, i);
        break;
      }
    }
  }

  const kvValues = extractKvPairs(rows, rule.kvExtract, dataStartRow, total);
  const hasSkuCodeMapping = rule.fieldMappings.some((m) => m.toField === "skuCode");

  const result: OrderRow[] = [];
  let rowIdx = 0;

  for (let i = dataStartRow; i < dataEndRow; i++) {
    if (skipRows.has(i)) continue;
    const row = rows[i];
    if (!row) continue;

    // 跳过跨页重复表头（PDF）
    if (pdf?.tableStartMarker && rowToText(row).includes(pdf.tableStartMarker)) continue;

    const firstCell = String(row.cells[0] ?? "").trim();
    if (skipIfFirstCol.some((s) => firstCell && firstCell.includes(s))) continue;

    const record = applyFieldMappings(row, rule.fieldMappings);

    // 数据行有效性：有 skuCode 映射时以其非空为准（天然排除合计/尾部/碎片行）；
    // 否则要求至少一个 mapped 列非空
    if (hasSkuCodeMapping) {
      if (!String(record["skuCode"] ?? "").trim()) continue;
    } else {
      const allEmpty = rule.fieldMappings.every((m) => !String(row.cells[m.fromCol] ?? "").trim());
      if (allEmpty) continue;
    }

    result.push(buildOrderRow(record, kvValues, rule.defaults, rowIndexOffset + rowIdx));
    rowIdx++;
  }

  return result;
}

// ====== 矩阵转置模式 ======
function parseMatrix(rows: RawRow[], rule: ParseRule, rowIndexOffset: number): OrderRow[] {
  const matrix = rule.matrix;
  if (!matrix) return [];

  const { storeHeaderRow, storeStartCol, storeEndCol } = matrix;
  const footerRows = rule.excel?.footerRows ?? 0;
  const skipIfFirstCol = rule.excel?.skipIfFirstColContains ?? [];

  const headerRow = rows[storeHeaderRow];
  const storeNames: { col: number; name: string }[] = [];
  for (let ci = storeStartCol; ci <= storeEndCol; ci++) {
    storeNames.push({ col: ci, name: String(headerRow?.cells[ci] ?? "").trim() });
  }

  const result: OrderRow[] = [];
  const kvValues = extractKvPairs(rows, rule.kvExtract, 0, rows.length);

  for (let ri = storeHeaderRow + 1; ri < rows.length - footerRows; ri++) {
    const row = rows[ri];
    const firstCell = String(row.cells[0] ?? "").trim();
    if (!firstCell) continue;
    if (skipIfFirstCol.some((s) => firstCell.includes(s))) continue;

    const skuRecord = applyFieldMappings(row, matrix.fixedColMappings);
    if (!String(skuRecord["skuCode"] ?? "").trim() && !String(skuRecord["skuName"] ?? "").trim()) continue;

    for (const { col, name } of storeNames) {
      if (!name) continue;
      const qty = Number(row.cells[col]) || 0;
      if (qty <= 0) continue; // 仅为非零数量单元格生成记录

      const base = buildOrderRow(skuRecord, kvValues, rule.defaults, rowIndexOffset + result.length);
      base.storeName = name;
      base.skuQuantity = qty;
      result.push(base);
    }
  }

  return result;
}

// ====== 跨行聚合模式 ======
// 先按标准模式抽取每行，再按 groupByField 分组、用组内首个非空值回填 sharedFields
function parseAggregate(rows: RawRow[], rule: ParseRule, rowIndexOffset: number): OrderRow[] {
  const agg = rule.aggregate;
  const base = collectStandardRows(rows, rule, rowIndexOffset);
  if (!agg) return base;

  const groups = new Map<string, OrderRow[]>();
  for (const r of base) {
    const key = String((r as unknown as Record<string, unknown>)[agg.groupByField] ?? "").trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  for (const group of groups.values()) {
    for (const field of agg.sharedFields) {
      let shared = "";
      for (const r of group) {
        const v = String((r as unknown as Record<string, unknown>)[field] ?? "").trim();
        if (v) {
          shared = v;
          break;
        }
      }
      if (!shared) continue;
      for (const r of group) {
        const rec = r as unknown as Record<string, unknown>;
        if (!String(rec[field] ?? "").trim()) rec[field] = shared;
      }
    }
  }

  return base;
}

// ====== 卡片识别模式 ======
function parseCards(rows: RawRow[], rule: ParseRule, rowIndexOffset: number): OrderRow[] {
  const card = rule.card;
  if (!card) return [];

  const boundaryRe = new RegExp(card.boundaryPattern);
  const result: OrderRow[] = [];
  let currentMeta: Record<string, string> = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const firstCell = String(row.cells[0] ?? "");
    const rowText = rowToText(row);

    // 卡片边界：重置当前卡片元信息
    if (boundaryRe.test(firstCell) || boundaryRe.test(rowText)) {
      currentMeta = {};
    }

    // KV 行（门店/收货人等）：仅更新 meta，不作数据行
    const kvFound = scanKvOnRow(row, card.cardMetaMappings);
    if (Object.keys(kvFound).length > 0) {
      Object.assign(currentMeta, kvFound);
      continue;
    }

    // 数据行判据：skuCode 非空 且 数量为正数（排除表头/合计/边界行）
    const dataRecord = applyFieldMappings(row, card.dataFieldMappings);
    const qty = Number(dataRecord["skuQuantity"]);
    if (String(dataRecord["skuCode"] ?? "").trim() && qty > 0) {
      const base = buildOrderRow(dataRecord, {}, rule.defaults, rowIndexOffset + result.length);
      base.externalCode = currentMeta["externalCode"] || base.externalCode;
      base.storeName = currentMeta["storeName"] || base.storeName;
      base.receiverName = currentMeta["receiverName"] || base.receiverName;
      base.receiverPhone = currentMeta["receiverPhone"] || base.receiverPhone;
      base.receiverAddress = currentMeta["receiverAddress"] || base.receiverAddress;
      result.push(base);
    }
  }

  return result;
}

// ====== 多 Sheet 合并模式 ======
function parseMultiSheet(file: ParsedFile, rule: ParseRule): OrderRow[] {
  const all: OrderRow[] = [];
  let offset = 0;

  for (const sheet of file.sheets ?? []) {
    const sheetRows = collectStandardRows(sheet.rows, rule, offset);
    all.push(...sheetRows);
    offset += sheet.rows.length;
  }

  return all;
}
