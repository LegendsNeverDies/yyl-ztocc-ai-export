import type { RawRow, ParsedFile } from "@/types";

/**
 * 敏感字段脱敏：手机号保留前3后4，地址保留前6字符
 */
export function maskSensitive(field: string, value: string): string {
  if (!value) return "";
  if (field === "receiverPhone") {
    // 138****1234
    if (value.length >= 7) {
      return value.slice(0, 3) + "****" + value.slice(-4);
    }
    return "****";
  }
  if (field === "receiverAddress") {
    if (value.length > 6) return value.slice(0, 6) + "***";
    return "***";
  }
  return value;
}

/**
 * 将 ParsedFile 压缩为可存入 DB 的精简结构（去掉冗余字段）
 * 注意：RawRow.cells 中的 null 会保留，以便 Worker 重建 ParsedFile
 */
export function serializeParsedFile(parsed: ParsedFile): unknown {
  return {
    fileName: parsed.fileName,
    fileType: parsed.fileType,
    rows: parsed.rows.map((r) => ({ rn: r.rowNum, c: r.cells })),
    sheets: parsed.sheets?.map((s) => ({
      name: s.name,
      rows: s.rows.map((r) => ({ rn: r.rowNum, c: r.cells })),
    })),
    sampleText: parsed.sampleText,
  };
}

/**
 * 从 DB 存储的精简结构重建 ParsedFile
 */
export function deserializeParsedFile(data: unknown): ParsedFile {
  const d = data as {
    fileName: string;
    fileType: "excel" | "pdf";
    rows: { rn: number; c: (string | number | null)[] }[];
    sheets?: { name: string; rows: { rn: number; c: (string | number | null)[] }[] }[];
    sampleText?: string;
  };
  return {
    fileName: d.fileName,
    fileType: d.fileType,
    rows: d.rows.map((r) => ({ rowNum: r.rn, cells: r.c })),
    sheets: d.sheets?.map((s) => ({
      name: s.name,
      rows: s.rows.map((r) => ({ rowNum: r.rn, cells: r.c })),
    })),
    sampleText: d.sampleText,
  };
}
