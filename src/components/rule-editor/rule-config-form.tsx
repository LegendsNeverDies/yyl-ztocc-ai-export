"use client";

import { useState, useCallback } from "react";
import { Plus, ChevronDown, ChevronRight, CheckCircle, AlertCircle, HelpCircle } from "lucide-react";
import type {
  ParseRuleDraft, FieldMapping, KvEntry, KvExtractConfig,
  ExcelConfig, MatrixConfig, CardConfig, AggregateConfig, PdfConfig,
} from "@/types";

const TARGET_FIELDS = [
  "externalCode", "storeName", "receiverName", "receiverPhone",
  "receiverAddress", "skuCode", "skuName", "skuQuantity", "skuSpec", "remark",
];
const FIELD_LABELS: Record<string, string> = {
  externalCode: "外部编码", storeName: "收货门店", receiverName: "收件人姓名",
  receiverPhone: "收件人电话", receiverAddress: "收件人地址",
  skuCode: "SKU编码", skuName: "SKU名称", skuQuantity: "SKU发货数量",
  skuSpec: "SKU规格型号", remark: "备注",
};

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between">
        <h3 className="text-base font-semibold">{title}</h3>
        {open ? <ChevronDown className="h-4 w-4 text-[#86909c]" /> : <ChevronRight className="h-4 w-4 text-[#86909c]" />}
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[#86909c]">{label}</label>
      {children}
    </div>
  );
}

// AI 置信度标签：标注哪些映射是 AI 推测的
const CONFIDENCE_META: Record<string, { cls: string; Icon: typeof CheckCircle; label: string }> = {
  high: { cls: "tag-green", Icon: CheckCircle, label: "高" },
  medium: { cls: "tag-orange", Icon: AlertCircle, label: "中" },
  low: { cls: "tag-red", Icon: HelpCircle, label: "低" },
};
function ConfidenceTag({ level }: { level?: "high" | "medium" | "low" }) {
  if (!level) return <span className="text-xs text-[#c9cdd4]">—</span>;
  const m = CONFIDENCE_META[level];
  return (
    <span className={`tag ${m.cls} text-[11px]`}>
      <m.Icon className="mr-0.5 h-3 w-3" />{m.label}
    </span>
  );
}

/**
 * 规则配置表单（新建/编辑共用）。
 * 根据 parseMode 与 fileType 条件展示对应的配置区块。
 */
