# 架构设计文档

## 1. 整体架构

### 1.1 异步事件驱动架构图

系统采用 **二步上传**（Two-Step Upload）方案：前端先预扫描文件得到 `total_rows`，第一步只提交元数据（1s 内返回 `task_id` + `upload_url`），用户立即跳转进度页；第二步在后台异步上传文件，服务端解析+切片+重建批次后将任务推进至 `PROCESSING`。

```
┌──────────────┐  1. 预扫描 total_rows           ┌─────────────────────────────┐
│   用户浏览器  │  2. POST /api/import-tasks      │  第一步 API（元数据）        │
│              │     (file_name/type/rows/rule)  │  ├─ createImportTaskFromMeta │
│              │ ──────────────────────────────▶ │  │   创建 import_tasks(PENDING) │
│              │                                  │  │   创建 import_task_batches   │
│  task_id 返回 │ ◀────────────────────────────── │  │   写入 event_outbox          │
│  upload_url   │  立即返回 task_id + upload_url  │  └─ 写入 trace_events          │
│              │                                  └─────────────────────────────┘
│              │  3. 后台异步 POST {upload_url}    ┌─────────────────────────────┐
│              │     (FormData: file)            │  第二步 API（上传文件）       │
│              │ ──────────────────────────────▶ │  ├─ readFile() 读为 RawRow    │
│              │                                  │  └─ attachParsedFileToTask(): │
│              │                                  │      parseFile() 解析一次      │
│  4. 轮询进度  │  GET /api/import-tasks/:id     │      按批切片→import_task_rows│
│  (每 2s)     │ ──────────────────────────────▶ │      重建 batches/outbox       │
│              │ ◀──────────────────────────────  │      状态→PROCESSING           │
└──────────────┘  返回 status/processed_rows      │      触发 Worker              │
                                                   └─────────────────────────────┘
                                                   │ 后台 fetch
                                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Outbox Dispatcher（outbox-dispatcher.ts）                       │
│  ├─ 轮询 event_outbox WHERE status='PENDING'                     │
│  ├─ 标记 SENT + 记 trace_events                                  │
│  └─ 失败指数退避重试（MAX_RETRY=5）                               │
└─────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Worker（import-worker.ts）                                      │
│  ├─ recoverStuckBatches()：恢复超时 PROCESSING 批次              │
│  ├─ FOR UPDATE SKIP LOCKED 原子抢占 PENDING 批次                 │
│  ├─ processSingleBatch()：                                       │
│  │   ├─ 读 import_task_rows 切片（不再重读原文件/不再重新解析）    │
│  │   ├─ validateBatch()：                                        │
│  │   │   ├─ 本地格式校验（validators.ts）                        │
│  │   │   ├─ SKU 批量校验（inArray 单次 IN 查询 + LRU 缓存）       │
│  │   │   └─ 外部编码重复检测（inArray 单次 IN 查询）              │
│  │   ├─ batchUpsertOrders()：                                     │
│  │   │   ├─ shipments 批量 UPSERT（UNNEST + ON CONFLICT）         │
│  │   │   └─ orders 批量 UPSERT（UNNEST + ON CONFLICT）            │
│  │   ├─ finalizeBatch()：错误明细 + 性能日志 + 批次状态（一事务） │
│  │   └─ 更新批次状态 → COMPLETED/FAILED                           │
│  └─ aggregateTask()：聚合任务状态 → COMPLETED/PARTIAL_SUCCESS/FAILED │
└─────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│  Neon Postgres                │    │  前端页面                     │
│  ├─ import_tasks              │    │  ├─ /tasks/:id 进度轮询       │
│  ├─ import_task_batches       │    │  ├─ /tasks/:id 错误明细       │
│  ├─ import_task_rows          │◀───│  ├─ /monitor 监控看板         │
│  ├─ import_task_errors        │    │  └─ /traces Trace 检索        │
│  ├─ event_outbox              │    └──────────────────────────────┘
│  ├─ batch_performance_log     │
│  ├─ trace_events              │
│  ├─ shipments + orders        │
│  └─ sku_master                │
└──────────────────────────────┘
```

