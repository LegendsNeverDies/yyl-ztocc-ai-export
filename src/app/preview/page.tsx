"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft, Download, Plus, Trash2, Loader2, AlertCircle,
  CheckCircle, Upload,
} from "lucide-react";
import { useToast } from "@/components/shared/toast";
import { ProgressBar } from "@/components/shared/progress-bar";
import { EmptyState } from "@/components/shared/empty-state";
import { validateOrders, checkExternalCodeDuplicates, checkReceiverConsistency } from "@/lib/validators";
import { submitOrders, getExistingExternalCodes } from "@/lib/server-actions";
import { generateId } from "@/lib/utils";
import * as XLSX from "xlsx";
import type { OrderRow, ValidationError, SubmitResult } from "@/types";

interface ColumnDef {
  key: keyof OrderRow;
  label: string;
  width: number;
  required?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { key: "rowIndex", label: "#", width: 56 },
  { key: "externalCode", label: "外部编码", width: 150 },
  { key: "storeName", label: "收货门店", width: 170 },
  { key: "receiverName", label: "收件人姓名", width: 120 },
  { key: "receiverPhone", label: "收件人电话", width: 130 },
  { key: "receiverAddress", label: "收件人地址", width: 220 },
  { key: "skuCode", label: "SKU物品编码", width: 140, required: true },
  { key: "skuName", label: "SKU物品名称", width: 190, required: true },
  { key: "skuQuantity", label: "SKU发货数量", width: 120, required: true },
  { key: "skuSpec", label: "SKU规格型号", width: 150 },
  { key: "remark", label: "备注", width: 150 },
];
const ACTION_W = 64;
const ROW_H = 38;

