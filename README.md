# 万能导入 V2 — 异步事件驱动批量下单系统

基于 Next.js 16 App Router + TypeScript，将同步阻塞式导入链路重构为可支撑高并发的异步事件驱动架构。

## 在线访问

- **部署地址**：https://yyl-ztocc-ai-export.vercel.app/
- **源码仓库**：https://github.com/LegendsNeverDies/yyl-ztocc-ai-export

## 评分标准导向设计

本方案以考试评分标准为第一优先级，所有设计决策都围绕以下评分项展开：

| 评分项 | 方案落点 | 说明 |
|---|---|---|
| 上传即返回 | `POST /api/import-tasks` | 上传后立即创建任务并返回 `task_id`，不阻塞等待全链路完成 |
| 异步任务链路 | `import_tasks` + `import_task_batches` + `event_outbox` | 任务、批次、事件三层拆分，具备异步执行与可恢复能力 |
| 批量处理 | Worker 批量校验与批量写入 | 禁止逐行查询/逐行 INSERT，按批次处理以控制数据库压力 |
| 任务进度追踪 | `/tasks/[taskId]` + 前端轮询 | 支持实时看到 `processed_rows`、状态、错误数变化 |
| 错误定位 | `import_task_errors` + `trace_events` | 可按 task/batch/行号定位失败原因，缩短排障时间 |
| 可观测性 | `/monitor` + `/traces` | 支持监控汇总、Trace 检索、阶段耗时分析 |
| 压测自证 | `scripts/seed-data.ts` + `scripts/benchmark.ts` | 生成 20,000 SKU 主数据与 10,000 行压测文件，并给出性能报告 |
| 部署兼容性 | Worker 触发接口 + GitHub Actions 兜底 | 不依赖 Vercel Cron 的前提下，仍可持续推进任务 |

## 核心特性

- **上传即返回**：上传接口 P95 ≤ 1 秒，立即返回 `task_id`
- **异步事件驱动**：Transactional Outbox + Worker 轮询消费，不阻塞用户请求
- **批量处理**：批量 SKU 校验 + 批量 UPSERT，禁止逐行查询/写库
- **性能目标**：10,000 行导入目标在 60 秒内完成，上传接口和任务进度均可持续推进
- **全链路可观测**：traceId 贯穿 API → Outbox → Worker → DB，监控看板 + Trace 检索
- **幂等与恢复**：批次级幂等，卡死自动恢复，部分行失败不阻塞成功行
- **容灾降级**：SKU 查询超时自动降级，前端明确提示风险

## 架构概览

```
用户上传 → POST /api/import-tasks (≤1s 返回 task_id)
                ↓ (同事务)
    import_tasks + import_task_batches + event_outbox + trace_events
                ↓
    Outbox Dispatcher (标记 SENT)
                ↓
    Worker (轮询 PENDING 批次)
        ├─ 复用 V2 规则引擎解析
        ├─ 批量 SKU 校验 (IN 查询)
        ├─ 批量写入运单 (主子表)
        ├─ 错误明细写入 (行级)
        ├─ 性能日志写入
        └─ 任务状态聚合
                ↓
    前端轮询任务进度 (每 2s)
```

## 快速开始

### 1. 环境变量（`.env.local`）

```bash
DATABASE_URL=postgresql://...        # Neon Postgres 连接串
DEEPSEEK_API_URL=...                 # AI 规则生成（可选）
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-chat
EXTERNAL_API_KEY=v2-external-key-2026  # V3 调用用
WORKER_API_KEY=worker-key-2026        # Worker 触发鉴权（可选）
```

### 2. 安装与建表

```bash
npm install
npm run db:create-tables    # 创建所有表（含新增异步链路表）
npm run db:seed             # 初始化 6 个内置解析规则
```

### 3. 压测数据准备

```bash
npm run db:seed-data         # 生成 20,000 SKU + 10,000 行 Excel 压测文件
npm run db:clean-sku         # 清理压测 SKU 主数据（仅清 sku_master 表）
npm run db:clean-all         # 清理全部压测数据（运单 + 异步任务链路 + SKU）
```