### 1.2 核心设计原则

| 原则 | 实现 |
|---|---|
| 二步上传 | 前端预扫描行数 → 第一步只传元数据，1s 内返回 `task_id` + `upload_url`；第二步后台异步上传文件 |
| 解析前置 | 第一步不解析文件；第二步上传时一次性 `parseFile`，结果按批切片存入 `import_task_rows`，Worker 只读切片 |
| 异步解耦 | Outbox + Worker 轮询，不阻塞用户请求 |
| 批量处理 | SKU 校验用 IN 查询 + LRU 缓存；写入用 UNNEST + ON CONFLICT 批量 UPSERT |
| 幂等保护 | (task_id, unit_id) 唯一索引 + 状态检查 + 原子抢占 |
| 可恢复 | Outbox 持久化 + 卡死检测 + 自动重置 |
| 全链路可观测 | traceId 贯穿 + 性能日志 + trace_events |

## 2. Outbox 模式

### 2.1 设计目标

解决"任务创建成功但消息未投递"的宕机恢复问题。

### 2.2 实现细节

**表结构**（`db-schema.ts:129-145`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | serial PK | 自增主键 |
| `aggregate_id` | varchar | 聚合根 ID（task_id） |
| `event_type` | varchar | 事件类型（ImportBatchCreated） |
| `payload` | jsonb | 完整事件信封 |
| `status` | varchar | PENDING → SENT → FAILED |
| `retry_count` | int | 重试次数 |
| `next_retry_at` | timestamp | 下次重试时间 |
| `sent_at` | timestamp | 投递时间 |

**索引**：
- `event_outbox_status_next_retry_idx`（status + next_retry_at）
- `event_outbox_aggregate_idx`（aggregate_id）

**同事务写入**（二步上传，`import-service.ts:createImportTaskFromMeta` + `attachParsedFileToTask`）：

二步上传方案下，事务在两步分别发生：

- **第一步** `createImportTaskFromMeta`：`withTransaction` 内同事务写入 `import_tasks(PENDING, file_data=空)` + `import_task_batches` + `event_outbox` + `trace_events(ImportTaskCreated)`。此时不写 `import_task_rows`，批次基于前端预扫描的 `total_rows` 切分。
- **第二步** `attachParsedFileToTask`：`withTransaction` 内 `parseFile()` 解析一次 → 按批切片写入 `import_task_rows`；删除第一步的空 batches/outbox/rows 后用真实切片重建；更新 `import_tasks.file_data/total_rows/total_batches`，状态推进至 `PROCESSING`；追加 `trace_events(ImportFileAttached)`。

```
// 第一步
withTransaction(tx => {
  INSERT INTO import_tasks (status='PENDING', file_data=空)
  INSERT INTO import_task_batches (UNNEST)      -- 基于前端预扫描行数
  INSERT INTO event_outbox (UNNEST)
  INSERT INTO trace_events (ImportTaskCreated)
})

// 第二步
withTransaction(tx => {
  UPDATE import_tasks SET file_data, total_rows, total_batches, status='PROCESSING'
  DELETE FROM import_task_batches / event_outbox / import_task_rows WHERE task_id
  INSERT INTO import_task_batches (重建，UNNEST)
  INSERT INTO event_outbox (重建，UNNEST)
  INSERT INTO import_task_rows (切片 JSONB，UNNEST)
  INSERT INTO trace_events (ImportFileAttached)
})
```

> Neon HTTP 通过 `withTransaction`（Pool 真事务 BEGIN/COMMIT/ROLLBACK）保证 Outbox 原子性。

**Dispatcher 投递**（`outbox-dispatcher.ts`）：

```
轮询 WHERE status='PENDING' AND next_retry_at <= now()
  → 标记 SENT + 记 trace
  → 失败：retry_count+1，指数退避（2^retry × 1s，上限 60s）
  → 超过 MAX_RETRY=5：标记 FAILED
```

