/**
 * 全局可调配置（集中管理，避免常量散落各文件）。
 * 压测时如 60s 目标未达成，调 BATCH_SIZE / WORKER_CONCURRENCY。
 */

/** 批处理配置 */
export const CONFIG = {
  /** 处理单元：每批行数。1000 行/批 × 10 批，推导见重构假设说明 */
  BATCH_SIZE: 1000,
  /** Worker 单实例并发批处理数（每批占 1 个 DB 连接） */
  WORKER_CONCURRENCY: 4,
  /** DB 连接池上限 */
  DB_POOL_MAX: 8,
  /** 单条 SQL 语句超时（ms），防慢 SQL 拖垮 Worker */
  DB_STATEMENT_TIMEOUT_MS: 10_000,

  /** SKU 主数据校验超时（ms），超时触发降级 */
  SKU_DEGRADE_TIMEOUT_MS: 3_000,
  /** SKU LRU 缓存容量 */
  SKU_LRU_MAX: 100_000,
  /** SKU LRU 缓存 TTL（ms） */
  SKU_LRU_TTL: 10 * 60 * 1000,

  /** Dispatcher 每轮投递的 outbox 上限 */
  DISPATCH_BATCH_LIMIT: 50,
  /** 批次卡死阈值（ms）：processing 超过此值视为卡死 */
  STUCK_BATCH_MS: 5 * 60 * 1000,
  /** 失败批次重试间隔（秒） */
  RETRY_BACKOFF_SECONDS: 10,
  /** Outbox 最大重试次数 */
  OUTBOX_MAX_RETRY: 5,

  /** 单次 Worker run 最大执行时长（ms），提前终止避免 serverless 超时 */
  MAX_RUN_DURATION_MS: 12_000,
  /** 单次 Worker run 最大处理批次数 */
  MAX_BATCHES_PER_RUN: 4,
} as const;

/** 错误码 */
export const ERROR_CODES = {
  SKU_NOT_EXIST: "E001",
  REQUIRED_MISSING: "E002",
  PHONE_FORMAT: "E003",
  QTY_NOT_POSITIVE: "E004",
  EXTERNAL_CODE_DUP: "E005",
  RULE_MAP_FAILED: "E006",
  DB_INSERT_FAILED: "E007",
  FILE_FORMAT: "E008",
} as const;

/** 任务状态 */
export const TASK_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  PARTIAL_SUCCESS: "PARTIAL_SUCCESS",
  FAILED: "FAILED",
} as const;

/** 批次状态 */
export const BATCH_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

/** Outbox 投递状态 */
export const OUTBOX_STATUS = {
  PENDING: "PENDING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;
