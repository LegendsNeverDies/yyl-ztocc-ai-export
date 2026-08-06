# 接口文档

## 1. 上传接口（二步上传方案）

系统采用 **二步上传**（Two-Step Upload）流程，将"创建任务"与"上传文件"解耦：前端先在浏览器内预扫描文件拿到 `total_rows`，第一步仅提交元数据，服务端 1 秒内即可返回 `task_id` 与 `upload_url`；第二步前端在后台异步上传文件，用户立即跳转至任务进度页，无需等待文件传输完成。

> 兼容旧路径：若请求不携带 `total_rows`，则回退为旧的"一步上传"——服务端读取并解析文件后再创建任务，会阻塞请求。

### 1.1 第一步：创建任务（仅元数据）

#### POST /api/import-tasks

提交文件元数据（不含 file），预创建任务与批次/Outbox，立即返回 `task_id` 和文件上传端点 `upload_url`。

**请求**：

- Content-Type: `multipart/form-data`
- Body：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file_name` | string | 二步上传必填 | 文件名（前端从本地 File 对象取） |
| `file_type` | string | 否 | `excel` 或 `pdf`，默认 `excel` |
| `rule_id` | string | 是 | 解析规则 ID |
| `total_rows` | number | 二步上传必填 | 前端预扫描得到的总行数（用于切分批次） |
| `batch_size` | number | 否 | 批次大小（默认 1000，范围 250~2000） |

> 兼容字段：仍可直接传 `file`（File）走旧路径，此时不传 `total_rows`。

**示例（二步上传第一步）**：

```bash
curl -X POST https://yyl-ztocc-ai-export.vercel.app/api/import-tasks \
  -F "file_name=10000-orders.xlsx" \
  -F "file_type=excel" \
  -F "rule_id=0f143f51-fcfe-481c-baaa-f935d5fdff80" \
  -F "total_rows=10000" \
  -F "batch_size=1000"
```

**响应**（200 OK）：

```json
{
  "task_id": "746c54cb-56b5-4afa-bd49-7fac77fe8204",
  "trace_id": "trace_232136ad4cd7401b87e70016",
  "status": "PENDING",
  "total_rows": 10000,
  "total_batches": 10,
  "upload_url": "https://yyl-ztocc-ai-export.vercel.app/api/import-tasks/746c54cb-56b5-4afa-bd49-7fac77fe8204/upload"
}
```

> 前端拿到 `task_id` 与 `upload_url` 后应立即跳转至 `/tasks/:taskId`，并在后台异步向 `upload_url` 发起第二步文件上传，不等待其完成。

**错误响应**（400）：

```json
{ "error": "缺少 file 或 total_rows 字段" }
{ "error": "缺少 rule_id 字段" }
{ "error": "规则 <rule_id> 不存在" }
```

---

### 1.2 第二步：上传文件

#### POST /api/import-tasks/:taskId/upload

将文件本身上传至第一步返回的 `upload_url`，服务端读取并解析文件、按批切片重建批次/Outbox/解析切片，任务状态从 `PENDING` 推进至 `PROCESSING`，并触发一次后台 Worker 消费。

**请求**：

- Content-Type: `multipart/form-data`
- Body：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | File | 是 | 真正的 Excel/PDF 文件二进制 |

**示例**：

```bash
curl -X POST "https://yyl-ztocc-ai-export.vercel.app/api/import-tasks/746c54cb-56b5-4afa-bd49-7fac77fe8204/upload" \
  -F "file=@test-data/10000-orders.xlsx"
