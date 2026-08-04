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

// ====== 异步导入链路类型 ======

export type ImportTaskStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL_SUCCESS' | 'FAILED';
export type BatchStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type OutboxStatus = 'PENDING' | 'SENT' | 'FAILED';

// 任务创建响应
export interface ImportTaskCreated {
  task_id: string;
  trace_id: string;
  status: ImportTaskStatus;
  total_rows: number;
  total_batches: number;
}

// 任务进度响应
export interface ImportTaskProgress {
  task_id: string;
  trace_id: string;
  status: ImportTaskStatus;
  file_name: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  degraded: boolean;
  degraded_reason: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  // 衍生指标
  throughput?: number;        // 行/秒
  eta_seconds?: number | null;
}

// 行级错误记录（DB 行）
export interface ImportTaskErrorRow {
  id: string;
  task_id: string;
  unit_id: string;
  batch_index: number;
  row_number: number;
  field_name: string;
  raw_value: string | null;
  error_code: string;
  error_reason: string;
  trace_id: string;
  created_at: string;
}

// 批次性能日志行
export interface BatchPerformanceRow {
  id: string;
  task_id: string;
  unit_id: string;
  batch_index: number;
  parse_duration_ms: number;
  rule_duration_ms: number;
  validate_duration_ms: number;
  insert_duration_ms: number;
  total_duration_ms: number;
  row_count: number;
  success_count: number;
  failed_count: number;
  status: string;
  trace_id: string;
  created_at: string;
}

// Trace 时间线事件
export interface TraceEventRow {
  id: string;
  trace_id: string;
  task_id: string | null;
  unit_id: string | null;
  event_name: string;
  event_status: string | null;
  message: string | null;
  occurred_at: string;
}

// 监控聚合
export interface MonitorSummary {
  throughput: { minute: string; success_rows: number }[];  // 最近5分钟每分钟成功行数
  queue_backlog: {
    pending_batches: number;
    pending_rows: number;
    status: 'ok' | 'warning' | 'critical';
  };
  stage_duration: {
    stage: string;
    p50: number;
    p95: number;
    p99: number;
  }[];
  error_distribution: { error_code: string; count: number; reason: string }[];
  slow_batches_top10: BatchPerformanceRow[];
  failed_tasks_recent: { id: string; file_name: string; failed_rows: number; created_at: string }[];
}

// 错误码枚举
export const ERROR_CODES = {
  SKU_NOT_EXIST: 'E001',
  REQUIRED_MISSING: 'E002',
  PHONE_FORMAT: 'E003',
  QTY_NOT_POSITIVE: 'E004',
  EXTERNAL_CODE_DUP: 'E005',
  RULE_MAP_FAILED: 'E006',
  DB_INSERT_FAILED: 'E007',
  FILE_FORMAT: 'E008',
} as const;

export const ERROR_CODE_LABELS: Record<string, string> = {
  E001: 'SKU 不存在',
  E002: '必填字段缺失',
  E003: '电话格式错误',
  E004: '数量不是正数',
  E005: '外部编码重复',
  E006: '规则映射失败',
  E007: '数据库写入失败',
  E008: '文件格式不支持',
};
