# 大模型使用说明

本项目（万能导入 V2）集成了大语言模型（LLM），用于**智能识别文件结构并自动生成解析规则**，让用户上传任意格式的 Excel/PDF 发货单后无需手动配置即可完成解析。

---

## 一、使用的大模型

项目通过环境变量配置大模型，**兼容两类大模型服务商**（OpenAI Chat Completions 协议兼容）：

| 服务商 | 示例模型 | 说明 |
|--------|----------|------|
| **DeepSeek**（深度求索） | `deepseek-chat` | 国产开源大模型，性价比高 |
| **StepFun**（阶跃星辰） | `step-3.7-flash` | 支持深度思考模式，推理能力强 |

> 项目代码中以 `DEEPSEEK_*` 命名环境变量（历史命名），但实际可接入上述任一服务商。代码会根据 URL 自动判断服务商并适配差异（如 `response_format`、`reasoning_content` 兜底等）。

### 环境变量配置（`.env.local`，不提交到仓库）

```bash
# 大模型 API 地址（Chat Completions 端点）
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions
# 或 StepFun: https://api.stepfun.com/v1/chat/completions

# API Key（必填，缺失会抛错；代码会自动去除首尾空格和包裹引号，避免复制粘贴导致的 401）
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx

# 模型名（必填，缺失会抛错）
DEEPSEEK_MODEL=deepseek-chat
# 或 step-3.7-flash
```

> ⚠️ 三个环境变量均**必填**，任一缺失会抛出明确的错误提示，不会静默降级。

---

## 二、大模型在项目中的作用

### 核心作用：AI 自动生成解析规则

项目的核心流程是：`上传文件 → 选择/生成解析规则 → 解析为标准化订单行 → 校验 → 预览/编辑 → 提交数据库`

大模型负责其中的**"生成解析规则"**环节：

1. 用户上传一个 Excel 或 PDF 发货单（格式未知、结构各异）
2. 前端读取文件内容，提取前 50 行 + 最后 10 行作为样本
3. 将样本发送给大模型，大模型分析文件结构（表头位置、合并单元格、矩阵布局、卡片边界、KV 散落信息等）
4. 大模型返回一个结构化的 JSON 解析规则（`ParseRule`），包含：
   - **解析模式**（`parseMode`）：`standard`（标准表格）/ `aggregate`（跨行聚合）/ `matrix`（矩阵转置）/ `card`（卡片式）/ `multi-sheet`（多 Sheet）
   - **字段映射**（`fieldMappings`）：列号 → 业务字段（如第 1 列映射为外部编码）
   - **KV 提取**（`kvExtract`）：从非表格区提取"收货人：张三"这类键值对
   - **数据区边界**：表头行、跳过行、页脚行、PDF 表格起止标记
   - **置信度分析**：每个字段映射标注 `high`/`medium`/`low` 置信度
   - **自然语言分析说明**（`suggestions`）：解释判断依据
5. 用户可在前端编辑器中查看、微调 AI 生成的规则，试解析验证后再保存

### 大模型不参与的部分

- **文件读取与解析**：在浏览器端完成（`xlsx` / `pdfjs-dist`），不经过大模型
- **数据校验**：由规则引擎 `parse-engine.ts` + `validators.ts` 完成，不经过大模型
- **数据库写入**：由 Drizzle ORM 操作 Neon Postgres，不经过大模型

---

## 三、调用链路（端到端）

```
[前端] src/app/rules/new/page.tsx
   │  用户点击"AI 分析并生成规则"按钮
   │  handleAiGenerate() → fetch POST /api/ai/analyze
   │  body: { rows: RawRow[], fileType, fileName }
   ▼
[API 路由] src/app/api/ai/analyze/route.ts
   │  解析请求参数，调用 generateRule()
   ▼
[AI 客户端] src/lib/ai-client.ts → generateRule()
   │  1. 读取环境变量 DEEPSEEK_API_URL / API_KEY / MODEL
   │  2. 构造系统提示词 SYSTEM_PROMPT（定义输出 JSON Schema 和解析规则）
   │  3. 构造用户提示词 buildSamplePrompt（前50行 + 后10行样本）
   │  4. 调用大模型 API（temperature: 0.1, max_tokens: 4096, thinking: disabled）
   │  5. 60s 超时控制（AbortController）
   │  6. 提取并解析返回的 JSON（extractJson，兼容 ```json 包裹）
   ▼
[大模型 API] DeepSeek / StepFun
   │  分析文件结构，返回 AiRuleResponse JSON
   ▼
[前端] 接收 AiRuleResponse
   │  填充规则编辑表单 + 展示 AI 分析说明 + 置信度统计
   │  用户可微调 → 试解析 → 保存到数据库 parse_rules 表