生成物：
- `sku_master` 表：20,000 条 SKU 主数据（`SKU_00001` ~ `SKU_20000`）
- `test-data/10000-orders.xlsx`：10,000 行运单（含 1% 非法 SKU）
- `test-data/bench-rule.json`：配套解析规则

清理说明：
- `db:clean-sku`：仅 `TRUNCATE sku_master`，重置自增序列，适合重复灌入主数据
- `db:clean-all`：按外键依赖顺序清理全部压测产生的表（`import_task_errors` / `import_task_batches` / `batch_performance_log` / `trace_events` / `event_outbox` / `import_tasks` / `orders` / `shipments` / `sku_master`），均带 `RESTART IDENTITY CASCADE` 重置自增序列，适合压测前彻底重置环境

> 注：Windows + PowerShell 下 `npm run db:clean-sku -- --all` 的参数透传不稳定，已改用独立的 `db:clean-all` 别名，直接运行即可。

### 4. 启动开发服务器

```bash
npm run dev    # http://localhost:3000
```

### 5. 压测验证

```bash
npm run benchmark    # 上传 10,000 行文件并测量全链路耗时
```

压测报告输出到 `test-data/benchmark-report.json`。

## 功能页面

| 路径 | 说明 |
|---|---|
| `/` | 导入下单（上传文件 → 选规则 → 创建异步任务） |
| `/tasks` | 任务列表 |
| `/tasks/[taskId]` | 任务进度详情（进度、错误明细、批次性能） |
| `/monitor` | 监控看板（吞吐、积压、阶段耗时、错误分布） |
| `/traces` | Trace 检索（按 trace_id 查看时间线） |
| `/rules` | 规则管理 |
| `/orders` | 运单列表 |

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/import-tasks` | 上传文件，创建异步导入任务 |
| GET | `/api/import-tasks` | 任务列表 |
| GET | `/api/import-tasks/:taskId` | 查询任务进度 |
| GET | `/api/import-tasks/:taskId/errors` | 查询错误明细（分页、筛选） |
| GET | `/api/import-tasks/:taskId/batches` | 查询批次性能日志 |
| GET | `/api/traces/:traceId` | Trace 时间线检索 |
| GET | `/api/import-monitor/summary` | 监控聚合指标 |
| POST/GET | `/api/worker/run` | 触发 Worker（Cron 或手动） |

## 部署

### Vercel

```bash
vercel --prod
```

`vercel.json` 仅保留构建与区域配置，不再依赖 Vercel Cron：
- 区域 `hkg1`
- 构建命令 `next build`

### Worker 触发（替代 Vercel Cron）

不再依赖 Vercel Cron，改为以下两种方式组合：

1. 上传成功后立即触发一次 Worker（上传接口会后台拉起 `/api/worker/run`）
2. 任务详情页打开后，每 2 秒主动轮询并触发 Worker，加速消费
3. 若需要长期后台兜底，可使用 GitHub Actions 或外部定时器（如 cron-job.org）定时调用 `/api/worker/run`

推荐做法：在 GitHub 仓库中配置 Secrets：
- `WORKER_TRIGGER_URL`：例如 `https://你的域名/api/worker/run`
- `WORKER_API_KEY`：与服务端 `WORKER_API_KEY` 保持一致

然后由 GitHub Actions 每 5 分钟定时触发一次。仓库中已提供工作流文件 [.github/workflows/worker.yml](.github/workflows/worker.yml)。

## 数据库表

| 表名 | 说明 |
|---|---|
| `parse_rules` | 解析规则（复用） |
| `shipments` | 运单主表（复用） |
| `orders` | SKU 明细子表（复用） |
| `sku_master` | SKU 主数据（压测用） |
| `import_tasks` | 导入任务主表 |
| `import_task_batches` | 处理单元（批次）状态 |
| `import_task_errors` | 行级错误明细 |
| `event_outbox` | 本地可靠事件（Outbox） |
| `batch_performance_log` | 批次性能日志 |
| `trace_events` | 链路时间线事件 |

## 关键脚本