### 2.3 宕机恢复场景

| 宕机时机 | 恢复方式 |
|---|---|
| 第一步后、第二步前 | `import_tasks` 为 PENDING 但 `file_data` 为空，监控页可见"积压但无文件"任务；可向同一 `upload_url` 重传文件，`attachParsedFileToTask` 会幂等重建批次/outbox/rows |
| 第一步后、第二步前（Outbox 已投递但无文件） | 批次仍为 PENDING，Worker 抢占后发现 `import_task_rows` 为空批次会直接 finalize 为 COMPLETED（空批次），不会异常；建议运维对 PENDING+空 file_data 任务做告警 |
| 第二步中（事务未提交） | 事务回滚，任务仍为第一步 PENDING 状态，可重传文件 |
| 第二步后、Worker 处理前 | 批次为 PENDING，Worker 恢复后继续抢占处理 |
| Worker 处理中宕机 | 批次为 PROCESSING 但 lockedAt 超时，recoverStuckBatches 标记为 FAILED（不重置 PENDING 防死循环） |

## 3. 批量处理策略

### 3.1 批次划分

| 配置 | 值 |
|---|---|
| 批次大小 | 1000 行/批 |
| 批次数量 | `ceil(total_rows / 1000)` |
| 批次标识 | `unit_id = task_id前8位 + _b + batch_index` |

### 3.2 批量校验

| 校验项 | 方式 | 代码位置 |
|---|---|---|
| SKU 主数据 | `inArray(skuMaster.skuCode, skuCodes)` 单次 IN 查询 + LRU 缓存（10min TTL） | `import-worker.ts:validateBatch` |
| 外部编码重复 | `inArray(shipments.externalCode, externalCodes)` 单次 IN 查询 | `import-worker.ts:validateBatch` |
| 本地格式 | 复用 `validators.ts` 的 `validateOrders(rows)` | `import-worker.ts:validateBatch` |
| SKU 查询超时 | 3 秒超时（`SKU_DEGRADE_TIMEOUT_MS`）+ 降级标记 | `import-worker.ts:validateBatch` |

**关键优化**：SKU 校验从逐行查询改为单次 IN 查询 + LRU 缓存（压测命中率近 100%），1000 行只需 1 次未命中 DB 查询。

### 3.3 批量写入

| 写入对象 | 批次大小 | 并发方式 | 代码位置 |
|---|---|---|---|
| shipments 主表 | 整批 UNNEST | 单次 UPSERT | `import-worker.ts:batchUpsertOrders` |
| orders 子表 | 整批 UNNEST | 单次 UPSERT | `import-worker.ts:batchUpsertOrders` |
| 错误明细 | 整批 UNNEST | 同事务批量写 | `import-worker.ts:finalizeBatch` |

**关键优化**：写入从逐行 INSERT 改为 `UNNEST + ON CONFLICT DO NOTHING` 批量幂等 UPSERT（shipments 按 external_code、orders 按 (shipment_id, sku_code)），重复消费不会产生重复运单。

### 3.4 部分成功处理

```
validateBatch() → validRows + errors
  ├─ validRows → batchUpsertOrders()
  └─ errors   → finalizeBatch()（UNNEST 批量写 import_task_errors）
```

- 只有 `validRows` 执行批量写入
- 行级错误写入 `import_task_errors`
- 批次状态：有任意成功行 → COMPLETED；全部失败 → FAILED
- 任务状态：有失败行 → PARTIAL_SUCCESS；全部成功 → COMPLETED；全部失败 → FAILED

## 4. 数据模型 ER 图

