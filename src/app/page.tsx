"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { FileUploadZone } from "@/components/upload/file-upload-zone";
import { RuleSelector } from "@/components/upload/rule-selector";
import { ProgressBar } from "@/components/shared/progress-bar";
import { useToast } from "@/components/shared/toast";
import { readFile } from "@/lib/file-reader";
import { parseFile } from "@/lib/parse-engine";
import { validateOrders, checkExternalCodeDuplicates, checkReceiverConsistency } from "@/lib/validators";
import { getAllRules, getExistingExternalCodes } from "@/lib/server-actions";
import type { ParsedFile, ParseRule, OrderRow, ParseProgress } from "@/types";
import { Sparkles, FileText, Database, Check, ArrowRight } from "lucide-react";

export default function HomePage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [parsedFile, setParsedFile] = useState<ParsedFile | null>(null);
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [selectedRule, setSelectedRule] = useState<ParseRule | null>(null);
  const [progress, setProgress] = useState<ParseProgress>({
    current: 0,
    total: 0,
    percent: 0,
    status: "idle",
  });
  const [loading, setLoading] = useState(false);

  const resetUpload = useCallback(() => {
    setFile(null);
    setParsedFile(null);
    setSelectedRule(null);
    setProgress({ current: 0, total: 0, percent: 0, status: "idle" });
  }, []);

  const handleFileSelected = useCallback(async (file: File) => {
    setFile(file);
    setSelectedRule(null);
    setParsedFile(null);
    setProgress({ current: 0, total: 1, percent: 10, status: "parsing" });

    try {
      const parsed = await readFile(file);
      setParsedFile(parsed);
      setProgress({ current: 1, total: 1, percent: 50, status: "parsing" });

      const rulesList = await getAllRules();
      setRules(rulesList);
      setProgress({ current: 1, total: 1, percent: 100, status: "done" });
    } catch (err) {
      console.error(err);
      showToast("文件读取失败，请检查文件格式", "error");
      setProgress({ current: 0, total: 0, percent: 0, status: "error" });
    }
  }, [showToast]);

  const handleParseWithRule = useCallback(async (rule: ParseRule) => {
    if (!parsedFile) return;
    setSelectedRule(rule);
    setLoading(true);
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // 阶段1：解析
    setProgress({ current: 0, total: parsedFile.rows.length, percent: 15, status: "parsing" });
    await tick();
    const startTime = performance.now();
    const orderRows = parseFile(parsedFile, rule);
    const duration = performance.now() - startTime;

    // 阶段2：本地校验
    setProgress({ current: orderRows.length, total: orderRows.length, percent: 60, status: "parsing" });
    await tick();
    const validationErrors = validateOrders(orderRows);
    const consistencyErrors = checkReceiverConsistency(orderRows);

    // 阶段3：数据库重复检测（仅查本批涉及的编码）
    setProgress({ current: orderRows.length, total: orderRows.length, percent: 85, status: "parsing" });
    const codes = Array.from(new Set(orderRows.map((r) => r.externalCode?.trim()).filter(Boolean) as string[]));
    const existingCodes = await getExistingExternalCodes(codes).catch(() => new Set<string>());
    const dupErrors = checkExternalCodeDuplicates(orderRows, existingCodes);
    const allErrors = [...validationErrors, ...consistencyErrors, ...dupErrors];

    // 完成
    setProgress({ current: orderRows.length, total: orderRows.length, percent: 100, status: "done" });

    sessionStorage.setItem(
      "previewData",
      JSON.stringify({
        rows: orderRows,
        errors: allErrors,
        fileName: parsedFile.fileName,
        ruleName: rule.name,
        parseDuration: Math.round(duration),
      })
    );

    showToast(`解析完成：${orderRows.length} 条记录，${allErrors.length} 处错误`, allErrors.length ? "info" : "success");
    setLoading(false);

    router.push("/preview");
  }, [parsedFile, router, showToast]);

  const steps = [
    { key: "upload", label: "上传文件", desc: "Excel / PDF 出库单" },
    { key: "rule", label: "选择规则", desc: "已有规则或 AI 新建" },
    { key: "preview", label: "预览提交", desc: "编辑后一键下单" },
  ];
  const stepStatus = (key: string): "done" | "current" | "upcoming" => {
    if (key === "upload") return parsedFile ? "done" : "current";
    if (key === "rule") return selectedRule ? "done" : parsedFile ? "current" : "upcoming";
    return selectedRule ? "current" : "upcoming";
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="grid gap-6 lg:grid-cols-[248px_1fr]">
        {/* 左栏：步骤导航 + 快速指引 */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="card !p-5">
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[#0fc6c2]" />
              <h2 className="text-sm font-semibold text-[#1d2129]">操作步骤</h2>
            </div>
            <ol className="relative">
              {steps.map((s, i) => {
                const status = stepStatus(s.key);
                const isLast = i === steps.length - 1;
                return (
                  <li key={s.key} className="timeline-node pb-5 last:pb-0">
                    {!isLast && (
                      <span className={`timeline-line ${status === "done" ? "active" : ""}`} />
                    )}
                    <span
                      className={`relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        status === "done"
                          ? "bg-[#0fc6c2] text-white"
                          : status === "current"
                          ? "border-2 border-[#0fc6c2] bg-white text-[#0fc6c2]"
                          : "border border-[#e5e6eb] bg-white text-[#86909c]"
                      }`}
                    >
                      {status === "done" ? <Check className="h-4 w-4" /> : i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${status === "upcoming" ? "text-[#86909c]" : "text-[#1d2129]"}`}>
                        {s.label}
                      </p>
                      <p className="text-xs text-[#86909c]">{s.desc}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="card !p-5">
            <div className="mb-3 flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-[#0fc6c2]" />
              <h2 className="text-sm font-semibold text-[#1d2129]">快速开始</h2>
            </div>
            <div className="space-y-2.5 text-xs text-[#4e5969]">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-[10px] font-bold text-[#0fc6c2]">1</span>
                <span>上传任意格式的出库单文件，支持拖拽或点击上传</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-[10px] font-bold text-[#0fc6c2]">2</span>
                <span>选择已有规则，或新建规则让 AI 自动分析结构</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-[10px] font-bold text-[#0fc6c2]">3</span>
                <span>预览解析结果，在线编辑修正后一键提交</span>
              </div>
            </div>
          </div>
        </aside>

        {/* 右栏：工作区 */}
        <section className="space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-[#1d2129]">
              <Sparkles className="mr-2 inline-block h-7 w-7 text-[#0fc6c2]" />
              万能导入 V2
            </h1>
            <p className="mt-2 text-sm text-[#86909c]">智能多格式批量下单系统 —— 上传文件，AI 自动解析，一键下单</p>
          </div>

          {/* 步骤一：上传 */}
          <div className="card">
            <div className="mb-4 flex items-center gap-2">
              <FileText className="h-5 w-5 text-[#0fc6c2]" />
              <h2 className="text-base font-semibold text-[#1d2129]">步骤一：上传文件</h2>
              {parsedFile && (
                <button onClick={resetUpload} className="btn-ghost ml-auto text-xs">
                  重新上传
                </button>
              )}
            </div>
            {!parsedFile ? (
              <>
                <FileUploadZone onFileSelected={handleFileSelected} disabled={loading} />
                {progress.status === "parsing" && (
                  <div className="mt-3">
                    <ProgressBar percent={progress.percent} label="正在读取文件..." />
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 rounded-md bg-[#e8fafa] px-3 py-2.5 text-sm text-[#0b6e6e]">
                <FileText className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{file?.name}</span>
                <span className="flex-shrink-0 text-[#86909c]">({parsedFile.rows.length} 行数据)</span>
              </div>
            )}
          </div>

          {/* 步骤二：选规则 */}
          {parsedFile && (
            <div className="card animate-fade-in">
              <div className="mb-4 flex items-center gap-2">
                <Database className="h-5 w-5 text-[#0fc6c2]" />
                <h2 className="text-base font-semibold text-[#1d2129]">步骤二：选择解析规则</h2>
              </div>
              <RuleSelector
                rules={rules}
                selectedRule={selectedRule}
                parsedFile={parsedFile}
                onSelectRule={handleParseWithRule}
                loading={loading}
              />
              {loading && (
                <div className="mt-4">
                  <ProgressBar
                    percent={progress.percent}
                    label={`正在解析... ${progress.current}/${progress.total}`}
                  />
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
