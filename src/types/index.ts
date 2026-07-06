// ====== 订单字段类型 ======
export interface OrderRow {
  id: string;
  rowIndex: number;
  externalCode: string;
  storeName: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  skuCode: string;
  skuName: string;
  skuQuantity: number;
  skuSpec: string;
  remark: string;
  _errors?: ValidationError[];
}

// ====== 校验错误类型 ======
export interface ValidationError {
  rowIndex: number;
  field: string;
  message: string;
}

// ====== 规则引擎类型 ======
export type FileType = 'excel' | 'pdf';
export type ParseMode = 'standard' | 'aggregate' | 'matrix' | 'card' | 'multi-sheet';

// 简单列映射: 第N列 → 目标字段
export interface FieldMapping {
  fromCol: number;
  fromColName?: string;
  toField: string;
  aiConfidence?: 'high' | 'medium' | 'low';
}

// KV对条目: 扫描一行，找到标签文字，取其右侧列的值
export interface KvEntry {
  label: string;           // 标签文字，如 "收货人"、"单据号"（忽略末尾冒号）
  toField: string;         // 映射到哪个字段
}

// KV提取配置：按标签名扫描行，提取键值对
export interface KvExtractConfig {
  rows?: number[];         // 行号（0-based），正数从dataStartRow起，负数从末尾倒数；缺省或空数组=扫描所有行（PDF散落信息友好）
  entries: KvEntry[];
}

export interface ExcelConfig {
  headerRows: number;      // 跳过前N行（干扰头部）
  footerRows: number;      // 跳过末尾N行
  dataStartRow: number;    // 数据从第几行开始（0-based）
  skipRows?: number[];     // 跳过的行号列表
  skipIfFirstColContains?: string[];  // 第一列包含这些文字就跳过该行
}

export interface PdfConfig {
  tableStartMarker: string;
  tableEndMarker: string;
}

export interface AggregateConfig {
  groupByCol: number;
  groupByField: string;
  sharedFields: string[];
}

export interface MatrixConfig {
  storeHeaderRow: number;
  storeStartCol: number;
  storeEndCol: number;
  fixedColMappings: FieldMapping[];  // 固定列的映射（SKU信息、规格等）
  quantityField?: string;            // 数量字段名，默认 "skuQuantity"
  storeNameField?: string;           // 门店名字段名，默认 "storeName"
}

export interface CardConfig {
  boundaryPattern: string;           // 卡片边界正则
  cardMetaMappings: KvEntry[];       // 卡片头部元信息KV对（门店、收件人等）
  dataFieldMappings: FieldMapping[]; // 卡片内数据表的列映射
}

export interface ParseRule {
  id: string;
  name: string;
  description: string;
  fileType: FileType;
  parseMode: ParseMode;
  excel?: ExcelConfig;
  pdf?: PdfConfig;
  fieldMappings: FieldMapping[];     // 数据区列映射
  aggregate?: AggregateConfig;
  matrix?: MatrixConfig;
  card?: CardConfig;
  kvExtract?: KvExtractConfig[];     // KV对提取（用于头部/尾部非表格信息）
  defaults?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ParseRuleDraft extends Omit<ParseRule, 'id' | 'createdAt' | 'updatedAt'> {
  id?: string;
}

// ====== AI 规则生成 ======
export interface AiRuleResponse {
  rule: ParseRuleDraft;
  suggestions: string;
  confidenceSummary: {
    high: number;
    medium: number;
    low: number;
  };
}

// ====== 文件解析 ======
export interface ParseProgress {
  current: number;
  total: number;
  percent: number;
  status: 'idle' | 'parsing' | 'done' | 'error';
}

export interface ParseResult {
  rows: OrderRow[];
  errors: ValidationError[];
  fileName: string;
  ruleName: string;
  parseDuration: number;
}

// ====== 提交结果 ======
export interface SubmitResult {
  success: number;
  failed: number;
  batchId: string;
  errors?: { rowIndex: number; message: string }[];
}

// ====== 数据库记录 ======
// 出库单主表行（按外部编码聚合）
export interface DbShipment {
  id: string;
  externalCode: string | null;
  storeName: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  remark: string | null;
  skuCount: number;
  totalQuantity: string;
  batchId: string;
  submittedAt: string;
}

// SKU 明细子表行
export interface DbOrderItem {
  id: string;
  shipmentId: string;
  skuCode: string;
  skuName: string;
  skuQuantity: string;
  skuSpec: string | null;
  remark: string | null;
}

// ====== 文件读取 ======
export interface RawRow {
  rowNum: number;
  cells: (string | number | null)[];
}

export interface ParsedFile {
  fileName: string;
  fileType: FileType;
  sheets?: { name: string; rows: RawRow[] }[];
  rows: RawRow[];
  sampleText?: string;
}

// ====== UI 状态 ======
export type ImportStep = 'upload' | 'select-rule' | 'ai-generate' | 'preview' | 'submit';
