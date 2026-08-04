import { NextResponse } from "next/server";
import { getAllRules } from "@/lib/server-actions";

// GET /api/rules/list — 规则列表（供压测脚本和外部使用）
export async function GET() {
  try {
    const rules = await getAllRules();
    return NextResponse.json({
      rules: rules.map((r) => ({ id: r.id, name: r.name, parseMode: r.parseMode, fileType: r.fileType, description: r.description })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
