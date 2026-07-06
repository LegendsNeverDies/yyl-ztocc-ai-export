"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, Plus, Sparkles, Check, Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/shared/toast";
import type { ParseRule, ParsedFile } from "@/types";

interface RuleSelectorProps {
  rules: ParseRule[];
  selectedRule: ParseRule | null;
  parsedFile: ParsedFile;
  onSelectRule: (rule: ParseRule) => void;
  loading?: boolean;
}

export function RuleSelector({
  rules,
  selectedRule,
  parsedFile,
  onSelectRule,
  loading,
}: RuleSelectorProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [search, setSearch] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);

  const filtered = rules.filter(
    (r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.description?.toLowerCase().includes(search.toLowerCase())
  );

  const handleNewRule = useCallback(() => {
    // 将文件信息传给新建规则页（带时间戳，60秒内有效）
    sessionStorage.setItem(
      "newRuleFile",
      JSON.stringify({
        fileName: parsedFile.fileName,
        fileType: parsedFile.fileType,
        rows: parsedFile.rows.slice(0, 100),
        sampleText: parsedFile.sampleText,
        _timestamp: Date.now(),
      })
    );
    router.push("/rules/new");
  }, [parsedFile, router]);

  const handleSelectRule = useCallback(
    (rule: ParseRule) => {
      onSelectRule(rule);
    },
    [onSelectRule]
  );

  return (
    <div className="space-y-4">
      {/* 搜索和新建 */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#86909c]" />
          <input
            className="input-field pl-9"
            placeholder="搜索已有规则..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={handleNewRule}
          disabled={aiGenerating}
          className="btn-outline flex-shrink-0 gap-1.5 text-sm"
        >
          <Sparkles className="h-4 w-4" />
          AI 新建规则
        </button>
      </div>

      {/* 规则列表 */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#e5e6eb] py-8 text-center">
          <p className="text-sm text-[#86909c]">暂无已保存的解析规则</p>
          <button
            onClick={handleNewRule}
            className="mt-2 btn-outline text-sm"
          >
            <Plus className="h-4 w-4" />
            创建第一条规则
          </button>
        </div>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {filtered.map((rule) => {
            const isSelected = selectedRule?.id === rule.id;
            return (
              <div
                key={rule.id}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-all",
                  isSelected
                    ? "border-[#0fc6c2] bg-[#e8fafa]"
                    : "border-[#e5e6eb] hover:border-[#b5e8e8] hover:bg-[#f7f8fa]"
                )}
                onClick={() => handleSelectRule(rule)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[#1d2129] truncate">
                      {rule.name}
                    </span>
                    <span className="tag tag-teal flex-shrink-0">{rule.parseMode}</span>
                    <span className="tag flex-shrink-0" style={{ background: '#f0f0f0', color: '#86909c' }}>{rule.fileType}</span>
                  </div>
                  {rule.description && (
                    <p className="mt-0.5 text-xs text-[#86909c] truncate">
                      {rule.description}
                    </p>
                  )}
                </div>
                <button
                  className={cn(
                    "ml-3 flex-shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                    isSelected
                      ? "bg-[#0fc6c2] text-white"
                      : "bg-[#f0f0f0] text-[#4e5969] hover:bg-[#0fc6c2] hover:text-white"
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectRule(rule);
                  }}
                  disabled={loading}
                >
                  {loading && isSelected ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      解析中
                    </span>
                  ) : isSelected ? (
                    <span className="flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      已选择
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Play className="h-3 w-3" />
                      使用此规则
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
