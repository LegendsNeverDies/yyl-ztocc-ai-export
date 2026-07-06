"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, Edit, Copy, Trash2, Settings, Sparkles, Database } from "lucide-react";
import { getAllRules, deleteRule, duplicateRule } from "@/lib/server-actions";
import { useToast } from "@/components/shared/toast";
import { EmptyState } from "@/components/shared/empty-state";
import type { ParseRule } from "@/types";

export default function RulesPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  const loadRules = useCallback(async () => {
    const list = await getAllRules();
    setRules(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("确定删除此规则？")) return;
      await deleteRule(id);
      showToast("规则已删除", "success");
      loadRules();
    },
    [loadRules, showToast]
  );

  const handleDuplicate = useCallback(
    async (id: string) => {
      try {
        await duplicateRule(id);
        showToast("规则已复制", "success");
        loadRules();
      } catch {
        showToast("复制失败", "error");
      }
    },
    [loadRules, showToast]
  );

  const handleSeed = useCallback(async () => {
    if (!confirm("将用 6 条内置规则覆盖相同名称的已有规则，继续？")) return;
    setSeeding(true);
    try {
      const res = await fetch("/api/rules/seed", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast(`已初始化 ${data.count} 条内置规则`, "success");
        loadRules();
      } else {
        showToast("初始化失败：" + data.error, "error");
      }
    } catch {
      showToast("初始化失败，请检查网络", "error");
    } finally {
      setSeeding(false);
    }
  }, [loadRules, showToast]);

  const parseModeLabels: Record<string, string> = {
    standard: "标准表格",
    aggregate: "跨行聚合",
    matrix: "矩阵转置",
    card: "卡片识别",
    "multi-sheet": "多Sheet合并",
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1d2129]">解析规则管理</h1>
          <p className="mt-1 text-sm text-[#86909c]">管理所有文件解析规则，支持 AI 自动生成</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSeed} disabled={seeding} className="btn-ghost gap-1.5 text-sm">
            <Database className="h-4 w-4" />
            {seeding ? "初始化中..." : "初始化内置规则"}
          </button>
          <button onClick={() => router.push("/rules/new")} className="btn-primary gap-1.5">
            <Plus className="h-4 w-4" />
            新建规则
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card py-12 text-center text-sm text-[#86909c]">加载中...</div>
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<Settings className="h-16 w-16 opacity-30" />}
          title="暂无解析规则"
          description="创建您的第一条解析规则，或上传文件让 AI 自动生成"
          action={
            <button onClick={() => router.push("/rules/new")} className="btn-primary gap-1.5">
              <Sparkles className="h-4 w-4" />
              AI 新建规则
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rules.map((rule) => (
            <div key={rule.id} className="card flex flex-col !p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold text-[#1d2129] line-clamp-1" title={rule.name}>{rule.name}</h3>
                <span className="tag tag-teal flex-shrink-0">{parseModeLabels[rule.parseMode] || rule.parseMode}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="tag flex-shrink-0" style={{ background: '#f0f0f0', color: '#86909c' }}>{rule.fileType}</span>
                <span className="text-xs text-[#86909c]">{rule.fieldMappings?.length ?? 0} 个字段映射</span>
              </div>
              {rule.description && (
                <p className="mt-2 text-sm text-[#86909c] line-clamp-2" title={rule.description}>{rule.description}</p>
              )}
              <p className="mt-2 text-xs text-[#86909c]">
                更新于 {rule.updatedAt ? new Date(rule.updatedAt).toLocaleDateString("zh-CN") : "-"}
              </p>

              <div className="mt-3 flex items-center gap-1 border-t border-[#e5e6eb] pt-3">
                <button
                  onClick={() => router.push(`/rules/${rule.id}`)}
                  className="btn-ghost gap-1 text-xs"
                >
                  <Edit className="h-3.5 w-3.5" />编辑
                </button>
                <button
                  onClick={() => handleDuplicate(rule.id)}
                  className="btn-ghost gap-1 text-xs"
                >
                  <Copy className="h-3.5 w-3.5" />复制
                </button>
                <button
                  onClick={() => handleDelete(rule.id)}
                  className="btn-ghost gap-1 text-xs text-[#cf1322] hover:bg-[#fff1f0] ml-auto"
                >
                  <Trash2 className="h-3.5 w-3.5" />删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
