"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Save, Play, ArrowLeft, Loader2, AlertCircle, FileUp, PenLine } from "lucide-react";
import { useToast } from "@/components/shared/toast";
import { parseFile } from "@/lib/parse-engine";
import { readFile } from "@/lib/file-reader";
import { validateOrders } from "@/lib/validators";
import { saveRule } from "@/lib/server-actions";
import { RuleConfigForm } from "@/components/rule-editor/rule-config-form";
import type { ParseRuleDraft, AiRuleResponse, RawRow } from "@/types";

// ----- 规则编辑器（配置表单 + AI说明 + 试解析） -----
function RuleEditor({
  rule,
  setRule,
  aiResponse,
  fileRows,
  fileName,
}: {
  rule: ParseRuleDraft;
  setRule: React.Dispatch<React.SetStateAction<ParseRuleDraft>>;
  aiResponse: AiRuleResponse | null;
  fileRows: RawRow[];
  fileName: string;
}) {
  const handleTestParse = useCallback(() => {
    try {
      const parsed = parseFile(
        { fileName, fileType: rule.fileType as "excel" | "pdf", rows: fileRows },
        rule as never
      );
      const errs = validateOrders(parsed);
      sessionStorage.setItem(
        "previewData",
        JSON.stringify({
          rows: parsed,
          errors: errs,
          fileName: `[试解析] ${fileName}`,
          ruleName: rule.name || "未命名规则",
          parseDuration: 0,
          isTestParse: true,
        })
      );
      window.open("/preview", "_blank");
    } catch (e) {
      alert("试解析失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }, [rule, fileRows, fileName]);

  return (
    <div className="space-y-4">
      <RuleConfigForm rule={rule} setRule={setRule} />

      {/* AI分析说明 */}
      {aiResponse && (
        <div className="card">
          <h3 className="mb-2 text-base font-semibold">AI分析说明</h3>
          <p className="text-sm text-[#4e5969] whitespace-pre-wrap">{aiResponse.suggestions}</p>
          <div className="mt-2 flex gap-2">
            <span className="tag tag-green">高置信度: {aiResponse.confidenceSummary.high}</span>
            <span className="tag tag-orange">中置信度: {aiResponse.confidenceSummary.medium}</span>
            <span className="tag tag-red">低置信度: {aiResponse.confidenceSummary.low}</span>
          </div>
        </div>
      )}

      {/* 试解析预览 */}
      {fileRows.length > 0 && (
        <div className="card flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">试解析预览</h3>
            <p className="mt-0.5 text-sm text-[#86909c]">用当前规则解析样例文件（{fileRows.length} 行），在新标签页查看结果，确认无误后再保存。</p>
          </div>
          <button onClick={handleTestParse} className="btn-outline gap-1.5 text-sm">
            <Play className="h-4 w-4" />
            试解析预览
          </button>
        </div>
      )}
    </div>
  );
}

// ====== 新建规则页面 ======
export default function NewRulePage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [step, setStep] = useState<"choose" | "file" | "ai" | "edit">("choose");
  const [rule, setRule] = useState<ParseRuleDraft>({
    name: "", description: "", fileType: "excel", parseMode: "standard",
    fieldMappings: [], defaults: {},
  });
  const [aiResponse, setAiResponse] = useState<AiRuleResponse | null>(null);
  const [fileRows, setFileRows] = useState<RawRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 从首页上传跳转携带的文件数据（60秒内有效）
  useEffect(() => {
    const stored = sessionStorage.getItem("newRuleFile");
    if (!stored) return;
    const data = JSON.parse(stored);
    sessionStorage.removeItem("newRuleFile");
    if (!data._timestamp || Date.now() - data._timestamp > 60_000) return;

    setFileName(data.fileName);
    setFileRows(data.rows || []);
    setRule((prev) => ({ ...prev, fileType: data.fileType || "excel", name: `解析规则 - ${data.fileName}` }));
    setStep("ai");
  }, []);

  const handleAiGenerate = useCallback(async () => {
    setAiLoading(true);
    const res = await fetch("/api/ai/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: fileRows, fileType: rule.fileType, fileName }),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || "AI分析失败", "error");
      setAiLoading(false);
      return;
    }
    const result: AiRuleResponse = await res.json();
    setAiResponse(result);
    setRule(result.rule);
    setStep("edit");
    setAiLoading(false);
    showToast("AI规则生成完成，请确认和微调", "success");
  }, [fileRows, fileName, rule.fileType, showToast]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const parsed = await readFile(file);
    setFileName(parsed.fileName);
    setFileRows(parsed.rows);
    setRule((prev) => ({ ...prev, fileType: parsed.fileType, name: `解析规则 - ${parsed.fileName}` }));
    setStep("ai");
  }, []);

  const handleSkipAi = useCallback(() => setStep("edit"), []);
  const handleManualCreate = useCallback(() => setStep("edit"), []);

  const handleSave = useCallback(async () => {
    if (!rule.name.trim()) {
      showToast("请填写规则名称", "error");
      return;
    }
    setSaving(true);
    const id = await saveRule(rule);
    setSaving(false);
    showToast(`规则已保存 (ID: ${id.slice(0, 8)})`, "success");
    router.push("/rules");
  }, [rule, router, showToast]);

  const stepLabels = ["选择方式", "上传文件", "AI分析", "编辑规则"];

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <button onClick={() => router.back()} className="btn-ghost mb-4 gap-1">
        <ArrowLeft className="h-4 w-4" />返回
      </button>

      <h1 className="text-2xl font-bold text-[#1d2129]">新建解析规则</h1>
      <p className="mt-1 text-sm text-[#86909c]">上传文件由 AI 自动生成，或手动配置全部参数</p>

      {/* 步骤指示器 */}
      <div className="mt-6 flex items-center gap-2">
        {stepLabels.map((label, i) => {
          const stepKey = ["choose", "file", "ai", "edit"][i];
          const idx = ["choose", "file", "ai", "edit"].indexOf(step);
          const isActive = i <= idx || step === "edit";
          const isCurrent = (step === "edit" && i === 3) || stepKey === step;
          return (
            <div key={stepKey} className="flex items-center gap-2">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${isCurrent ? "bg-[#0fc6c2] text-white" : isActive ? "bg-[#e8fafa] text-[#0fc6c2]" : "bg-[#f0f0f0] text-[#86909c]"}`}>
                {i + 1}
              </div>
              <span className="text-xs text-[#86909c]">{label}</span>
              {i < 3 && <div className="h-px w-8 bg-[#e5e6eb]" />}
            </div>
          );
        })}
      </div>

      {/* Step 1: 选择创建方式 */}
      {step === "choose" && (
        <div className="mt-6 grid grid-cols-2 gap-4">
          <button onClick={() => setStep("file")} className="card hover:border-[#0fc6c2] transition-colors text-left">
            <FileUp className="h-10 w-10 text-[#0fc6c2] opacity-70" />
            <h3 className="mt-3 text-base font-semibold text-[#1d2129]">上传文件 → AI 分析</h3>
            <p className="mt-1 text-sm text-[#86909c]">上传 Excel/PDF 出库单，AI 自动识别结构并生成解析规则</p>
          </button>
          <button onClick={handleManualCreate} className="card hover:border-[#0fc6c2] transition-colors text-left">
            <PenLine className="h-10 w-10 text-[#0fc6c2] opacity-70" />
            <h3 className="mt-3 text-base font-semibold text-[#1d2129]">手动创建规则</h3>
            <p className="mt-1 text-sm text-[#86909c]">自行配置字段映射、解析模式等全部参数，无需上传文件</p>
          </button>
        </div>
      )}

      {/* Step 2: 上传文件 */}
      {step === "file" && (
        <div className="card mt-6">
          <label className="drop-zone block cursor-pointer">
            <input type="file" accept=".xlsx,.xls,.pdf" onChange={handleFileUpload} className="hidden" />
            <Sparkles className="mx-auto h-12 w-12 text-[#0fc6c2] opacity-60" />
            <p className="mt-3 text-base font-medium">点击上传文件，让 AI 分析结构</p>
            <p className="mt-1 text-sm text-[#86909c]">支持 Excel / PDF 格式</p>
          </label>
          <div className="mt-4 pt-4 border-t border-[#e5e6eb]">
            <button onClick={handleSkipAi} className="btn-outline gap-1 text-sm">
              <PenLine className="h-4 w-4" />跳过 AI，手动配置
            </button>
          </div>
        </div>
      )}

      {/* Step 3: AI分析 */}
      {step === "ai" && (
        <div className="card mt-6">
          <div className="alert alert-info mb-4">
            <AlertCircle className="inline-block h-4 w-4" />
            <span className="ml-2 text-sm">文件已就绪：{fileName}（{fileRows.length} 行），点击下方按钮让 AI 分析文件结构并自动生成解析规则。</span>
          </div>
          {aiLoading ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#0fc6c2]" />
              <p className="mt-3 text-sm text-[#86909c]">AI 正在分析文件结构，请稍候...</p>
            </div>
          ) : (
            <div className="space-y-4 text-center">
              <button onClick={handleAiGenerate} className="btn-primary gap-2 text-base px-8 py-3">
                <Sparkles className="h-5 w-5" />AI 分析并生成规则
              </button>
              <div>
                <button onClick={handleSkipAi} className="btn-ghost gap-1 text-sm">
                  <PenLine className="h-4 w-4" />跳过 AI，手动配置
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 4: 编辑规则 */}
      {step === "edit" && (
        <div className="mt-6">
          <RuleEditor rule={rule} setRule={setRule} aiResponse={aiResponse} fileRows={fileRows} fileName={fileName} />
          <div className="mt-4 flex gap-3">
            <button onClick={handleSave} disabled={saving} className="btn-primary gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "保存中..." : "保存规则"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