export function RuleConfigForm({
  rule,
  setRule,
}: {
  rule: ParseRuleDraft;
  setRule: React.Dispatch<React.SetStateAction<ParseRuleDraft>>;
}) {
  const set = useCallback(<K extends keyof ParseRuleDraft>(key: K, val: ParseRuleDraft[K]) => {
    setRule((prev) => ({ ...prev, [key]: val }));
  }, [setRule]);

  // ---- 字段映射 ----
  const addMapping = useCallback(() => {
    setRule((prev) => ({ ...prev, fieldMappings: [...prev.fieldMappings, { fromCol: 0, toField: "skuName", aiConfidence: "low" as const }] }));
  }, [setRule]);
  const updMapping = useCallback((i: number, f: keyof FieldMapping, v: unknown) => {
    setRule((prev) => { const m = [...prev.fieldMappings]; m[i] = { ...m[i], [f]: v }; return { ...prev, fieldMappings: m }; });
  }, [setRule]);
  const delMapping = useCallback((i: number) => {
    setRule((prev) => ({ ...prev, fieldMappings: prev.fieldMappings.filter((_, j) => j !== i) }));
  }, [setRule]);

  // ---- Excel 配置 ----
  const safeExcel = rule.excel ?? ({} as Partial<ExcelConfig>);
  const updExcel = useCallback((k: keyof ExcelConfig, v: unknown) => {
    setRule((prev) => ({ ...prev, excel: { ...(prev.excel ?? {} as ExcelConfig), [k]: v } }));
  }, [setRule]);

  // ---- PDF 配置 ----
  const safePdf = (rule.pdf ?? {}) as Partial<PdfConfig>;
  const updPdf = useCallback((k: keyof PdfConfig, v: unknown) => {
    setRule((prev) => ({ ...prev, pdf: { ...(prev.pdf ?? {} as PdfConfig), [k]: v } }));
  }, [setRule]);

  // ---- KV Extract ----
  const kvList = rule.kvExtract ?? [];
  const addKvGroup = useCallback(() => {
    setRule((prev) => ({ ...prev, kvExtract: [...(prev.kvExtract || []), { rows: [-1], entries: [] }] }));
  }, [setRule]);
  const updKvRows = useCallback((gi: number, raw: string) => {
    const nums = raw.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    setRule((prev) => { const g = [...(prev.kvExtract || [])]; g[gi] = { ...g[gi], rows: nums }; return { ...prev, kvExtract: g }; });
  }, [setRule]);
  const addKvEntry = useCallback((gi: number) => {
    setRule((prev) => { const g = [...(prev.kvExtract || [])]; g[gi] = { ...g[gi], entries: [...g[gi].entries, { label: "", toField: "receiverName" }] }; return { ...prev, kvExtract: g }; });
  }, [setRule]);
  const updKvEntry = useCallback((gi: number, ei: number, f: keyof KvEntry, v: unknown) => {
    setRule((prev) => { const g = [...(prev.kvExtract || [])]; const e = [...g[gi].entries]; e[ei] = { ...e[ei], [f]: v }; g[gi] = { ...g[gi], entries: e }; return { ...prev, kvExtract: g }; });
  }, [setRule]);
  const delKvEntry = useCallback((gi: number, ei: number) => {
    setRule((prev) => { const g = [...(prev.kvExtract || [])]; g[gi] = { ...g[gi], entries: g[gi].entries.filter((_, j) => j !== ei) }; return { ...prev, kvExtract: g }; });
  }, [setRule]);
  const delKvGroup = useCallback((gi: number) => {
    setRule((prev) => ({ ...prev, kvExtract: (prev.kvExtract || []).filter((_, i) => i !== gi) }));
  }, [setRule]);

  // ---- Matrix 配置 ----
  const safeMtx = (rule.matrix ?? {}) as Partial<MatrixConfig>;
  const updMtx = useCallback((k: keyof MatrixConfig, v: unknown) => {
    setRule((prev) => ({ ...prev, matrix: { ...(prev.matrix ?? {} as MatrixConfig), [k]: v } }));
  }, [setRule]);
  const mtxMappings = (safeMtx.fixedColMappings ?? []) as FieldMapping[];
  const addMtxMapping = useCallback(() => {
    setRule((prev) => ({ ...prev, matrix: { ...(prev.matrix ?? {} as MatrixConfig), fixedColMappings: [...(prev.matrix?.fixedColMappings ?? []), { fromCol: 0, toField: "skuName", aiConfidence: "medium" }] } }));
  }, [setRule]);
  const updMtxMapping = useCallback((i: number, f: keyof FieldMapping, v: unknown) => {
    setRule((prev) => { const m = [...(prev.matrix?.fixedColMappings ?? [])]; m[i] = { ...m[i], [f]: v }; return { ...prev, matrix: { ...(prev.matrix ?? {} as MatrixConfig), fixedColMappings: m } }; });
  }, [setRule]);
  const delMtxMapping = useCallback((i: number) => {
    setRule((prev) => ({ ...prev, matrix: { ...(prev.matrix ?? {} as MatrixConfig), fixedColMappings: (prev.matrix?.fixedColMappings ?? []).filter((_, j) => j !== i) } }));
  }, [setRule]);

  // ---- Card 配置 ----
  const safeCard = (rule.card ?? {}) as Partial<CardConfig>;
  const updCard = useCallback((k: keyof CardConfig, v: unknown) => {
    setRule((prev) => ({ ...prev, card: { ...(prev.card ?? {} as CardConfig), [k]: v } }));
  }, [setRule]);
  const cardMeta = (safeCard.cardMetaMappings ?? []) as KvEntry[];
  const addCardMeta = useCallback(() => {
    setRule((prev) => ({ ...prev, card: { ...(prev.card ?? {} as CardConfig), cardMetaMappings: [...(prev.card?.cardMetaMappings ?? []), { label: "", toField: "storeName" }] } }));
  }, [setRule]);
  const updCardMeta = useCallback((i: number, f: keyof KvEntry, v: unknown) => {
    setRule((prev) => { const m = [...(prev.card?.cardMetaMappings ?? [])]; m[i] = { ...m[i], [f]: v }; return { ...prev, card: { ...(prev.card ?? {} as CardConfig), cardMetaMappings: m } }; });
  }, [setRule]);
  const delCardMeta = useCallback((i: number) => {
    setRule((prev) => ({ ...prev, card: { ...(prev.card ?? {} as CardConfig), cardMetaMappings: (prev.card?.cardMetaMappings ?? []).filter((_, j) => j !== i) } }));
  }, [setRule]);
  const cardDataMappings = (safeCard.dataFieldMappings ?? []) as FieldMapping[];
  const addCardDataMapping = useCallback(() => {
    setRule((prev) => ({ ...prev, card: { ...(prev.card ?? {} as CardConfig), dataFieldMappings: [...(prev.card?.dataFieldMappings ?? []), { fromCol: 0, toField: "skuName", aiConfidence: "high" }] } }));
  }, [setRule]);
  const updCardDataMapping = useCallback((i: number, f: keyof FieldMapping, v: unknown) => {
    setRule((prev) => { const m = [...(prev.card?.dataFieldMappings ?? [])]; m[i] = { ...m[i], [f]: v }; return { ...prev, card: { ...(prev.card ?? {} as CardConfig), dataFieldMappings: m } }; });
  }, [setRule]);
  const delCardDataMapping = useCallback((i: number) => {
    setRule((prev) => ({ ...prev, card: { ...(prev.card ?? {} as CardConfig), dataFieldMappings: (prev.card?.dataFieldMappings ?? []).filter((_, j) => j !== i) } }));
  }, [setRule]);

  // ---- Aggregate 配置 ----
  const safeAgg = (rule.aggregate ?? {}) as Partial<AggregateConfig>;
  const updAgg = useCallback((k: keyof AggregateConfig, v: unknown) => {
    setRule((prev) => ({ ...prev, aggregate: { ...(prev.aggregate ?? {} as AggregateConfig), [k]: v } }));
  }, [setRule]);

  const mode = rule.parseMode;

  return (
    <div className="space-y-4">
      {/* === 基本信息 === */}
      <Section title="规则基本信息">
        <div className="grid grid-cols-2 gap-4">
          <Field label="规则名称">
            <input className="input-field" value={rule.name} onChange={(e) => set("name", e.target.value)} placeholder="例如：海口龙湖天街配送单" />
          </Field>
          <Field label="解析模式">
            <select className="input-field" value={mode} onChange={(e) => set("parseMode", e.target.value as typeof mode)}>
              <option value="standard">标准表格</option>
              <option value="aggregate">跨行聚合</option>
              <option value="matrix">矩阵转置</option>
              <option value="card">卡片识别</option>
              <option value="multi-sheet">多Sheet合并</option>
            </select>
          </Field>
          <Field label="文件类型">
            <select className="input-field" value={rule.fileType} onChange={(e) => set("fileType", e.target.value as typeof rule.fileType)}>
              <option value="excel">Excel (.xlsx/.xls)</option>
              <option value="pdf">PDF</option>
            </select>
          </Field>
        </div>
        <div className="mt-3">
          <Field label="规则描述">
            <input className="input-field" value={rule.description} onChange={(e) => set("description", e.target.value)} placeholder="描述此规则的适用场景..." />
          </Field>
        </div>
      </Section>

      {/* === Excel 布局配置（card 模式不依赖行区间，其余 Excel 模式展示） === */}
      {rule.fileType === "excel" && mode !== "card" && (
        <Section title="Excel 布局配置">
          <div className="grid grid-cols-3 gap-3">
            <Field label="数据起始行(0-based)">
              <input type="number" className="input-field" value={safeExcel.dataStartRow ?? 0} onChange={(e) => updExcel("dataStartRow", Number(e.target.value))} min={0} />
            </Field>
            <Field label="跳过底部行数">
              <input type="number" className="input-field" value={safeExcel.footerRows ?? 0} onChange={(e) => updExcel("footerRows", Number(e.target.value))} min={0} />
            </Field>
            <Field label="跳过头部行数">
              <input type="number" className="input-field" value={safeExcel.headerRows ?? 0} onChange={(e) => updExcel("headerRows", Number(e.target.value))} min={0} />
            </Field>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="跳过行号(逗号分隔, 1-based)">
              <input className="input-field" value={(safeExcel.skipRows ?? []).join(", ")} onChange={(e) => updExcel("skipRows", e.target.value.split(",").map(Number).filter((n) => n > 0))} placeholder="如: 12" />
            </Field>
            <Field label="首列包含则跳过(逗号分隔)">
              <input className="input-field" value={(safeExcel.skipIfFirstColContains ?? []).join(", ")} onChange={(e) => updExcel("skipIfFirstColContains", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder="如: 合计, 总计" />
            </Field>
          </div>
        </Section>
      )}

      {/* === PDF 配置 === */}
      {rule.fileType === "pdf" && (
        <Section title="PDF 解析配置">
          <p className="mb-3 text-xs text-[#86909c]">PDF 会按文本坐标自动对齐成表格网格，下方字段映射按对齐后的列号(0起)配置。</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="表格起始标记"><input className="input-field" value={safePdf.tableStartMarker ?? ""} onChange={(e) => updPdf("tableStartMarker", e.target.value)} placeholder="如: 物品类别" /></Field>
            <Field label="表格结束标记"><input className="input-field" value={safePdf.tableEndMarker ?? ""} onChange={(e) => updPdf("tableEndMarker", e.target.value)} placeholder="如: 合计" /></Field>
          </div>
        </Section>
      )}

      {/* === 字段映射（card 模式用卡片内数据映射，故此处隐藏） === */}
      {mode !== "card" && (
        <Section title="字段映射（数据区列→字段）">
          <div className="mb-2"><button type="button" onClick={addMapping} className="btn-outline gap-1 text-xs"><Plus className="h-3 w-3" />添加映射</button></div>
          {rule.fieldMappings.length === 0 ? (
            <p className="py-4 text-center text-sm text-[#86909c]">暂无映射，点击“添加映射”</p>
          ) : (
            <div className="table-wrapper">
              <table className="table-styled">
                <thead><tr><th style={{ width: 90 }}>列号(0起)</th><th>目标字段</th><th style={{ width: 80 }}>AI置信度</th><th style={{ width: 60 }}>操作</th></tr></thead>
                <tbody>
                  {rule.fieldMappings.map((m, i) => (
                    <tr key={i}>
                      <td><input type="number" className="input-field w-20 text-center" value={m.fromCol} onChange={(e) => updMapping(i, "fromCol", Number(e.target.value))} min={0} /></td>
                      <td>
                        <select className="input-field" value={m.toField} onChange={(e) => updMapping(i, "toField", e.target.value)}>
                          {TARGET_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
                        </select>
                      </td>
                      <td className="text-center"><ConfidenceTag level={m.aiConfidence} /></td>
                      <td><button type="button" onClick={() => delMapping(i)} className="btn-ghost text-xs text-[#cf1322]">删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* === 矩阵转置配置 === */}
      {mode === "matrix" && (
        <Section title="矩阵转置配置">
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Field label="门店表头行(0-based)"><input type="number" className="input-field" value={safeMtx.storeHeaderRow ?? 0} onChange={(e) => updMtx("storeHeaderRow", Number(e.target.value))} min={0} /></Field>
            <Field label="门店起始列(0-based)"><input type="number" className="input-field" value={safeMtx.storeStartCol ?? 0} onChange={(e) => updMtx("storeStartCol", Number(e.target.value))} min={0} /></Field>
            <Field label="门店结束列(0-based)"><input type="number" className="input-field" value={safeMtx.storeEndCol ?? 0} onChange={(e) => updMtx("storeEndCol", Number(e.target.value))} min={0} /></Field>
          </div>
          <h4 className="mb-2 text-sm font-medium text-[#4e5969]">固定列映射（SKU信息列）</h4>
          <button type="button" onClick={addMtxMapping} className="btn-outline gap-1 text-xs mb-2"><Plus className="h-3 w-3" />添加</button>
          {mtxMappings.length === 0 ? <p className="py-3 text-center text-xs text-[#86909c]">暂无</p> : (
            <div className="table-wrapper"><table className="table-styled text-xs">
              <thead><tr><th style={{ width: 80 }}>列(0起)</th><th>字段</th><th style={{ width: 70 }}>置信度</th><th style={{ width: 50 }}></th></tr></thead>
              <tbody>{mtxMappings.map((m, i) => (
                <tr key={i}>
                  <td><input type="number" className="input-field w-20 text-center text-xs" value={m.fromCol} onChange={(e) => updMtxMapping(i, "fromCol", Number(e.target.value))} min={0} /></td>
                  <td><select className="input-field text-xs" value={m.toField} onChange={(e) => updMtxMapping(i, "toField", e.target.value)}>{TARGET_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}</select></td>
                  <td className="text-center"><ConfidenceTag level={m.aiConfidence} /></td>
                  <td><button type="button" onClick={() => delMtxMapping(i)} className="btn-ghost text-xs text-[#cf1322]">删除</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Section>
      )}

      {/* === 卡片识别配置 === */}
      {mode === "card" && (
        <Section title="卡片识别配置">
          <Field label="卡片边界正则">
            <input className="input-field" value={safeCard.boundaryPattern ?? ""} onChange={(e) => updCard("boundaryPattern", e.target.value)} placeholder="如: ▶.*调拨记录" />
          </Field>
          <div className="mt-4">
            <h4 className="mb-2 text-sm font-medium text-[#4e5969]">卡片元信息KV（调入门店/收货人等）</h4>
            <button type="button" onClick={addCardMeta} className="btn-outline gap-1 text-xs mb-2"><Plus className="h-3 w-3" />添加</button>
            {cardMeta.length === 0 ? <p className="py-3 text-center text-xs text-[#86909c]">暂无</p> : (
              <div className="table-wrapper"><table className="table-styled text-xs">
                <thead><tr><th style={{ width: 130 }}>标签</th><th>字段</th><th style={{ width: 50 }}></th></tr></thead>
                <tbody>{cardMeta.map((e, i) => (
                  <tr key={i}>
                    <td><input className="input-field text-xs" value={e.label} onChange={(v) => updCardMeta(i, "label", v.target.value)} placeholder="如: 调入门店" /></td>
                    <td><select className="input-field text-xs" value={e.toField} onChange={(v) => updCardMeta(i, "toField", v.target.value)}>{TARGET_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}</select></td>
                    <td><button type="button" onClick={() => delCardMeta(i)} className="btn-ghost text-xs text-[#cf1322]">删除</button></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
          <div className="mt-4">
            <h4 className="mb-2 text-sm font-medium text-[#4e5969]">卡片内数据列映射</h4>
            <button type="button" onClick={addCardDataMapping} className="btn-outline gap-1 text-xs mb-2"><Plus className="h-3 w-3" />添加</button>
            {cardDataMappings.length === 0 ? <p className="py-3 text-center text-xs text-[#86909c]">暂无</p> : (
              <div className="table-wrapper"><table className="table-styled text-xs">
                <thead><tr><th style={{ width: 80 }}>列(0起)</th><th>字段</th><th style={{ width: 70 }}>置信度</th><th style={{ width: 50 }}></th></tr></thead>
                <tbody>{cardDataMappings.map((m, i) => (
                  <tr key={i}>
                    <td><input type="number" className="input-field w-20 text-center text-xs" value={m.fromCol} onChange={(e) => updCardDataMapping(i, "fromCol", Number(e.target.value))} min={0} /></td>
                    <td><select className="input-field text-xs" value={m.toField} onChange={(e) => updCardDataMapping(i, "toField", e.target.value)}>{TARGET_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}</select></td>
                    <td className="text-center"><ConfidenceTag level={m.aiConfidence} /></td>
                    <td><button type="button" onClick={() => delCardDataMapping(i)} className="btn-ghost text-xs text-[#cf1322]">删除</button></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </Section>
      )}

      {/* === 跨行聚合配置 === */}
      {mode === "aggregate" && (
        <Section title="跨行聚合配置">
          <div className="grid grid-cols-2 gap-3">
            <Field label="聚合列(0-based)"><input type="number" className="input-field" value={safeAgg.groupByCol ?? 1} onChange={(e) => updAgg("groupByCol", Number(e.target.value))} min={0} /></Field>
            <Field label="聚合字段">
              <select className="input-field" value={safeAgg.groupByField ?? "externalCode"} onChange={(e) => updAgg("groupByField", e.target.value)}>
                {TARGET_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
              </select>
            </Field>
          </div>
          <p className="mt-2 text-xs text-[#86909c]">同一聚合值的多行将共享(回填)收货门店、收件人、电话、地址、外部编码。</p>
        </Section>
      )}

      {/* === KV 提取配置（所有模式通用） === */}
      <Section title="KV 对提取（头部/尾部标签→值映射）" defaultOpen={!!kvList.length}>
        <p className="mb-3 text-xs text-[#86909c]">从非表格行提取键值对，如“收货人：张三”或“收货人”独立成格、值在右侧。行偏移留空=扫描所有行；正数从数据起始行偏移，负数从末尾倒数。</p>
        {kvList.length === 0 ? (
          <p className="py-4 text-center text-sm text-[#86909c]">暂无KV提取配置</p>
        ) : (
          kvList.map((group, gi) => (
            <div key={gi} className="mb-4 rounded-lg border border-[#e5e6eb] p-3">
              <div className="mb-2 flex items-center gap-3">
                <span className="text-xs font-medium text-[#4e5969]">区域 {gi + 1}</span>
                <Field label="行偏移(逗号分隔, 留空=全扫)">
                  <input className="input-field w-44 text-xs" value={(group.rows ?? []).join(", ")} onChange={(e) => updKvRows(gi, e.target.value)} placeholder="留空或 -1" />
                </Field>
                <button type="button" onClick={() => delKvGroup(gi)} className="btn-ghost ml-auto text-xs text-[#cf1322]">删除区域</button>
              </div>
              <div className="table-wrapper">
                <table className="table-styled text-xs">
                  <thead><tr><th style={{ width: 130 }}>标签文字</th><th>目标字段</th><th style={{ width: 50 }}></th></tr></thead>
                  <tbody>
                    {group.entries.map((entry, ei) => (
                      <tr key={ei}>
                        <td><input className="input-field text-xs" value={entry.label} onChange={(e) => updKvEntry(gi, ei, "label", e.target.value)} placeholder="如: 收货人" /></td>
                        <td>
                          <select className="input-field text-xs" value={entry.toField} onChange={(e) => updKvEntry(gi, ei, "toField", e.target.value)}>
                            {TARGET_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
                          </select>
                        </td>
                        <td><button type="button" onClick={() => delKvEntry(gi, ei)} className="btn-ghost text-xs text-[#cf1322]">删除</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={() => addKvEntry(gi)} className="mt-2 btn-outline text-xs gap-1"><Plus className="h-3 w-3" />添加KV条目</button>
            </div>
          ))
        )}
        <button type="button" onClick={addKvGroup} className="btn-outline text-xs gap-1"><Plus className="h-3 w-3" />添加KV区域</button>
      </Section>
    </div>
  );
}
