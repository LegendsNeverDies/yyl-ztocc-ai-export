# 架构设计文档

## 1. 整体架构

### 1.1 异步事件驱动架构图

```
┌──────────────┐     POST /api/import-tasks      ┌─────────────────────────────┐
│   用户浏览器  │ ──────────────────────────────▶ │  上传 API（Next.js Route）   │
│              │  (FormData: file+rule_id)       │  ├─ 读取文件为 RawRow 网格    │
│              │ ◀──────────────────────────────  │  ├─ 创建 import_tasks        │
│  task_id 返回 │  立即返回 task_id（≤1s）        │  ├─ 创建 import_task_batches  │
│              │                                  │  ├─ 写入 event_outbox        │
│  轮询进度     │  GET /api/import-tasks/:id     │  └─ 写入 trace_events        │
│  (每 2s)     │ ──────────────────────────────▶ │                              │
│              │ ◀──────────────────────────────  └─────────────────────────────┘
└──────────────┘  返回 status/processed_rows          │ 后台 fetch
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
│  │   ├─ 幂等检查（已 COMPLETED 直接返回）                         │
│  │   ├─ loadTaskFileData() + loadTaskRule()                      │
│  │   ├─ parseFile() 复用 V2 规则引擎                              │
│  │   ├─ validateBatch()：                                        │
│  │   │   ├─ 本地格式校验（validators.ts）                        │
│  │   │   ├─ SKU 批量校验（inArray 单次 IN 查询）                  │
│  │   │   └─ 外部编码重复检测（inArray 单次 IN 查询）              │
│  │   ├─ batchInsertOrders()：                                    │
│  │   │   ├─ shipments 批量 INSERT（100 条/批）                    │
│  │   │   └─ orders 批量 INSERT（500 条/批）+ Promise.all 并发     │
│  │   ├─ persistErrors()：行级错误批量写入（500 条/批）             │
│  │   ├─ 写入 batch_performance_log                                │
│  │   └─ 更新批次状态 → COMPLETED/FAILED                           │
│  └─ aggregateTask()：聚合任务状态 → COMPLETED/PARTIAL_SUCCESS/FAILED │
└─────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│  Neon Postgres                │    │  前端页面                     │
│  ├─ import_tasks              │    │  ├─ /tasks/:id 进度轮询       │
│  ├─ import_task_batches       │    │  ├─ /tasks/:id 错误明细       │
│  ├─ import_task_errors        │◀───│  ├─ /monitor 监控看板         │
│  ├─ event_outbox              │    │  └─ /traces Trace 检索        │
│  ├─ batch_performance_log     │    └──────────────────────────────┘
│  ├─ trace_events              │
│  ├─ shipments + orders        │
│  └─ sku_master                │
└──────────────────────────────┘
```

### 1.2 核心设计原则

| 原则 | 实现 |
|---|---|
| 上传即返回 | 上传接口只做文件读取+任务创建，立即返回 task_id |
| 异步解耦 | Outbox + Worker 轮询，不阻塞用户请求 |
| 批量处理 | SKU 校验用 IN 查询，写入用批量 INSERT + Promise.all |
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

**同事务写入**（`import-service.ts:128-143`）：

```
db.transaction(async (tx) => {
  await tx.insert(import_tasks)...
  await tx.insert(import_task_batches)...
  await tx.insert(event_outbox)...
  await tx.insert(trace_events)...
})
```

> Neon HTTP 不支持事务时降级为顺序执行，打 warn 日志。

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
| 任务创建后、Outbox 投递前 | Outbox 中有 PENDING 记录，Dispatcher 恢复后继续投递 |
| Outbox 投递后、Worker 处理前 | 批次仍为 PENDING，Worker 恢复后继续抢占处理 |
| Worker 处理中宕机 | 批次为 PROCESSING 但 lockedAt 超时，recoverStuckBatches 重置为 PENDING |

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
| SKU 主数据 | `inArray(skuMaster.skuCode, skuCodes)` 单次 IN 查询 | `import-worker.ts:305-313` |
| 外部编码重复 | `inArray(shipments.externalCode, externalCodes)` 单次 IN 查询 | `import-worker.ts:344-348` |
| 本地格式 | 复用 `validators.ts` 的 `validateOrders(rows)` | `import-worker.ts:278` |
| SKU 查询超时 | 3 秒超时 + 降级标记 | `import-worker.ts:309-322` |

**关键优化**：SKU 校验从逐行查询改为单次 IN 查询，1000 行只需 1 次 DB 查询。

### 3.3 批量写入

| 写入对象 | 批次大小 | 并发方式 | 代码位置 |
|---|---|---|---|
| shipments 主表 | 100 条/批 | `Promise.all` | `import-worker.ts:476-479` |
| orders 子表 | 500 条/批 | `Promise.all` | `import-worker.ts:481-485` |
| 错误明细 | 500 条/批 | 顺序写入 | `import-worker.ts:398-400` |

**关键优化**：写入从逐行 INSERT 改为批量 INSERT + Promise.all 并发，减少 DB 往返次数。

### 3.4 部分成功处理

```
validateBatch() → validRows + errors
  ├─ validRows → batchInsertOrders()
  └─ errors → persistErrors()
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
| 上传后后台 fetch | 上传接口返回前后台拉起 `/api/worker/run` | `api/import-tasks/route.ts:140` |
| 前端轮询触发 | 任务详情页每 2s 轮询时触发 Worker | `tasks/[taskId]/page.tsx:90` |
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
