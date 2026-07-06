import * as XLSX from "xlsx";
import type { RawRow, ParsedFile } from "@/types";

export async function readExcel(file: File): Promise<ParsedFile> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });

  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
    });

    const rows: RawRow[] = (jsonData as unknown as unknown[][]).map((rowArr, idx) => ({
      rowNum: idx + 1,
      cells: rowArr.map((cell) => {
        if (cell === null || cell === undefined) return null;
        return String(cell);
      }),
    }));

    return { name, rows };
  });

  const allRows = sheets.length > 0 ? sheets[0].rows : [];

  return {
    fileName: file.name,
    fileType: "excel",
    sheets: sheets.length > 1 ? sheets : undefined,
    rows: allRows,
  };
}

export async function readPdf(file: File): Promise<ParsedFile> {
  const pdfjsLib = await import("pdfjs-dist");
  // 使用项目自带的 worker（版本与 pdfjs-dist 必然一致、无需外网）。
  // 注意：升级 pdfjs-dist 后需重新执行 `cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/`
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  // 收集所有页所有文本片段（保留 x 坐标），跨页拼接为统一的行集合
  interface Frag { x: number; y: number; page: number; str: string }
  const frags: Frag[] = [];
  let sampleText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageFrags: Frag[] = [];

    for (const item of textContent.items) {
      if ("str" in item && "transform" in item) {
        const text = item.str.trim();
        if (!text) continue;
        pageFrags.push({ x: item.transform[4], y: item.transform[5], page: i, str: text });
      }
    }
    frags.push(...pageFrags);

    // sampleText：按 y 还原阅读顺序，供 AI 分析
    const sortedLines = groupByLine(pageFrags);
    sampleText += `--- Page ${i} ---\n${sortedLines.map((l) => l.map((f) => f.str).join(" ")).join("\n")}\n\n`;
  }

  // 全局列锚点：所有片段的 x 排序后按间距分桶
  const colAnchors = computeColumnAnchors(frags.map((f) => f.x));

  // 按 (page, y) 聚类成行，行内片段按列锚点归位，输出对齐网格
  const lineGroups = groupByLine(frags);
  const allRows: RawRow[] = lineGroups.map((line, idx) => {
    const cells: (string | null)[] = new Array(colAnchors.length).fill(null);
    for (const f of line) {
      const ci = nearestAnchor(f.x, colAnchors);
      cells[ci] = cells[ci] ? `${cells[ci]} ${f.str}` : f.str;
    }
    return { rowNum: idx + 1, cells };
  });

  return {
    fileName: file.name,
    fileType: "pdf",
    rows: allRows,
    sampleText,
  };
}

// 把文本片段按 (page, y) 聚类成行（同页 y 接近为一行），返回每行片段（按 x 升序）
function groupByLine<T extends { x: number; y: number; page?: number }>(frags: T[], yTol = 4): T[][] {
  const sorted = [...frags].sort((a, b) => {
    const pa = a.page ?? 0, pb = b.page ?? 0;
    if (pa !== pb) return pa - pb;
    return b.y - a.y; // PDF 坐标系 y 向上，越大越靠上
  });
  const lines: T[][] = [];
  let current: T[] = [];
  let lastY: number | null = null;
  let lastPage: number | null = null;
  for (const f of sorted) {
    const pg = f.page ?? 0;
    if (lastY === null || pg !== lastPage || Math.abs(f.y - lastY) > yTol) {
      if (current.length) lines.push(current.sort((a, b) => a.x - b.x));
      current = [f];
    } else {
      current.push(f);
    }
    lastY = f.y;
    lastPage = pg;
  }
  if (current.length) lines.push(current.sort((a, b) => a.x - b.x));
  return lines;
}

// 由所有 x 值聚类出列锚点：排序后相邻间距 > gapTol 视为新列，锚点取桶内均值
function computeColumnAnchors(xs: number[], gapTol = 20): number[] {
  if (xs.length === 0) return [];
  const sorted = [...xs].sort((a, b) => a - b);
  const anchors: number[] = [];
  let bucket: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gapTol) {
      anchors.push(bucket.reduce((s, v) => s + v, 0) / bucket.length);
      bucket = [];
    }
    bucket.push(sorted[i]);
  }
  anchors.push(bucket.reduce((s, v) => s + v, 0) / bucket.length);
  return anchors;
}

// 找最接近的列锚点下标
function nearestAnchor(x: number, anchors: number[]): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const d = Math.abs(x - anchors[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export async function readFile(file: File): Promise<ParsedFile> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    return readExcel(file);
  }
  if (ext === "pdf") {
    return readPdf(file);
  }
  throw new Error(`不支持的文件格式: .${ext}`);
}