```

---

## 四、关键代码位置

| 文件 | 作用 |
|------|------|
| `src/lib/ai-client.ts` | **核心**：大模型调用封装。包含系统提示词、样本构造、API 调用、JSON 提取、错误处理 |
| `src/app/api/ai/analyze/route.ts` | API 路由：接收前端请求，调用 `generateRule()` 并返回结果 |
| `src/app/rules/new/page.tsx` | 前端页面：新建规则流程，包含"AI 分析并生成规则"按钮和交互逻辑 |
| `src/components/upload/rule-selector.tsx` | 规则选择器：提供"AI 新建规则"入口，跳转到新建规则页 |
| `src/types/index.ts` | 类型定义：`AiRuleResponse`（大模型返回结构）、`ParseRule`、`ParseRuleDraft` |

---

## 五、大模型调用参数

```typescript
{
  model: process.env.DEEPSEEK_MODEL,           // 如 "deepseek-chat" / "step-3.7-flash"
  messages: [
    { role: "system", content: SYSTEM_PROMPT }, // 定义输出格式和解析规则约束
    { role: "user", content: samplePrompt }     // 文件样本数据
  ],
  temperature: 0.1,                             // 低温度，保证输出稳定
  max_completion_tokens: 4096,                  // 限制输出长度
  thinking: { type: "disabled" },               // 禁用深度思考，加速响应
  response_format: { type: "json_object" }      // DeepSeek/StepFun 强制返回 JSON
}
```

---

## 六、返回数据结构（`AiRuleResponse`）

大模型返回的 JSON 结构如下，前端据此填充规则编辑器：

```typescript
interface AiRuleResponse {
  rule: {
    name: string;              // 规则名称
    description: string;       // 规则描述
    fileType: "excel" | "pdf";
    parseMode: "standard" | "aggregate" | "matrix" | "card" | "multi-sheet";
    excel?: { headerRows, footerRows, dataStartRow, skipRows, skipIfFirstColContains };
    pdf?: { tableStartMarker, tableEndMarker };
    fieldMappings: Array<{ fromCol: number; toField: string; aiConfidence: "high"|"medium"|"low" }>;
    aggregate?: { groupByCol, groupByField, sharedFields };
    matrix?: { storeHeaderRow, storeStartCol, storeEndCol, fixedColMappings };
    card?: { boundaryPattern, cardMetaMappings, dataFieldMappings };
    kvExtract?: Array<{ rows: number[]; entries: Array<{ label, toField }> }>;
    defaults: Record<string, string>;
  };
  suggestions: string;         // AI 自然语言分析说明
  confidenceSummary: { high: number; medium: number; low: number }; // 置信度统计
}
```

**允许的 `toField` 业务字段**（系统提示词约束）：
`externalCode`（外部编码）、`storeName`（门店名）、`receiverName`（收货人）、`receiverPhone`（收货电话）、`receiverAddress`（收货地址）、`skuCode`（SKU 编码）、`skuName`（SKU 名称）、`skuQuantity`（数量）、`skuSpec`（规格）、`remark`（备注）

---

## 七、错误处理与诊断

| 场景 | 处理方式 |
|------|----------|
| 环境变量未配置 | 抛出明确错误提示（不会静默降级） |
| API Key 复制粘贴带引号/空格 | 自动 trim 并去除首尾引号 |
| 401 鉴权失败 | 提示检查 Key 是否正确、与服务商是否匹配、Vercel 是否重新部署 |
| 60s 超时 | AbortController 中断，提示重试或检查端点可用性 |
| 返回内容为空 | 兜底读取 `message.reasoning_content`（StepFun 深度思考模式） |
| 返回非纯 JSON | `extractJson` 兼容 ```` ```json ```` 包裹、前导/尾部文本，提取首个 `{` 到末个 `}` |
| API 调用失败 | 打印诊断日志（URL、模型名、Key 长度与尾 4 位，不泄露完整 Key） |

---

## 八、使用示例

### 场景：用户上传一个陌生的 Excel 发货单

1. 进入「新建规则」页面 → 选择"上传文件 → AI 分析"
2. 上传文件（如 `demos/standard.xlsx`）
3. 点击「AI 分析并生成规则」按钮
4. 等待约 5-15 秒，大模型分析完成
5. 页面展示：
   - 自动填充的规则配置表单（解析模式、字段映射、数据区边界等）
   - AI 分析说明文字（如"该文件为标准表格，第 1 列为外部编码..."）
   - 置信度统计（如 高 5 / 中 2 / 低 0）
6. 用户点击「试解析预览」验证效果
7. 确认无误后点击「保存规则」，规则存入数据库供后续导入使用

### 场景：从首页上传文件时没有匹配规则

1. 首页上传文件 → 规则选择器中点击「AI 新建规则」
2. 文件数据通过 `sessionStorage` 传递到新建规则页（60 秒内有效）
3. 后续流程同上

---

## 九、注意事项

1. **大模型仅用于生成规则，不参与实际数据解析**：解析由本地规则引擎 `parse-engine.ts` 执行，确保解析速度和确定性。
2. **规则可人工微调**：AI 生成的规则不是最终结果，用户可在编辑器中修改任何字段，AI 的作用是降低配置门槛。
3. **成本控制**：每次 AI 调用发送的是样本数据（前 50 行 + 后 10 行），而非完整文件；`temperature: 0.1` 和 `thinking: disabled` 也有助于降低 token 消耗。
4. **服务商切换**：修改 `.env.local` 中的三个环境变量即可切换服务商，代码无需改动。在 Vercel 部署时修改环境变量后需**重新部署（Redeploy）**才能生效。
5. **数据隐私**：发送给大模型的是文件结构样本（单元格文本），不含完整业务数据。如需处理敏感数据，请评估合规风险。
