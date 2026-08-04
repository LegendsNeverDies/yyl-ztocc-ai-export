"use client";

import { useState, useCallback } from "react";
import { Search, Clock, Loader2, AlertCircle, CheckCircle2, XCircle, Filter, FileText } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { cn } from "@/lib/utils";
import { ERROR_CODE_LABELS } from "@/types";

interface SearchResultItem {
  type: "trace_event" | "error";
  trace_id: string;
  task_id: string | null;
  unit_id: string | null;
  batch_index: number | null;
  row_number?: number;
  field_name?: string;
  raw_value?: string | null;
  error_code?: string;
  error_reason?: string;
  event_name?: string;
  event_status?: string | null;
  message?: string | null;
  occurred_at: string;
}

const EVENT_STATUS_ICON: Record<string, typeof Clock> = {
  PENDING: Clock,
  PROCESSING: Loader2,
  COMPLETED: CheckCircle2,
  PARTIAL_SUCCESS: AlertCircle,
  FAILED: XCircle,
  SENT: CheckCircle2,
  DEGRADED: AlertCircle,
};

const STATUS_COLOR: Record<string, string> = {
  PENDING: "#86909c",
  PROCESSING: "#0fc6c2",
  COMPLETED: "#00b42c",
  PARTIAL_SUCCESS: "#ff7d00",
  FAILED: "#f53f3f",
  SENT: "#00b42c",
  DEGRADED: "#ff7d00",
};

interface SearchForm {
  trace_id: string;
  task_id: string;
  file_name: string;
  batch_index: string;
  row_start: string;
  row_end: string;
  error_code: string;
}

const EMPTY_FORM: SearchForm = {
  trace_id: "",
  task_id: "",
  file_name: "",
  batch_index: "",
  row_start: "",
  row_end: "",
  error_code: "",
};