```
┌─────────────────┐       ┌──────────────────────┐
│  import_tasks   │ 1   1 │  event_outbox        │
│  ├─ task_id (PK)│───────│  ├─ id (PK)          │
│  ├─ trace_id    │       │  ├─ aggregate_id (FK)│
│  ├─ status      │       │  ├─ event_type       │
│  ├─ total_rows  │       │  ├─ payload          │
│  └─ ...         │       │  └─ status           │
└────────┬────────┘       └──────────────────────┘
         │ 1
         │
         │ N
┌────────▼──────────────┐  ┌──────────────────────┐
│  import_task_batches  │  │  trace_events         │
│  ├─ id (PK)           │  │  ├─ id (PK)           │
│  ├─ task_id (FK)      │  │  ├─ trace_id         │
│  ├─ unit_id (UQ)      │  │  ├─ event_name       │
│  ├─ batch_index       │  │  └─ occurred_at       │
│  ├─ status            │  └──────────────────────┘
│  ├─ start_row         │
│  └─ end_row           │  ┌──────────────────────┐
└────────┬──────────────┘  │  batch_performance_log│
         │ 1               │  ├─ id (PK)           │
         │                 │  ├─ task_id (FK)      │
         │ N               │  ├─ unit_id          │
┌────────▼──────────────┐  │  ├─ parse_duration_ms│
│  import_task_errors   │  │  ├─ rule_duration_ms  │
│  ├─ id (PK)           │  │  ├─ validate_duration │
│  ├─ task_id (FK)      │  │  ├─ insert_duration   │
│  ├─ unit_id           │  │  └─ total_duration    │
│  ├─ row_number        │  └──────────────────────┘
│  ├─ field_name        │
│  ├─ error_code        │  ┌──────────────────────┐
│  └─ error_reason      │  │  shipments (复用)     │
└───────────────────────┘  │  ├─ id (PK)          │
                           │  └─ external_code    │
                           └───────┬──────────────┘
                                   │ 1
                                   │ N
                           ┌───────▼──────────────┐
                           │  orders (复用)        │
                           │  ├─ id (PK)           │
                           │  └─ shipment_id (FK) │
                           └──────────────────────┘
```

## 5. 状态机

### 5.1 任务状态流转

```
PENDING ──首批抢占──▶ PROCESSING ──全部批次完成──▶ COMPLETED
                                  │
                                  ├─部分失败──▶ PARTIAL_SUCCESS
                                  │
                                  └─全部失败──▶ FAILED
```

### 5.2 批次状态流转

```
PENDING ──FOR UPDATE SKIP LOCKED──▶ PROCESSING ──成功──▶ COMPLETED
                                          │
                                          └─失败──▶ FAILED (retryCount+1)
                                                  │
                                                  └─重试──▶ PENDING
```

### 5.3 Outbox 状态流转

```
PENDING ──Dispatcher 投递──▶ SENT
                │
                └─失败──▶ FAILED (retryCount+1, 指数退避)
                        │
                        └─超过 MAX_RETRY=5──▶ FAILED (终态)
```

## 6. Worker 触发机制

| 触发方式 | 说明 | 代码位置 |
|---|---|---|
| 第二步上传完成后后台 fetch | 文件附加成功后立即拉起 `/api/worker/run` | `api/import-tasks/[taskId]/upload/route.ts` |
| 旧路径上传后后台 fetch | 未走二步上传时，`POST /api/import-tasks` 内同步解析后触发 | `api/import-tasks/route.ts` |
| 前端轮询触发 | 任务详情页每 2s 轮询时触发 Worker | `tasks/[taskId]/page.tsx` |
| GitHub Actions 兜底 | 每 5 分钟定时调用 | `.github/workflows/worker.yml` |
| 手动触发 | `POST /api/worker/run` | `api/worker/run/route.ts` |

## 7. 容错与降级

| 场景 | 策略 |
|---|---|
| Neon HTTP 不支持事务 | 降级为顺序执行，打 warn 日志 |
| SKU 查询超时（3s） | 标记 `degraded=true`，前端橙色警告条提示 |
| 批次处理失败 | retryCount+1，退避 10s 后可重试 |
| 批次卡死（2min） | recoverStuckBatches 重置为 PENDING |
| Worker 函数超时（12s） | 单轮最多处理 4 批，超时自动停止 |
| Outbox 投递失败 | 指数退避重试，最多 5 次 |