export default function PreviewPage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [rows, setRows] = useState<OrderRow[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [fileName, setFileName] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [parseDuration, setParseDuration] = useState(0);
  const [isTestParse, setIsTestParse] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [submitProgress, setSubmitProgress] = useState({ current: 0, total: 0, percent: 0 });
  const [existingCodes, setExistingCodes] = useState<Set<string>>(new Set());
  const [editCell, setEditCell] = useState<{ idx: number; col: keyof OrderRow } | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);
  const codesFetched = useRef(false);

  // 载入待预览数据
  useEffect(() => {
    const stored = sessionStorage.getItem("previewData");
    if (!stored) {
      router.replace("/");
      return;
    }
    const data = JSON.parse(stored);
    setRows(data.rows || []);
    setErrors(data.errors || []);
    setFileName(data.fileName || "");
    setRuleName(data.ruleName || "");
    setParseDuration(data.parseDuration || 0);
    setIsTestParse(!!data.isTestParse);
  }, [router]);

  // 进页时按当前外部编码查一次数据库已存在编码（避免每次编辑全表拉取）
  useEffect(() => {
    if (rows.length === 0 || codesFetched.current) return;
    codesFetched.current = true;
    const codes = Array.from(new Set(rows.map((r) => r.externalCode?.trim()).filter(Boolean) as string[]));
    getExistingExternalCodes(codes).then(setExistingCodes).catch(() => setExistingCodes(new Set()));
  }, [rows]);

  // 数据变化时防抖重校验（纯前端，不再查库）
  useEffect(() => {
    if (rows.length === 0) return;
    const t = setTimeout(() => {
      const ve = validateOrders(rows);
      const de = checkExternalCodeDuplicates(rows, existingCodes);
      const ce = checkReceiverConsistency(rows);
      setErrors([...ve, ...de, ...ce]);
    }, 150);
    return () => clearTimeout(t);
  }, [rows, existingCodes]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const totalWidth = useMemo(() => COLUMNS.reduce((s, c) => s + c.width, 0) + ACTION_W, []);

  const getFieldErrors = useCallback(
    (rowIndex: number, field: string) => errors.filter((e) => e.rowIndex === rowIndex && e.field === field),
    [errors]
  );

  const updateCell = useCallback((idx: number, field: keyof OrderRow, value: string) => {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const updated = { ...row } as Record<string, unknown>;
        updated[field] = field === "skuQuantity" ? Number(value) || 0 : value;
        return updated as unknown as OrderRow;
      })
    );
  }, []);

  const handleCellClick = useCallback((idx: number, colKey: keyof OrderRow) => {
    if (colKey === "rowIndex") return;
    setEditCell({ idx, col: colKey });
  }, []);

  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent, idx: number, colKey: keyof OrderRow) => {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const colIdx = COLUMNS.findIndex((c) => c.key === colKey);
        const nextColIdx = colIdx + (e.key === "Tab" && e.shiftKey ? -1 : 1);
        const nextCol = COLUMNS[nextColIdx];
        if (nextCol && nextCol.key !== "rowIndex") {
          setEditCell({ idx, col: nextCol.key });
        } else if (e.key === "Enter" && idx + 1 < rows.length) {
          rowVirtualizer.scrollToIndex(idx + 1);
          setEditCell({ idx: idx + 1, col: colKey });
        } else {
          setEditCell(null);
        }
      }
      if (e.key === "Escape") setEditCell(null);
    },
    [rows.length, rowVirtualizer]
  );

  const handleDeleteRow = useCallback((idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    setEditCell(null);
  }, []);

  const handleAddRow = useCallback(() => {
    const maxIdx = rows.reduce((max, r) => Math.max(max, r.rowIndex), -1);
    setRows((prev) => [
      ...prev,
      {
        id: generateId(), rowIndex: maxIdx + 1,
        externalCode: "", storeName: "", receiverName: "", receiverPhone: "", receiverAddress: "",
        skuCode: "", skuName: "", skuQuantity: 0, skuSpec: "", remark: "",
      },
    ]);
  }, [rows]);

  const handleExport = useCallback(() => {
    const exportData = rows.map((row) => {
      const result: Record<string, unknown> = {};
      for (const col of COLUMNS) {
        if (col.key === "rowIndex") continue;
        result[col.label] = row[col.key] as unknown;
      }
      return result;
    });
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "出库单");
    XLSX.writeFile(wb, `出库单_${fileName || "export"}.xlsx`);
    showToast("导出成功", "success");
  }, [rows, fileName, showToast]);

  const handleSubmit = useCallback(async () => {
    const ve = validateOrders(rows);
    const de = checkExternalCodeDuplicates(rows, existingCodes);
    const ce = checkReceiverConsistency(rows);
    if (ve.length + de.length + ce.length > 0) {
      showToast(`存在 ${ve.length + de.length + ce.length} 个校验错误，请修正后重试`, "error");
      return;
    }

    setSubmitting(true);
    setSubmitResult(null);
    const batchId = generateId();
    const payload = rows.map((r) => ({
      externalCode: r.externalCode, storeName: r.storeName,
      receiverName: r.receiverName, receiverPhone: r.receiverPhone, receiverAddress: r.receiverAddress,
      skuCode: r.skuCode, skuName: r.skuName, skuQuantity: Number(r.skuQuantity),
      skuSpec: r.skuSpec, remark: r.remark,
    }));

    const CHUNK = 500;
    let success = 0, failed = 0;
    const allErrors: { rowIndex: number; message: string }[] = [];
    setSubmitProgress({ current: 0, total: payload.length, percent: 0 });

    try {
      for (let i = 0; i < payload.length; i += CHUNK) {
        const part = payload.slice(i, i + CHUNK);
        const res = await submitOrders(part, batchId);
        success += res.success;
        failed += res.failed;
        allErrors.push(...res.errors.map((e) => ({ rowIndex: i + e.rowIndex, message: e.message })));
        const done = Math.min(i + CHUNK, payload.length);
        setSubmitProgress({ current: done, total: payload.length, percent: Math.round((done / payload.length) * 100) });
      }
      setSubmitResult({ success, failed, batchId, errors: allErrors });
      showToast(`提交完成：成功 ${success} 条，失败 ${failed} 条`, failed > 0 ? "error" : "success");
    } catch (err) {
      showToast(`提交失败：${err instanceof Error ? err.message : "未知错误"}`, "error");
    } finally {
      setSubmitting(false);
    }
  }, [rows, existingCodes, showToast]);

  const errorRowSet = useMemo(() => new Set(errors.map((e) => e.rowIndex)), [errors]);
  const totalErrorRows = errorRowSet.size;

  if (rows.length === 0) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <EmptyState
          title="暂无待预览数据"
          description="请返回首页上传文件并进行解析"
          action={
            <button onClick={() => router.push("/")} className="btn-primary gap-1.5">
              <ArrowLeft className="h-4 w-4" />返回首页
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-full px-4 py-8">
      {/* 顶部信息栏 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <button onClick={() => { if (isTestParse) window.close(); else router.push("/"); }} className="btn-ghost mb-2 gap-1">
            <ArrowLeft className="h-4 w-4" />{isTestParse ? "关闭预览" : "返回"}
          </button>
          <h1 className="text-xl font-bold text-[#1d2129]">
            数据预览与编辑
            {isTestParse && <span className="tag tag-orange ml-2 align-middle text-xs">试解析 · 只读测试</span>}
          </h1>
          <p className="text-xs text-[#86909c]">
            文件：{fileName} | 规则：{ruleName} | 解析耗时：{parseDuration}ms | 共 {rows.length} 条记录
            {totalErrorRows > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-[#cf1322]">
                <AlertCircle className="h-3 w-3" />{errors.length} 处错误
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button onClick={handleAddRow} className="btn-outline gap-1 text-sm">
            <Plus className="h-4 w-4" />新增行
          </button>
          <button onClick={handleExport} className="btn-outline gap-1 text-sm">
            <Download className="h-4 w-4" />导出Excel
          </button>
          {!isTestParse && (
            <button
              onClick={handleSubmit}
              disabled={submitting || totalErrorRows > 0}
              className="btn-primary gap-1.5 text-sm"
            >
              {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" />提交中...</>) : (<><Upload className="h-4 w-4" />提交下单</>)}
            </button>
          )}
        </div>
      </div>

      {/* 提交进度 */}
      {submitting && (
        <div className="mb-4">
          <ProgressBar percent={submitProgress.percent} label={`正在提交... ${submitProgress.current}/${submitProgress.total}`} />
        </div>
      )}

      {/* 提交结果 */}
      {submitResult && (
        <div className={`alert mb-4 ${submitResult.failed > 0 ? "alert-warning" : "alert-success"}`}>
          <CheckCircle className="inline-block h-4 w-4" />
          <span className="ml-2">
            提交完成：成功 <strong>{submitResult.success}</strong> 条
            {submitResult.failed > 0 && (<>，失败 <strong>{submitResult.failed}</strong> 条</>)}
          </span>
        </div>
      )}

      {/* 错误汇总（全部一次性展示，超出滚动） */}
      {errors.length > 0 && (
        <div className="alert alert-danger mb-4">
          <AlertCircle className="inline-block h-4 w-4" />
          <strong className="ml-1">共 {errors.length} 个校验错误：</strong>
          <ul className="mt-1 ml-6 max-h-40 list-disc overflow-y-auto text-xs">
            {errors.map((err, i) => (
              <li key={i}>第 {err.rowIndex + 1} 行 - {err.field}：{err.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 虚拟列表表格 */}
      <div className="card overflow-hidden !p-0">
        <div ref={parentRef} className="overflow-auto rounded-lg border border-[#e5e6eb]" style={{ maxHeight: "65vh" }}>
          <div style={{ width: totalWidth, position: "relative" }}>
            {/* 表头 */}
            <div
              className="sticky top-0 z-20 flex bg-[#e8fafa] text-[13px] font-semibold text-[#0b6e6e]"
              style={{ height: ROW_H }}
            >
              {COLUMNS.map((col) => (
                <div key={col.key} className="flex items-center border-b border-r border-[#d0e8e8] px-3" style={{ width: col.width }}>
                  {col.label}{col.required && <span className="ml-0.5 text-[#cf1322]">*</span>}
                </div>
              ))}
              <div className="flex items-center justify-center border-b border-[#d0e8e8] px-2" style={{ width: ACTION_W }}>操作</div>
            </div>

            {/* 虚拟行 */}
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const row = rows[vi.index];
                const hasRowError = errorRowSet.has(row.rowIndex);
                return (
                  <div
                    key={row.id || vi.index}
                    className="absolute left-0 flex text-xs"
                    style={{ top: 0, transform: `translateY(${vi.start}px)`, height: ROW_H, width: "100%", background: hasRowError ? "#fff1f0" : vi.index % 2 ? "#fafbfc" : "#fff" }}
                  >
                    {COLUMNS.map((col) => {
                      const fieldErrors = getFieldErrors(row.rowIndex, col.key);
                      const hasError = fieldErrors.length > 0;
                      const isEditing = editCell?.idx === vi.index && editCell?.col === col.key;
                      const value = col.key === "rowIndex" ? vi.index + 1 : row[col.key];
                      return (
                        <div
                          key={col.key}
                          onClick={() => handleCellClick(vi.index, col.key)}
                          className="relative flex items-center border-b border-r border-[#e5e6eb] px-3"
                          style={{ width: col.width, cursor: col.key === "rowIndex" ? "default" : "text", background: hasError ? "#fff1f0" : undefined, borderColor: hasError ? "#ffccc7" : undefined, color: col.key === "rowIndex" ? "#86909c" : "#4e5969" }}
                          title={hasError ? fieldErrors.map((e) => e.message).join("; ") : undefined}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              className="absolute inset-0 z-10 w-full border border-[#0fc6c2] bg-white px-3 text-xs shadow-[0_0_0_2px_rgba(15,198,194,0.15)] outline-none"
                              value={String(value ?? "")}
                              onChange={(e) => updateCell(vi.index, col.key, e.target.value)}
                              onBlur={() => setEditCell(null)}
                              onKeyDown={(e) => handleCellKeyDown(e, vi.index, col.key)}
                              type={col.key === "skuQuantity" ? "number" : "text"}
                              min={col.key === "skuQuantity" ? 1 : undefined}
                            />
                          ) : (
                            <span className="truncate">{String(value ?? "")}</span>
                          )}
                          {hasError && !isEditing && (
                            <span className="absolute right-1 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-[#cf1322] text-[9px] text-white">!</span>
                          )}
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-center border-b border-[#e5e6eb]" style={{ width: ACTION_W }}>
                      <button onClick={() => handleDeleteRow(vi.index)} className="p-1 text-[#cf1322] hover:opacity-70" title="删除行">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 数据统计 */}
      <div className="mt-4 flex items-center gap-4 text-xs text-[#86909c]">
        <span>总计 {rows.length} 行</span>
        <span className="text-[#cf1322]">错误行 {totalErrorRows}</span>
        <span className="text-[#17c964]">无错误行 {rows.length - totalErrorRows}</span>
      </div>
    </div>
  );
}
