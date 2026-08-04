"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2, FileText, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface TaskListItem {
  id: string;
  file_name: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  created_at: string;
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "等待", cls: "tag-gray" },
  PROCESSING: { label: "处理中", cls: "tag-teal" },
  COMPLETED: { label: "成功", cls: "tag-green" },
  PARTIAL_SUCCESS: { label: "部分成功", cls: "tag-orange" },
  FAILED: { label: "失败", cls: "tag-red" },
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    try {
      // 复用 server-actions：直接查 shipments 不合适，这里用原生 fetch 一个简易列表接口
      // 为简化，直接用 Neon 查询接口（通过 monitor summary 间接拿不到列表）
      // 这里改为：调用 /api/import-tasks 列表接口（需新增）
      const res = await fetch("/api/import-tasks?page=1&page_size=50");
      if (!res.ok) return;
      const data = await res.json();
      setTasks(data.rows || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const t = setInterval(fetchTasks, 5000);
    return () => clearInterval(t);
  }, [fetchTasks]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#1d2129]">导入任务列表</h1>
        <button onClick={fetchTasks} className="btn-ghost text-xs flex items-center gap-1">
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[#86909c]">
          <Loader2 className="h-5 w-5 animate-spin" /> 加载中...
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState title="暂无导入任务" description="上传文件后将在此显示" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e5e6eb] text-left text-xs text-[#86909c]">
                <th className="py-3 pr-3">文件名</th>
                <th className="py-3 pr-3">状态</th>
                <th className="py-3 pr-3">进度</th>
                <th className="py-3 pr-3">成功/失败</th>
                <th className="py-3 pr-3">创建时间</th>
                <th className="py-3 pr-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const meta = STATUS_LABEL[t.status] || STATUS_LABEL.PENDING;
                const pct = t.total_rows > 0 ? Math.round((t.processed_rows / t.total_rows) * 100) : 0;
                return (
                  <tr key={t.id} className="border-b border-[#f0f0f0] hover:bg-[#f7f8fa]">
                    <td className="py-3 pr-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-[#0fc6c2]" />
                        <span className="truncate max-w-[200px]" title={t.file_name}>{t.file_name}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <span className={cn("tag", meta.cls)}>{meta.label}</span>
                    </td>
                    <td className="py-3 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#e5e6eb]">
                          <div className="h-full bg-[#0fc6c2]" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-[#86909c]">{t.processed_rows}/{t.total_rows}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-3 text-xs">
                      <span className="text-[#00b42c]">{t.success_rows}</span>
                      <span className="text-[#86909c]"> / </span>
                      <span className="text-[#f53f3f]">{t.failed_rows}</span>
                    </td>
                    <td className="py-3 pr-3 text-xs text-[#86909c]">{formatDateTime(t.created_at)}</td>
                    <td className="py-3 pr-3">
                      <Link href={`/tasks/${t.id}`} className="text-xs text-[#0fc6c2] hover:underline">查看详情</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
