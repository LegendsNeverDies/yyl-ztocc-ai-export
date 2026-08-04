import { NextResponse } from "next/server";
import { getMonitorSummary } from "@/lib/import-service";

// GET /api/import-monitor/summary — 监控聚合指标
export async function GET() {
  const summary = await getMonitorSummary();
  return NextResponse.json(summary);
}
