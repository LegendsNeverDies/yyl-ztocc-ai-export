"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useToast } from "@/components/shared/toast";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Loader2, CheckCircle2, AlertCircle, XCircle, Clock, FileText,
  TrendingUp, AlertTriangle, Download, RefreshCw, Activity
} from "lucide-react";
import type { ImportTaskProgress, ImportTaskErrorRow, BatchPerformanceRow, ERROR_CODES as _EC } from "@/types";
import { ERROR_CODE_LABELS } from "@/types";
import { cn } from "@/lib/utils";

const STATUS_META: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  PENDING: { label: "等待处理", color: "#86909c", icon: Clock },
  PROCESSING: { label: "处理中", color: "#0fc6c2", icon: Loader2 },
  COMPLETED: { label: "全部成功", color: "#00b42c", icon: CheckCircle2 },
  PARTIAL_SUCCESS: { label: "部分成功", color: "#ff7d00", icon: AlertCircle },
  FAILED: { label: "失败", color: "#f53f3f", icon: XCircle },
};

export default function TaskDetailPage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params.taskId;
  const { showToast } = useToast();

  const [progress, setProgress] = useState<ImportTaskProgress | null>(null);
  const [errors, setErrors] = useState<ImportTaskErrorRow[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [batches, setBatches] = useState<BatchPerformanceRow[]>([]);
  const [errorFilter, setErrorFilter] = useState<{ batch?: number; errorCode?: string; page: number }>({ page: 1 });
  const [activeTab, setActiveTab] = useState<"progress" | "errors" | "batches">("progress");
  const [loading, setLoading] = useState(true);

  // 拉取进度
  const fetchProgress = useCallback(async () => {
    try {
      const res = await fetch(`/api/import-tasks/${taskId}`);
      if (!res.ok) return;
      const data: ImportTaskProgress = await res.json();
      setProgress(data);
      // 任务进行中时，同时轻量触发 Worker（加速消费，让进度 ≤2 秒可见变化）
      if (data.status === "PENDING" || data.status === "PROCESSING") {
        fetch("/api/worker/run", { method: "POST" }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, [taskId]);

  // 拉取错误
  const fetchErrors = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(errorFilter.page), page_size: "50" });
      if (errorFilter.batch != null) params.set("batch", String(errorFilter.batch));
      if (errorFilter.errorCode) params.set("error_code", errorFilter.errorCode);
      const res = await fetch(`/api/import-tasks/${taskId}/errors?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setErrors(data.rows || []);
      setErrorTotal(data.total || 0);
    } catch {
      /* ignore */
    }
  }, [taskId, errorFilter]);

  // 拉取批次
  const fetchBatches = useCallback(async () => {
    try {
      const res = await fetch(`/api/import-tasks/${taskId}/batches`);
      if (!res.ok) return;
      const data = await res.json();
      setBatches(data.rows || []);
    } catch {
      /* ignore */
    }
  }, [taskId]);

  // 初始加载 + 轮询
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = async () => {
      await fetchProgress();
      if (stopped) return;
      // 进行中每 2 秒轮询；完成则停止
      // 通过 ref 读取最新状态
      if (latestStatus.current === "PENDING" || latestStatus.current === "PROCESSING" || latestStatus.current === "") {
        timer = setTimeout(poll, 2000);
      }
    };
    poll();
    setLoading(false);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchProgress]);

  // 保持最新 status 的 ref，供轮询判断
  const latestStatus = useRef<string>("");
  useEffect(() => {
    latestStatus.current = progress?.status ?? "";
  }, [progress]);

  // 切换 tab 时拉取对应数据
  useEffect(() => {
    if (activeTab === "errors") fetchErrors();
    if (activeTab === "batches") fetchBatches();
  }, [activeTab, fetchErrors, fetchBatches]);

  const handleExportErrors = useCallback(() => {
    if (errors.length === 0) {
      showToast("暂无错误数据可导出", "info");
      return;
    }
    const header = "task_id,unit_id,batch_index,row_number,field_name,raw_value,error_code,error_reason,trace_id,created_at\n";
    const rows = errors.map((e) =>
      [e.task_id, e.unit_id, e.batch_index, e.row_number, e.field_name, `"${(e.raw_value || "").replace(/"/g, '""')}"`, e.error_code, `"${e.error_reason.replace(/"/g, '""')}"`, e.trace_id, e.created_at].join(",")
    );
    const csv = header + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `task-${taskId}-errors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [errors, taskId, showToast]);

  if (loading || !progress) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center gap-2 text-[#86909c]">
          <Loader2 className="h-5 w-5 animate-spin" />
          加载任务信息...
        </div>
      </div>
    );
  }

  const statusMeta = STATUS_META[progress.status] || STATUS_META.PENDING;
  const StatusIcon = statusMeta.icon;
  const percent = progress.total_rows > 0 ? Math.round((progress.processed_rows / progress.total_rows) * 100) : 0;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 space-y-6" data-status={progress.status}>
      {/* 头部 */}
      <div>
        <div className="flex items-center gap-2 text-sm text-[#86909c]">
          <FileText className="h-4 w-4" />
          <span className="truncate">{progress.file_name}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-[#1d2129] flex items-center gap-2">
          <StatusIcon className={cn("h-6 w-6", progress.status === "PROCESSING" && "animate-spin")} style={{ color: statusMeta.color }} />
          {statusMeta.label}
        </h1>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#86909c]">
          <span>task_id: <code className="text-[#4e5969]">{progress.task_id}</code></span>
          <span>trace_id: <code className="text-[#4e5969]">{progress.trace_id}</code></span>
        </div>
      </div>

      {/* 降级提示 */}
      {progress.degraded && (
        <div className="rounded-md border border-[#ff7d00] bg-[#fff7e8] p-3 text-sm text-[#9e6400]">
          <AlertTriangle className="mr-1 inline-block h-4 w-4" />
          ⚠️ SKU 校验已降级：本次导入未经过商品主数据完整校验，数据可能需要后续复核。
          {progress.degraded_reason && <div className="mt-1 text-xs">{progress.degraded_reason}</div>}
        </div>
      )}

      {/* 进度概览 */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#1d2129]">处理进度</h2>
          <button onClick={fetchProgress} className="btn-ghost text-xs flex items-center gap-1">
            <RefreshCw className="h-3 w-3" /> 刷新
          </button>
        </div>
        <div className="mb-3 h-3 w-full overflow-hidden rounded-full bg-[#e5e6eb]">
          <div
            className="h-full rounded-full bg-[#0fc6c2] transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="总行数" value={progress.total_rows} />
          <StatCard label="已处理" value={progress.processed_rows} color="#0fc6c2" />
          <StatCard label="成功" value={progress.success_rows} color="#00b42c" />
          <StatCard label="失败" value={progress.failed_rows} color="#f53f3f" />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="总批次" value={progress.total_batches} />
          <StatCard label="已完成批次" value={progress.completed_batches} color="#0fc6c2" />
          <StatCard label="吞吐量" value={progress.throughput ? `${progress.throughput.toFixed(1)} 行/秒` : "-"} icon={<TrendingUp className="h-3 w-3" />} />
          <StatCard label="预计剩余" value={progress.eta_seconds != null ? `${progress.eta_seconds}s` : "-"} icon={<Clock className="h-3 w-3" />} />
        </div>
        {progress.error_message && (
          <div className="mt-3 rounded-md bg-[#ffece8] p-2 text-xs text-[#f53f3f]">
            {progress.error_message}
          </div>
        )}
      </div>

      {/* Tab 切换 */}
      <div className="card">
        <div className="mb-4 flex items-center gap-1 border-b border-[#e5e6eb]">
          <TabButton active={activeTab === "progress"} onClick={() => setActiveTab("progress")}>进度概览</TabButton>
          <TabButton active={activeTab === "errors"} onClick={() => setActiveTab("errors")}>
            错误明细 {errorTotal > 0 && <span className="ml-1 rounded-full bg-[#f53f3f] px-1.5 text-[10px] text-white">{errorTotal}</span>}
          </TabButton>
          <TabButton active={activeTab === "batches"} onClick={() => setActiveTab("batches")}>批次性能</TabButton>
        </div>

        {activeTab === "progress" && (
          <div className="text-sm text-[#4e5969]">
            <p>任务已创建，Worker 正在后台分批处理。进度每 2 秒自动刷新。</p>
            {progress.trace_id && (
              <p className="mt-2">
                查看 <a href={`/traces?trace_id=${progress.trace_id}`} className="text-[#0fc6c2] underline">完整链路追踪</a>
              </p>
            )}
          </div>
        )}

        {activeTab === "errors" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input-field text-xs"
                value={errorFilter.batch ?? ""}
                onChange={(e) => setErrorFilter((f) => ({ ...f, batch: e.target.value ? Number(e.target.value) : undefined, page: 1 }))}
              >
                <option value="">全部批次</option>
                {Array.from({ length: progress.total_batches }, (_, i) => (
                  <option key={i} value={i}>第 {i} 批</option>
                ))}
              </select>
              <select
                className="input-field text-xs"
                value={errorFilter.errorCode ?? ""}
                onChange={(e) => setErrorFilter((f) => ({ ...f, errorCode: e.target.value || undefined, page: 1 }))}
              >
                <option value="">全部错误类型</option>
                {Object.entries(ERROR_CODE_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>{code} - {label}</option>
                ))}
              </select>
              <button onClick={handleExportErrors} className="btn-outline ml-auto text-xs flex items-center gap-1">
                <Download className="h-3 w-3" /> 导出 CSV
              </button>
            </div>
            {errors.length === 0 ? (
              <EmptyState title="暂无错误" description="所有行均校验通过" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[#e5e6eb] text-left text-[#86909c]">
                      <th className="py-2 pr-3">行号</th>
                      <th className="py-2 pr-3">批次</th>
                      <th className="py-2 pr-3">字段</th>
                      <th className="py-2 pr-3">错误码</th>
                      <th className="py-2 pr-3">原始值</th>
                      <th className="py-2 pr-3">错误原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.map((e) => (
                      <tr key={e.id} className="border-b border-[#f0f0f0]">
                        <td className="py-2 pr-3 text-[#1d2129]">{e.row_number}</td>
                        <td className="py-2 pr-3">{e.batch_index}</td>
                        <td className="py-2 pr-3">{e.field_name}</td>
                        <td className="py-2 pr-3">
                          <span className="tag tag-red">{e.error_code}</span>
                        </td>
                        <td className="py-2 pr-3 text-[#86909c] max-w-[200px] truncate" title={e.raw_value ?? ""}>{e.raw_value || "-"}</td>
                        <td className="py-2 pr-3 text-[#4e5969]">{e.error_reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex items-center justify-between text-xs text-[#86909c]">
                  <span>共 {errorTotal} 条</span>
                  <div className="flex gap-1">
                    <button
                      className="btn-ghost text-xs disabled:opacity-50"
                      disabled={errorFilter.page <= 1}
                      onClick={() => setErrorFilter((f) => ({ ...f, page: f.page - 1 }))}
                    >上一页</button>
                    <button
                      className="btn-ghost text-xs disabled:opacity-50"
                      disabled={errors.length < 50}
                      onClick={() => setErrorFilter((f) => ({ ...f, page: f.page + 1 }))}
                    >下一页</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "batches" && (
          <div className="space-y-2">
            {batches.length === 0 ? (
              <EmptyState title="暂无批次性能数据" description="批次处理完成后将显示性能日志" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[#e5e6eb] text-left text-[#86909c]">
                      <th className="py-2 pr-3">批次</th>
                      <th className="py-2 pr-3">状态</th>
                      <th className="py-2 pr-3">行数</th>
                      <th className="py-2 pr-3">成功</th>
                      <th className="py-2 pr-3">失败</th>
                      <th className="py-2 pr-3">解析ms</th>
                      <th className="py-2 pr-3">规则ms</th>
                      <th className="py-2 pr-3">校验ms</th>
                      <th className="py-2 pr-3">写入ms</th>
                      <th className="py-2 pr-3">总耗时ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id} className="border-b border-[#f0f0f0]">
                        <td className="py-2 pr-3">{b.batch_index}</td>
                        <td className="py-2 pr-3">
                          <span className={cn("tag", b.status === "COMPLETED" ? "tag-green" : "tag-red")}>{b.status}</span>
                        </td>
                        <td className="py-2 pr-3">{b.row_count}</td>
                        <td className="py-2 pr-3 text-[#00b42c]">{b.success_count}</td>
                        <td className="py-2 pr-3 text-[#f53f3f]">{b.failed_count}</td>
                        <td className="py-2 pr-3">{b.parse_duration_ms}</td>
                        <td className="py-2 pr-3">{b.rule_duration_ms}</td>
                        <td className="py-2 pr-3">{b.validate_duration_ms}</td>
                        <td className="py-2 pr-3">{b.insert_duration_ms}</td>
                        <td className="py-2 pr-3 font-medium text-[#1d2129]">{b.total_duration_ms}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color, icon }: { label: string; value: string | number; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-md bg-[#f7f8fa] p-3">
      <div className="flex items-center gap-1 text-xs text-[#86909c]">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-bold" style={{ color: color || "#1d2129" }}>{value}</div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "border-b-2 px-3 py-2 text-sm font-medium transition-all",
        active ? "border-[#0fc6c2] text-[#0fc6c2]" : "border-transparent text-[#86909c] hover:text-[#1d2129]"
      )}
    >
      {children}
    </button>
  );
}
