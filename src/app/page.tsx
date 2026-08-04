"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { FileUploadZone } from "@/components/upload/file-upload-zone";
import { RuleSelector } from "@/components/upload/rule-selector";
import { ProgressBar } from "@/components/shared/progress-bar";
import { useToast } from "@/components/shared/toast";
import { readFile } from "@/lib/file-reader";
import { getAllRules } from "@/lib/server-actions";
import type { ParsedFile, ParseRule, ParseProgress } from "@/types";
import { Sparkles, FileText, Database, Check, ArrowRight, Zap } from "lucide-react";

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
  const [submitting, setSubmitting] = useState(false);

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

  const handleSelectRule = useCallback((rule: ParseRule) => {
    setSelectedRule(rule);
  }, []);

  // 提交：创建异步导入任务，跳转任务进度页
  const handleCreateTask = useCallback(async () => {
    if (!file || !selectedRule) return;
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("rule_id", selectedRule.id);
      formData.append("batch_size", "1000");

      const res = await fetch("/api/import-tasks", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `创建任务失败 (${res.status})`);
      }
      const data = await res.json();
      showToast(`任务已创建：${data.total_rows} 行，${data.total_batches} 个批次`, "success");
      // 跳转任务进度页
      router.push(`/tasks/${data.task_id}`);
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : "创建任务失败", "error");
    } finally {
      setSubmitting(false);
    }
  }, [file, selectedRule, router, showToast]);

  const steps = [
    { key: "upload", label: "上传文件", desc: "Excel / PDF 出库单" },
    { key: "rule", label: "选择规则", desc: "已有规则或 AI 新建" },
    { key: "submit", label: "创建任务", desc: "异步处理，实时进度" },
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
              <Zap className="h-4 w-4 text-[#0fc6c2]" />
              <h2 className="text-sm font-semibold text-[#1d2129]">异步事件驱动</h2>
            </div>
            <div className="space-y-2.5 text-xs text-[#4e5969]">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-[10px] font-bold text-[#0fc6c2]">1</span>
                <span>上传文件后 1 秒内返回 task_id，不阻塞等待</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-[10px] font-bold text-[#0fc6c2]">2</span>
                <span>后台 Worker 分批处理，批量校验 SKU 与写入</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-[10px] font-bold text-[#0fc6c2]">3</span>
                <span>任务进度页实时展示处理进度、错误明细、性能</span>
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
            <p className="mt-2 text-sm text-[#86909c]">异步事件驱动批量下单系统 —— 上传即返回，全链路可观测</p>
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
                onSelectRule={handleSelectRule}
                loading={loading}
              />
            </div>
          )}

          {/* 步骤三：创建任务 */}
          {selectedRule && (
            <div className="card animate-fade-in">
              <div className="mb-4 flex items-center gap-2">
                <Zap className="h-5 w-5 text-[#0fc6c2]" />
                <h2 className="text-base font-semibold text-[#1d2129]">步骤三：创建异步导入任务</h2>
              </div>
              <div className="space-y-3">
                <div className="rounded-md bg-[#f7f8fa] p-3 text-sm text-[#4e5969]">
                  <div className="flex justify-between py-1">
                    <span className="text-[#86909c]">文件</span>
                    <span className="font-medium text-[#1d2129]">{file?.name}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-[#86909c]">规则</span>
                    <span className="font-medium text-[#1d2129]">{selectedRule.name}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-[#86909c]">总行数</span>
                    <span className="font-medium text-[#1d2129]">{parsedFile?.rows.length ?? 0} 行</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-[#86909c]">批次大小</span>
                    <span className="font-medium text-[#1d2129]">1000 行/批</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-[#86909c]">预计批次</span>
                    <span className="font-medium text-[#1d2129]">{Math.max(1, Math.ceil((parsedFile?.rows.length ?? 0) / 1000))} 个</span>
                  </div>
                </div>
                <button
                  onClick={handleCreateTask}
                  disabled={submitting}
                  className="btn-primary w-full"
                >
                  {submitting ? "正在创建任务..." : "创建导入任务"}
                  {!submitting && <ArrowRight className="ml-1 inline-block h-4 w-4" />}
                </button>
                <p className="text-center text-xs text-[#86909c]">
                  创建后立即返回 task_id，后台异步处理，可在任务进度页查看实时进度
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
