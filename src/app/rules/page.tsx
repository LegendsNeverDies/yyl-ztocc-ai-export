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
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
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
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="card flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-[#1d2129] truncate">{rule.name}</h3>
                  <span className="tag tag-teal">{parseModeLabels[rule.parseMode] || rule.parseMode}</span>
                  <span className="tag" style={{ background: '#f0f0f0', color: '#86909c' }}>{rule.fileType}</span>
                </div>
                {rule.description && (
                  <p className="mt-1 text-sm text-[#86909c] truncate">{rule.description}</p>
                )}
                <p className="mt-1 text-xs text-[#86909c]">
                  字段映射：{rule.fieldMappings?.length ?? 0} 个 | 更新于 {rule.updatedAt ? new Date(rule.updatedAt).toLocaleDateString("zh-CN") : "-"}
                </p>
              </div>
              <div className="ml-4 flex items-center gap-2">
                <button
                  onClick={() => router.push(`/rules/${rule.id}`)}
                  className="btn-ghost gap-1 text-xs"
                >
                  <Edit className="h-4 w-4" />
                  编辑
                </button>
                <button
                  onClick={() => handleDuplicate(rule.id)}
                  className="btn-ghost gap-1 text-xs"
                >
                  <Copy className="h-4 w-4" />
                  复制
                </button>
                <button
                  onClick={() => handleDelete(rule.id)}
                  className="btn-ghost gap-1 text-xs text-[#cf1322] hover:bg-[#fff1f0]"
                >
                  <Trash2 className="h-4 w-4" />
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
