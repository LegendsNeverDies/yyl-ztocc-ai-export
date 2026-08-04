"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, RefreshCw, Activity, AlertTriangle, Clock, AlertCircle } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { ERROR_CODE_LABELS } from "@/types";
import { cn, formatDateTime } from "@/lib/utils";
import type { MonitorSummary } from "@/types";

export default function MonitorPage() {
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/import-monitor/summary");
      if (!res.ok) return;
      const data: MonitorSummary = await res.json();
      setSummary(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    const t = setInterval(fetchSummary, 5000);
    return () => clearInterval(t);
  }, [fetchSummary]);

  if (loading || !summary) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-center gap-2 text-[#86909c]">
          <Loader2 className="h-5 w-5 animate-spin" /> 加载监控数据...
        </div>
      </div>
    );
  }

  const maxThroughput = Math.max(1, ...summary.throughput.map((t) => t.success_rows));
  const totalErrors = summary.error_distribution.reduce((s, e) => s + e.count, 0);
  const backlogStatus = summary.queue_backlog;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-6">
      {summary.debug_message && (
        <div className="rounded-lg border border-[#f3c3a1] bg-[#fff7e8] p-4 text-sm text-[#8a4b00]">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> 调试信息
          </div>
          <div className="mt-2">{summary.debug_message}</div>
          {summary.debug_details?.length ? (
            <ul className="mt-2 list-disc pl-5">
              {summary.debug_details.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#1d2129] flex items-center gap-2">
          <Activity className="h-6 w-6 text-[#0fc6c2]" /> 导入监控看板
        </h1>
        <button onClick={fetchSummary} className="btn-ghost text-xs flex items-center gap-1">
          <RefreshCw className="h-3 w-3" /> 刷新（5s）
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 1. 实时吞吐量 */}
        <div className="card">
          <h2 className="mb-3 text-base font-semibold text-[#1d2129]">实时吞吐量（近5分钟）</h2>
          {summary.throughput.length === 0 ? (
            <EmptyState title="暂无数据" description="最近5分钟无已完成任务" />
          ) : (
            <div className="flex h-40 items-end gap-2">
              {summary.throughput.map((t, i) => (
                <div key={i} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-[#0fc6c2] transition-all"
                    style={{ height: `${(t.success_rows / maxThroughput) * 100}%`, minHeight: "2px" }}
                    title={`${t.minute}: ${t.success_rows} 行`}
                  />
                  <span className="text-[10px] text-[#86909c]">{t.minute}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-xs text-[#86909c]">每分钟成功入库行数</div>
        </div>

        {/* 2. 队列积压 */}
        <div className="card">
          <h2 className="mb-3 text-base font-semibold text-[#1d2129]">队列积压深度</h2>
          <div className={cn(
            "rounded-md p-4",
            backlogStatus.status === "ok" ? "bg-[#e8ffea]" : backlogStatus.status === "warning" ? "bg-[#fff7e8]" : "bg-[#ffece8]"
          )}>
            <div className="flex items-center gap-2">
              {backlogStatus.status === "ok" ? (
                <Clock className="h-5 w-5 text-[#00b42c]" />
              ) : (
                <AlertTriangle className={cn("h-5 w-5", backlogStatus.status === "warning" ? "text-[#ff7d00]" : "text-[#f53f3f]")} />
              )}
              <span className={cn(
                "text-2xl font-bold",
                backlogStatus.status === "ok" ? "text-[#00b42c]" : backlogStatus.status === "warning" ? "text-[#ff7d00]" : "text-[#f53f3f]"
              )}>
                {backlogStatus.pending_batches}
              </span>
              <span className="text-sm text-[#86909c]">个待处理批次</span>
            </div>
            <div className="mt-2 text-sm text-[#4e5969]">
              待处理行数：<span className="font-medium">{backlogStatus.pending_rows}</span> 行
              {backlogStatus.status === "warning" && <span className="ml-2 text-[#ff7d00]">（超过 5000 行预警阈值）</span>}
            </div>
          </div>
        </div>

        {/* 3. 阶段耗时分布 */}
        <div className="card">
          <h2 className="mb-3 text-base font-semibold text-[#1d2129]">阶段耗时分布（近1小时）</h2>
          {summary.stage_duration.every((s) => s.p50 === 0 && s.p95 === 0) ? (
            <EmptyState title="暂无数据" description="近1小时无批次性能日志" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#e5e6eb] text-left text-[#86909c]">
                    <th className="py-2 pr-3">阶段</th>
                    <th className="py-2 pr-3">P50 (ms)</th>
                    <th className="py-2 pr-3">P95 (ms)</th>
                    <th className="py-2 pr-3">P99 (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.stage_duration.map((s) => (
                    <tr key={s.stage} className="border-b border-[#f0f0f0]">
                      <td className="py-2 pr-3 font-medium text-[#1d2129]">{s.stage}</td>
                      <td className="py-2 pr-3">{s.p50}</td>
                      <td className="py-2 pr-3 text-[#ff7d00]">{s.p95}</td>
                      <td className="py-2 pr-3 text-[#f53f3f]">{s.p99}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 4. 错误类型分布 */}
        <div className="card">
          <h2 className="mb-3 text-base font-semibold text-[#1d2129]">错误类型分布（近1小时）</h2>
          {summary.error_distribution.length === 0 ? (
            <EmptyState title="暂无错误" description="近1小时无错误记录" />
          ) : (
            <div className="space-y-2">
              {summary.error_distribution.map((e) => {
                const pct = totalErrors > 0 ? (e.count / totalErrors) * 100 : 0;
                const label = ERROR_CODE_LABELS[e.error_code] || e.error_code;
                return (
                  <div key={e.error_code} className="flex items-center gap-2">
                    <span className="w-32 flex-shrink-0 text-xs">
                      <span className="tag tag-red mr-1">{e.error_code}</span>
                      {label}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-[#e5e6eb]">
                      <div className="h-full bg-[#f53f3f]" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-12 text-right text-xs text-[#4e5969]">{e.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 5. 慢批次 TOP 10 */}
        <div className="card lg:col-span-2">
          <h2 className="mb-3 text-base font-semibold text-[#1d2129]">慢批次 TOP 10（近1小时）</h2>
          {summary.slow_batches_top10.length === 0 ? (
            <EmptyState title="暂无数据" description="近1小时无批次性能日志" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#e5e6eb] text-left text-[#86909c]">
                    <th className="py-2 pr-3">任务ID</th>
                    <th className="py-2 pr-3">批次</th>
                    <th className="py-2 pr-3">行数</th>
                    <th className="py-2 pr-3">解析ms</th>
                    <th className="py-2 pr-3">规则ms</th>
                    <th className="py-2 pr-3">校验ms</th>
                    <th className="py-2 pr-3">写入ms</th>
                    <th className="py-2 pr-3">总耗时ms</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.slow_batches_top10.map((b) => (
                    <tr key={b.id} className="border-b border-[#f0f0f0]">
                      <td className="py-2 pr-3 font-mono text-[10px] text-[#86909c]">{b.task_id.slice(0, 8)}</td>
                      <td className="py-2 pr-3">{b.batch_index}</td>
                      <td className="py-2 pr-3">{b.row_count}</td>
                      <td className="py-2 pr-3">{b.parse_duration_ms}</td>
                      <td className="py-2 pr-3">{b.rule_duration_ms}</td>
                      <td className="py-2 pr-3">{b.validate_duration_ms}</td>
                      <td className="py-2 pr-3">{b.insert_duration_ms}</td>
                      <td className="py-2 pr-3 font-bold text-[#f53f3f]">{b.total_duration_ms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 6. 最近失败任务 */}
        <div className="card lg:col-span-2">
          <h2 className="mb-3 text-base font-semibold text-[#1d2129] flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-[#f53f3f]" /> 最近失败/部分成功任务
          </h2>
          {summary.failed_tasks_recent.length === 0 ? (
            <EmptyState title="暂无失败任务" description="系统运行正常" />
          ) : (
            <div className="space-y-2">
              {summary.failed_tasks_recent.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-md bg-[#f7f8fa] p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="truncate max-w-[200px]">{t.file_name}</span>
                    <span className="tag tag-red">{t.failed_rows} 行失败</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-[#86909c]">
                    <span>{formatDateTime(t.created_at)}</span>
                    <a href={`/tasks/${t.id}`} className="text-[#0fc6c2] hover:underline">查看</a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
