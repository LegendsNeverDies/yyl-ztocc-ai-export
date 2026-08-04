# V3 运单全流程管理系统 — 实施方案

## 定位
V3 独立部署，通过 HTTP API 调 V2 获取运单，覆盖 **扫描品控 → 异常上报 → 分级审批 → 执行联动** 全链路。与 V2 是两个独立 Vercel 项目。

## 技术栈（延续 V2）
Next.js 16 App Router + TS + Tailwind v4 + Drizzle ORM + Neon Postgres。复用 V2 Neon 实例，V3 表统一 `v3_` 前缀（假设文档说明物理共享/逻辑独立，部署前可换独立库）。

## 数据模型（10 表，v3_ 前缀）
1. `v3_users` — 用户与角色(operator/approver1/approver2/qc_manager)
2. `v3_waybill_snapshots` — 运单本地快照(运单号/收发件摘要/金额/同步时间/来源)
3. `v3_sync_logs` — 接口同步日志(request_id/时间/接口名/入参摘要/响应状态/耗时/错误)
4. `v3_tickets` — 异常工单(类型/状态/上报人/关联运单/来源/金额/层级/重提次数/**version 乐观锁**)
5. `v3_approval_records` — 审批记录(工单ID/审批人/层级/意见/结果)
6. `v3_compensations` — 赔付记录(**赔付方向字段** + 关联审批记录ID，可追溯)
7. `v3_inventory` — 库存(SKU/批次/数量/**锁定状态**)
8. `v3_scan_records` — 扫描记录(运单/SKU/批次/判定结果/**批次状态独立**/关联工单ID，1:N)
9. `v3_qc_rules` — 品控规则(触发条件JSON/严重度/自动建单/自动层级，**可配置**)
10. `v3_config` — 配置项(审批阈值/超时/重提上限，**可配置**)

## 状态机
- **工单**: pending → level1_reviewing → [金额超阈值] level2_reviewing → executing → done；rejected→pending(≤重提上限)；超时→升级/驳回
- **扫描批次**: scanned → qc_passed(正常出库) / qc_hold(品控暂扣) → 超时升级 / 误判快速放行 / 自动建工单
- 两套状态机通过 `scan_records.ticket_id` 关联，状态变更在**同一事务**内完成

## V2 对外 API（在 V2 项目新增，X-API-Key 鉴权）
- `GET /api/external/waybills?code=` — 校验运单存在+详情
- `GET /api/external/waybills/:id/skus` — 校验 SKU 归属
- `GET /api/external/waybills` — 列表同步
- `POST /api/external/waybills/:id/flag` — 异常标记回写(加分项)

## V3 核心库
- `db.ts` / `db-schema.ts` — 数据层
- `v2-client.ts` — V2 客户端(超时8s/重试2次/降级快照/Request ID/写 sync_logs)
- `state-machine.ts` — 双状态机
- `approval-engine.ts` — 分级审批(读 v3_config 阈值，可配置)
- `qc-engine.ts` — 品控规则引擎(读 v3_qc_rules，记录命中规则)
- `auth.ts` — 角色权限(后端校验：自批自核禁止、层级校验、品控主管快速放行)
- `server-actions.ts` — Server Actions
- `seed.ts` — 200 条工单种子

## V3 页面
- `/` 工作台(统计概览)
- `/scan` 扫描品控
- `/report` 异常上报
- `/tickets` 工单列表(筛选/分页/超时角标)
- `/tickets/[id]` 工单详情(状态历史+审批记录+赔付+库存+运单来源标注)
- `/approval` 待我审批
- `/config` 配置中心(阈值/超时/品控规则)
- `/sync` 接口同步监控
- 侧边栏导航(延续 V2 改造风格)

## 关键考点落地
- **并发冲突**: `tickets.version` 乐观锁，提交时 version 不符→"已被处理请刷新"
- **幂等**: 审批/执行前校验工单当前状态，状态已变则跳过(不重复扣库存/不重复生成赔付)
- **权限**: 上报人≠审批人(后端校验)、层级校验、品控主管快速放行校验；前端隐藏不算数
- **一致性**: 审批通过→赔付生成+库存联动+批次解锁 在事务内
- **可追溯**: `compensations.approval_id` FK、`sync_logs.request_id` 链路
- **降级**: V2 不可用时用快照展示并标注"同步于 XX 时间"
- **赔付方向**: 品控=向供应商追偿，物流=赔付客户，同表不同字段值

## 文档(强制交付物)
- `ASSUMPTIONS.md` — 9 项留白假设(阈值/超时/重提上限/异常映射/角色权限/同步策略/品控暂扣超时/品控规则阈值/品控主管边界) + 主动澄清问题清单 + 老系统二开意识
- `API_CONTRACT.md` — V3↔V2 接口文档(鉴权/超时/重试/降级/字段兼容/灰度上线/Request ID 链路)
- `README.md` — 部署/运行/架构说明

## 本次交付范围(完整骨架+核心流程)
1. 项目初始化 + 依赖 + 配置
2. 10 表 schema + drizzle push
3. V2 对外 API(4 个) + 鉴权
4. V3 V2 客户端(超时/重试/降级/Request ID/日志)
5. 双状态机 + 审批引擎 + 品控引擎
6. 9 个核心页面
7. 角色权限后端校验 + 并发乐观锁 + 幂等
8. 执行联动事务(赔付+库存+批次解锁)
9. 200 条种子数据
10. 2 份文档 + README
11. lint + build 验证

## 后续迭代(本次不做，文档标注)
- Vercel Cron 定时任务触发超时自动流转(本次用"进页懒触发"兜底)
- 离职审批人自动转交(本次提供手动转交)
- AI 辅助分类(本次留接口位)

## 风险与说明
- V2 需新增对外 API，会改动 V2 项目(必须，否则 V3 无法对接，考核 0 分)
- 复用 V2 Neon 实例 + v3_ 前缀，假设文档说明(部署前可换独立库)
- 单次会话体量大，分多轮工具调用完成
- V3 调 V2 的 URL 用环境变量 `V2_API_BASE_URL` + `V2_API_KEY`

## 实施顺序
1. 初始化 V3 项目(目录/依赖/配置/db)
2. 写 db-schema(10表) + push
3. 改 V2 加对外 API(4个)
4. V3 v2-client + 状态机 + 引擎 + 权限
5. V3 页面(工作台→扫描→上报→列表→详情→审批→配置→同步)
6. 种子数据 200 条
7. 文档(ASSUMPTIONS + API_CONTRACT + README)
8. lint + build