```bash
npm run db:create-tables    # 建表（幂等）
npm run db:seed             # 初始化解析规则
npm run db:seed-data        # 生成压测数据
npm run db:clean-sku        # 清理压测 SKU 主数据
npm run db:clean-all        # 清理全部压测数据（运单 + 异步任务链路 + SKU）
npm run benchmark           # 压测
npm run dev                 # 开发服务器
npm run build               # 生产构建
npm run lint                # 代码检查
```

## 演示访问说明

系统无鉴权，直接访问即可。以下页面均可直接打开：

| 页面 | URL | 说明 |
|---|---|---|
| 导入页 | https://yyl-ztocc-ai-export.vercel.app/ | 上传文件 → 选规则 → 创建异步任务 |
| 任务列表 | https://yyl-ztocc-ai-export.vercel.app/tasks | 查看所有任务 |
| 任务详情 | https://yyl-ztocc-ai-export.vercel.app/tasks/:taskId | 进度、错误明细、批次性能 |
| 监控看板 | https://yyl-ztocc-ai-export.vercel.app/monitor | 吞吐、积压、阶段耗时、错误分布 |
| Trace 检索 | https://yyl-ztocc-ai-export.vercel.app/traces | 按 trace_id/task_id 搜索时间线 |
| 规则管理 | https://yyl-ztocc-ai-export.vercel.app/rules | 查看解析规则 |

**演示流程**：

1. 访问导入页，上传 `test-data/10000-orders.xlsx`
2. 选择解析规则（如"标准excel导入测试"）
3. 创建任务后跳转到任务详情页，查看实时进度
4. 切换"错误明细"Tab 查看行级错误（支持按批次/错误码筛选）
5. 切换"批次性能"Tab 查看各阶段耗时
6. 访问监控看板查看吞吐、队列积压、阶段耗时 P99
7. 访问 Trace 检索页面，输入 trace_id 查看全链路时间线

## 故障模拟说明

### 1. SKU 查询超时降级

在 `import-worker.ts` 中设置 `SKU_QUERY_TIMEOUT_MS = 100`（从 3000 改为 100ms），SKU 查询会超时触发降级：

- 任务状态变为 `DEGRADED`
- 前端显示橙色警告条："SKU 主数据查询超时，已跳过 SKU 校验"
- 错误明细中 SKU 相关错误不再记录

### 2. 批次卡死恢复

手动将某个批次设为 PROCESSING 但不处理：

```sql
UPDATE import_task_batches
SET status = 'PROCESSING', locked_at = NOW() - INTERVAL '3 minutes'
WHERE task_id = 'xxx' AND unit_id = 'xxx_b0';
```

下次 Worker 运行时 `recoverStuckBatches()` 会自动重置为 PENDING。

### 3. Outbox 投递失败

手动将 event_outbox 设为 PENDING + next_retry_at 为过去时间：

```sql
UPDATE event_outbox
SET status = 'PENDING', next_retry_at = NOW() - INTERVAL '1 minute'
WHERE id = 1;
```

Dispatcher 恢复后会重新投递。

### 4. 重复上传

同一文件重复上传会创建独立任务，外部编码重复检测（E005）会标记重复行，不会产生重复运单。

### 5. Worker 触发

- 手动触发：`POST /api/worker/run`（需 Header `x-worker-api-key`）
- Cron 触发：`GET /api/worker/run`（无鉴权，便于 GitHub Actions 调用）

## 文档

- [架构设计文档](./ARCHITECTURE.md) — 异步任务流程图、Outbox、批量处理策略、数据模型
- [接口文档](./API.md) — 上传、任务查询、错误查询、Trace 查询、监控聚合
- [压测报告](./BENCHMARK_REPORT.md) — 10,000 行压测结果，证明 ≤ 60 秒
- [重构假设说明](./REFACTOR_ASSUMPTIONS.md) — 架构决策、容量推导、幂等设计、降级策略
- [AGENTS.md](./AGENTS.md) — Next.js 16 注意事项
- [CLAUDE.md](./CLAUDE.md) — V2 原始架构说明
