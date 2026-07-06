"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { Save, ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/shared/toast";
import { getRule, updateRule } from "@/lib/server-actions";
import { RuleConfigForm } from "@/components/rule-editor/rule-config-form";
import type { ParseRuleDraft } from "@/types";

export default function EditRulePage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rule, setRule] = useState<ParseRuleDraft>(() => ({
    name: "", description: "", fileType: "excel", parseMode: "standard",
    fieldMappings: [], defaults: {},
  }));

  // 加载已有规则
  useEffect(() => {
    getRule(id).then((data) => {
      if (data) {
        setRule({
          name: data.name || "",
          description: data.description || "",
          fileType: data.fileType || "excel",
          parseMode: data.parseMode || "standard",
          fieldMappings: Array.isArray(data.fieldMappings) ? data.fieldMappings : [],
          excel: data.excel || undefined,
          pdf: data.pdf || undefined,
          aggregate: data.aggregate || undefined,
          matrix: data.matrix || undefined,
          card: data.card || undefined,
          kvExtract: Array.isArray(data.kvExtract) ? data.kvExtract : undefined,
          defaults: data.defaults || {},
        });
      }
      setLoading(false);
    });
  }, [id]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    await updateRule(id, rule);
    setSaving(false);
    showToast("规则已保存", "success");
    router.push("/rules");
  }, [id, rule, router, showToast]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-[#0fc6c2]" />
        <span className="ml-2 text-sm text-[#86909c]">加载规则...</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <button onClick={() => router.push("/rules")} className="btn-ghost mb-4 gap-1"><ArrowLeft className="h-4 w-4" />返回规则列表</button>
      <h1 className="text-2xl font-bold text-[#1d2129]">编辑解析规则</h1>
      <p className="mt-1 text-sm text-[#86909c]">修改所有规则配置参数</p>

      <div className="mt-6">
        <RuleConfigForm rule={rule} setRule={setRule} />

        <div className="mt-4 flex gap-3 pt-2">
          <button onClick={handleSave} disabled={saving} className="btn-primary gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "保存中..." : "保存修改"}
          </button>
          <button onClick={() => router.push("/rules")} className="btn-ghost gap-1">取消</button>
        </div>
      </div>
    </div>
  );
}