```

**响应**（200 OK）：

```json
{
  "ok": true,
  "task_id": "746c54cb-56b5-4afa-bd49-7fac77fe8204"
}
```

**错误响应**：

| 状态码 | 错误 | 场景 |
|---|---|---|
| 400 | `缺少 file 字段` | 未携带文件 |
| 404 | `任务 <taskId> 不存在` | 第一步任务未创建或已被删除 |
| 404 | `规则 <ruleId> 不存在` | 关联规则被删除 |
| 500 | `上传失败` | 文件解析或事务失败 |

> 容错说明：若第二步上传失败或超时，第一步创建的任务仍以 `PENDING` 状态保留于 `import_tasks`（`file_data` 为空），监控页将出现"积压但无文件"的 PENDING 任务。运维可重新向同一 `upload_url` 发起上传，或手动将任务标记为 `FAILED`。

---

## 2. 任务查询接口

### GET /api/import-tasks

获取任务列表。

**查询参数**：

| 参数 | 类型 | 说明 |
|---|---|---|
| `page` | number | 页码（默认 1） |
| `page_size` | number | 每页条数（默认 20） |
| `status` | string | 状态筛选（PENDING/PROCESSING/COMPLETED/PARTIAL_SUCCESS/FAILED） |

**响应**：

```json
{
  "rows": [
    {
      "task_id": "746c54cb-...",
      "trace_id": "trace_232136...",
      "status": "COMPLETED",
      "total_rows": 10000,
      "processed_rows": 10000,
      "success_rows": 7959,
      "failed_rows": 2041,
      "total_batches": 11,
      "completed_batches": 11,
      "throughput": 200,
      "created_at": "2026-08-06T15:18:55Z",
      "started_at": "2026-08-06T15:18:56Z",
      "completed_at": "2026-08-06T15:19:07Z"
    }
  ],
  "total": 1
}
```

### GET /api/import-tasks/:taskId

获取单个任务详情。

**响应**：

```json
{
  "task_id": "746c54cb-...",
  "trace_id": "trace_232136...",
  "status": "COMPLETED",
  "total_rows": 10000,
  "processed_rows": 10000,
  "success_rows": 7959,
  "failed_rows": 2041,
  "total_batches": 11,
  "completed_batches": 11,
  "throughput": 200,
  "degraded": false,
  "created_at": "2026-08-06T15:18:55Z",
  "started_at": "2026-08-06T15:18:56Z",
  "completed_at": "2026-08-06T15:19:07Z"
}
```

### GET /api/import-tasks/:taskId/batches

获取批欠性能日志。

**响应**：

```json
{
  "rows": [
    {
      "unit_id": "746c54cb_b0",
      "batch_index": 0,
      "row_count": 1000,
      "success_count": 987,
      "failed_count": 13,
      "parse_duration_ms": 1866,
      "rule_duration_ms": 37,
      "validate_duration_ms": 858,
      "insert_duration_ms": 1598,
      "total_duration_ms": 4559,
      "status": "COMPLETED"
    }
  ]
}
```

---

## 3. 错误查询接口

### GET /api/import-tasks/:taskId/errors

获取行级错误明细，支持按批次/错误码筛选和分页。

**查询参数**：

| 参数 | 类型 | 说明 |
|---|---|---|
| `batch` | number | 批次号筛选 |
| `error_code` | string | 错误码筛选（E001~E008） |
| `page` | number | 页码（默认 1） |
| `page_size` | number | 每页条数（默认 50） |

**示例**：

```
GET /api/import-tasks/746c54cb.../errors?batch=4&error_code=E001&page=1&page_size=50
```

**响应**：

```json
{
  "rows": [
    {
      "id": 123,
      "task_id": "746c54cb-...",
      "unit_id": "746c54cb_b4",
      "batch_index": 4,
      "row_number": 4001,
      "field_name": "skuCode",
      "raw_value": "SKU_99999",
      "error_code": "E001",
      "error_reason": "SKU\"SKU_99999\"在主数据中不存在",
      "trace_id": "trace_232136...",
      "created_at": "2026-08-06T15:19:00Z"
    }
  ],
  "total": 67
}
```

**错误码定义**：

| 错误码 | 名称 | 说明 |
|---|---|---|
| E001 | SKU_NOT_EXIST | SKU 在主数据中不存在 |
| E002 | REQUIRED_MISSING | 必填字段缺失 |
| E003 | PHONE_FORMAT | 电话格式不正确 |
| E004 | QTY_NOT_POSITIVE | 数量非正数 |
| E005 | EXTERNAL_CODE_DUP | 外部编码重复 |
| E006 | RULE_MAP_FAILED | 规则映射失败 |
| E007 | DB_INSERT_FAILED | 数据库写入失败 |
| E008 | FILE_FORMAT | 文件格式错误 |

---

## 4. Trace 查询接口

### GET /api/traces/:traceId

按 trace_id 查询链路时间线。

**响应**：

```json
{
  "trace_id": "trace_232136...",
  "events": [
    {
      "id": 1,
      "trace_id": "trace_232136...",
      "event_name": "ImportTaskCreated",
      "aggregate_id": "746c54cb-...",
      "payload": { "task_id": "746c54cb-...", "total_rows": 10000 },
      "occurred_at": "2026-08-06T15:18:55Z"
    },
    {
      "id": 2,
      "event_name": "ImportBatchStarted",
      "occurred_at": "2026-08-06T15:18:56Z"
    },
    {
      "id": 3,
      "event_name": "ImportBatchSucceeded",
      "occurred_at": "2026-08-06T15:19:00Z"
    },
    {
      "id": 4,
      "event_name": "ImportTaskCompleted",
      "occurred_at": "2026-08-06T15:19:07Z"
    }
  ]
}
```

### GET /api/traces/search

多条件搜索 Trace 事件和错误明细。

**查询参数**：

| 参数 | 类型 | 说明 |
|---|---|---|
| `trace_id` | string | Trace ID |
| `task_id` | string | 任务 ID |
| `file_name` | string | 文件名（模糊匹配） |
| `batch_index` | number | 批次号 |
| `row_start` | number | 起始行号 |
| `row_end` | number | 结束行号 |
| `error_code` | string | 错误码 |
| `page` | number | 页码 |
| `page_size` | number | 每页条数 |

**示例**：

```
GET /api/traces/search?task_id=746c54cb...&error_code=E001&page=1&page_size=20
```

**响应**：

```json
{
  "rows": [
    {
      "type": "trace",
      "trace_id": "trace_232136...",
      "event_name": "ImportBatchStarted",
      "occurred_at": "2026-08-06T15:18:56Z",
      "task_id": "746c54cb-..."
    },
    {
      "type": "error",
      "trace_id": "trace_232136...",
      "row_number": 4001,
      "field_name": "skuCode",
      "error_code": "E001",
      "error_reason": "SKU\"SKU_99999\"在主数据中不存在",
      "task_id": "746c54cb-..."
    }
  ],
  "total": 67
}
```

---

## 5. 监控聚合接口

### GET /api/import-monitor/summary

获取监控看板聚合数据。

**响应**：

```json
{
  "throughput": [
    { "minute": "15:18", "success_rows": 2000 },
    { "minute": "15:19", "success_rows": 5959 }
  ],
  "queue_backlog": {
    "pending_batches": 0,
    "pending_rows": 0,
    "status": "ok"
  },
  "stage_duration": [
    { "stage": "解析", "p50": 1869, "p95": 2079, "p99": 2083 },
    { "stage": "规则", "p50": 20, "p95": 37, "p99": 37 },
    { "stage": "校验", "p50": 949, "p95": 2546, "p99": 2601 },
    { "stage": "写入", "p50": 1560, "p95": 1630, "p99": 1639 }
  ],
  "error_distribution": [
    { "error_code": "E005", "count": 1974, "reason": "外部编码重复" },
    { "error_code": "E001", "count": 67, "reason": "SKU 不存在" }
  ],
  "slow_batches": [
    {
      "unit_id": "746c54cb_b4",
      "total_duration_ms": 4905,
      "row_count": 1000,
      "status": "COMPLETED"
    }
  ],
  "failed_tasks": [
    {
      "task_id": "xxx-...",
      "status": "FAILED",
      "failed_rows": 1000,
      "created_at": "2026-08-06T15:10:00Z"
    }
  ],
  "debug_message": null,
  "debug_details": null
}
```

**字段说明**：

| 字段 | 说明 |
|---|---|
| `throughput` | 近 5 分钟每分钟成功入库行数 |
| `queue_backlog` | 队列积压（pending_batches/pending_rows/status） |
| `stage_duration` | 各阶段 P50/P95/P99 耗时（`percentile_cont` 聚合） |
| `error_distribution` | 错误码分布（近 1 小时） |
| `slow_batches` | 慢批次 TOP 10（按 total_duration_ms 倒序） |
| `failed_tasks` | 最近失败/部分成功任务（TOP 10） |
| `debug_message` | 查询失败时的调试信息 |

**队列积压状态**：

| status | 条件 |
|---|---|
| `ok` | pending_rows < 5000 |
| `warning` | pending_rows >= 5000 |
| `critical` | pending_rows >= 20000 |

---

## 6. Worker 触发接口

### POST /api/worker/run

触发 Worker 处理待处理批次。

**请求**：

- Header: `x-worker-api-key: worker-key-2026`（可选，与服务端 `WORKER_API_KEY` 一致）

**响应**：

```json
{
  "dispatched": 11,
  "processed": 4,
  "recovered": 0,
  "duration_ms": 8500
}
```

### GET /api/worker/run

同 POST，支持 GET 便于 Cron 调用（无鉴权）。

---

## 7. 外部 API（V3 调用）

### GET /api/external/waybills

获取运单列表。

- Header: `x-api-key: v2-external-key-2026`

### GET /api/external/waybills/:code

获取单个运单详情。

### GET /api/external/waybills/:code/skus

获取运单 SKU 明细。

### POST /api/external/waybills/:code/flag

标记运单状态。
