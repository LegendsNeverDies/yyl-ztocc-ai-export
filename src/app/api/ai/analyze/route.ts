import { NextRequest, NextResponse } from "next/server";
import { generateRule } from "@/lib/ai-client";
import type { RawRow } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const { rows, fileType, fileName } = await request.json();

    if (!rows || !fileType || !fileName) {
      return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
    }

    const parsedRows: RawRow[] = rows;
    const result = await generateRule(parsedRows, fileType, fileName);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[AI analyze] error:", message, error);
    return NextResponse.json({ error: message || "AI 分析失败" }, { status: 500 });
  }
}
