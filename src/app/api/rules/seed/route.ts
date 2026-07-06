import { NextResponse } from "next/server";
import { seedDemoRules } from "@/lib/seed-rules";

// POST /api/rules/seed — 初始化内置规则到数据库
export async function POST() {
  try {
    const count = await seedDemoRules();
    return NextResponse.json({ success: true, count });
  } catch (error) {
    console.error("Seed failed:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