export default function TracesPage() {
  const [form, setForm] = useState<SearchForm>(EMPTY_FORM);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  const updateField = (key: keyof SearchForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSearch = useCallback(async (pageNum = 1) => {
    setLoading(true);
    setSearched(true);
    setPage(pageNum);
    try {
      const params = new URLSearchParams();
      if (form.trace_id) params.set("trace_id", form.trace_id.trim());
      if (form.task_id) params.set("task_id", form.task_id.trim());
      if (form.file_name) params.set("file_name", form.file_name.trim());
      if (form.batch_index) params.set("batch_index", form.batch_index.trim());
      if (form.row_start) params.set("row_start", form.row_start.trim());
      if (form.row_end) params.set("row_end", form.row_end.trim());
      if (form.error_code) params.set("error_code", form.error_code);
      params.set("page", String(pageNum));
      params.set("page_size", "50");

      const res = await fetch(`/api/traces/search?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setResults([]);
        setTotal(0);
        setHasMore(false);
        if (err.error) alert(err.error);
        return;
      }
      const data = await res.json();
      setResults(data.rows || []);
      setTotal(data.total || 0);
      setHasMore((data.rows?.length || 0) === 50 && pageNum * 50 < (data.total || 0));
    } catch {
      setResults([]);
      setTotal(0);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [form]);

  const handleReset = () => {
    setForm(EMPTY_FORM);
    setResults([]);
    setTotal(0);
    setSearched(false);
    setPage(1);
  };

  const hasAnyFilter = Object.values(form).some((v) => v.trim());

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1d2129]">全链路 Trace 检索</h1>
        <p className="mt-1 text-sm text-[#86909c]">
          支持按 trace_id / task_id / 文件名 / 批次号 / 行号范围 / 错误码 搜索，1 分钟内定位失败原因
        </p>
      </div>

      {/* 搜索表单 */}
      <div className="card space-y-4">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-[#0fc6c2]" />
          <h2 className="text-sm font-semibold text-[#1d2129]">搜索条件</h2>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs text-[#86909c]">Trace ID</label>
            <input
              className="input-field text-sm"
              placeholder="trace_xxx"
              value={form.trace_id}
              onChange={(e) => updateField("trace_id", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(1)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[#86909c]">Task ID</label>
            <input
              className="input-field text-sm"
              placeholder="task uuid"
              value={form.task_id}
              onChange={(e) => updateField("task_id", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(1)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[#86909c]">文件名</label>
            <input
              className="input-field text-sm"
              placeholder="模糊匹配"
              value={form.file_name}
              onChange={(e) => updateField("file_name", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(1)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[#86909c]">批次号</label>
            <input
              type="number"
              className="input-field text-sm"
              placeholder="如 0"
              value={form.batch_index}
              onChange={(e) => updateField("batch_index", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(1)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[#86909c]">行号范围 - 起</label>
            <input
              type="number"
              className="input-field text-sm"
              placeholder="如 100"
              value={form.row_start}
              onChange={(e) => updateField("row_start", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(1)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[#86909c]">行号范围 - 止</label>
            <input
              type="number"
              className="input-field text-sm"
              placeholder="如 200"
              value={form.row_end}
              onChange={(e) => updateField("row_end", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(1)}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-[#86909c]">错误码</label>
            <select
              className="input-field text-sm"
              value={form.error_code}
              onChange={(e) => updateField("error_code", e.target.value)}
            >
              <option value="">全部错误类型</option>
              {Object.entries(ERROR_CODE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>{code} - {label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button onClick={() => handleSearch(1)} disabled={loading || !hasAnyFilter} className="btn-primary text-sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              搜索
            </button>
            <button onClick={handleReset} className="btn-ghost text-sm">重置</button>
          </div>
        </div>
      </div>

      {/* 搜索结果 */}
      {searched && !loading && results.length === 0 ? (
        <EmptyState title="未找到匹配结果" description="请调整搜索条件后重试" />
      ) : results.length > 0 ? (
        <div className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#1d2129]">
              搜索结果 <span className="text-xs font-normal text-[#86909c]">（共 {total} 条，第 {page} 页）</span>
            </h2>
            <div className="flex gap-1">
              <button
                className="btn-ghost text-xs disabled:opacity-50"
                disabled={page <= 1}
                onClick={() => handleSearch(page - 1)}
              >上一页</button>
              <button
                className="btn-ghost text-xs disabled:opacity-50"
                disabled={!hasMore}
                onClick={() => handleSearch(page + 1)}
              >下一页</button>
            </div>
          </div>
          <ol className="relative">
            {results.map((item, i) => {
              const isTrace = item.type === "trace_event";
              const status = isTrace ? (item.event_status ?? "") : "FAILED";
              const Icon = isTrace ? (EVENT_STATUS_ICON[status] || Clock) : XCircle;
              const color = isTrace ? (STATUS_COLOR[status] || "#86909c") : "#f53f3f";
              const isLast = i === results.length - 1;
              const time = new Date(item.occurred_at).toLocaleTimeString("zh-CN", { hour12: false });
              const title = isTrace ? (item.event_name || "事件") : `错误 ${item.error_code}`;
              return (
                <li key={`${item.type}-${i}`} className="relative flex gap-3 pb-6 last:pb-0">
                  {!isLast && (
                    <span className="absolute left-[15px] top-8 h-full w-px bg-[#e5e6eb]" />
                  )}
                  <span
                    className="relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 bg-white"
                    style={{ borderColor: color }}
                  >
                    <Icon className={cn("h-4 w-4", status === "PROCESSING" && "animate-spin")} style={{ color }} />
                  </span>
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[#1d2129]">{title}</span>
                      <span className="tag" style={{ background: `${color}20`, color }}>
                        {isTrace ? status : item.error_code}
                      </span>
                      <span className="text-xs text-[#86909c]">{time}</span>
                      {item.type === "error" && item.batch_index != null && (
                        <span className="text-[10px] text-[#86909c]">批次 {item.batch_index}</span>
                      )}
                      {item.type === "error" && item.row_number != null && (
                        <span className="text-[10px] text-[#86909c]">行 {item.row_number}</span>
                      )}
                    </div>
                    {/* 错误明细：字段名、原始值、错误原因、修复建议 */}
                    {item.type === "error" && (
                      <div className="mt-2 rounded-md bg-[#fff7e8] p-2 text-xs text-[#4e5969]">
                        <div className="flex gap-4">
                          <span>字段：<code className="text-[#1d2129]">{item.field_name}</code></span>
                          <span>原始值：<code className="text-[#86909c]">{item.raw_value || "-"}</code></span>
                        </div>
                        <div className="mt-1">
                          <span>原因：{item.error_reason}</span>
                        </div>
                        {item.error_code && ERROR_CODE_LABELS[item.error_code] && (
                          <div className="mt-1 text-[#86909c]">
                            类型：{ERROR_CODE_LABELS[item.error_code]}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Trace 事件：message */}
                    {isTrace && item.message && (
                      <p className="mt-1 text-sm text-[#4e5969]">{item.message}</p>
                    )}
                    <div className="mt-1 flex gap-3 text-[10px] text-[#86909c]">
                      {item.task_id && (
                        <span>
                          task:{" "}
                          <a href={`/tasks/${item.task_id}`} className="text-[#0fc6c2] hover:underline">
                            <code>{item.task_id.slice(0, 8)}</code>
                          </a>
                        </span>
                      )}
                      {item.unit_id && <span>unit: <code>{item.unit_id}</code></span>}
                      <span className="flex items-center gap-1">
                        <FileText className="h-3 w-3" /> trace: <code>{item.trace_id.slice(0, 16)}</code>
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {hasMore && (
            <div className="mt-4 text-center">
              <button onClick={() => handleSearch(page + 1)} className="btn-outline text-sm">
                加载更多
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
