"use client";

import { useState, useCallback } from "react";
import { Search, Clock, Loader2, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { cn } from "@/lib/utils";
import type { TraceEventRow } from "@/types";

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

export default function TracesPage() {
  const [traceId, setTraceId] = useState("");
  const [events, setEvents] = useState<TraceEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async (id?: string) => {
    const targetId = (id ?? traceId).trim();
    if (!targetId) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(`/api/traces/${targetId}`);
      if (!res.ok) {
        setEvents([]);
        return;
      }
      const data = await res.json();
      setEvents(data.events || []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [traceId]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1d2129]">全链路 Trace 检索</h1>
        <p className="mt-1 text-sm text-[#86909c]">通过 trace_id 查看任务的完整时间线，1 分钟内定位失败原因</p>
      </div>

      {/* 搜索框 */}
      <div className="card">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#86909c]" />
            <input
              className="input-field pl-9"
              placeholder="输入 trace_id（如 trace_xxx）..."
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          <button onClick={() => handleSearch()} disabled={loading || !traceId.trim()} className="btn-primary text-sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "搜索"}
          </button>
        </div>
      </div>

      {/* 时间线 */}
      {searched && !loading && events.length === 0 ? (
        <EmptyState title="未找到 Trace 事件" description="请检查 trace_id 是否正确" />
      ) : events.length > 0 ? (
        <div className="card">
          <h2 className="mb-4 text-base font-semibold text-[#1d2129]">
            时间线 <span className="text-xs font-normal text-[#86909c]">({events.length} 个事件)</span>
          </h2>
          <ol className="relative">
            {events.map((evt, i) => {
              const Icon = EVENT_STATUS_ICON[evt.event_status ?? ""] || Clock;
              const color = STATUS_COLOR[evt.event_status ?? ""] || "#86909c";
              const isLast = i === events.length - 1;
              const time = new Date(evt.occurred_at).toLocaleTimeString("zh-CN", { hour12: false });
              return (
                <li key={evt.id} className="relative flex gap-3 pb-6 last:pb-0">
                  {!isLast && (
                    <span className="absolute left-[15px] top-8 h-full w-px bg-[#e5e6eb]" />
                  )}
                  <span
                    className="relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 bg-white"
                    style={{ borderColor: color }}
                  >
                    <Icon className={cn("h-4 w-4", evt.event_status === "PROCESSING" && "animate-spin")} style={{ color }} />
                  </span>
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[#1d2129]">{evt.event_name}</span>
                      {evt.event_status && (
                        <span className="tag" style={{ background: `${color}20`, color }}>{evt.event_status}</span>
                      )}
                      <span className="text-xs text-[#86909c]">{time}</span>
                    </div>
                    {evt.message && (
                      <p className="mt-1 text-sm text-[#4e5969]">{evt.message}</p>
                    )}
                    <div className="mt-1 flex gap-3 text-[10px] text-[#86909c]">
                      {evt.task_id && <span>task: <code>{evt.task_id.slice(0, 8)}</code></span>}
                      {evt.unit_id && <span>unit: <code>{evt.unit_id}</code></span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
