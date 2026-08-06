import { NextResponse } from "next/server";
import { getMonitorSummary } from "@/lib/import-service";

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "未知错误";
}

// GET /api/import-monitor/summary — 监控聚合指标
export async function GET() {
  try {
    const summary = await getMonitorSummary();
    return NextResponse.json(summary);
  } catch (error) {
    const message = getErrorMessage(error);
    console.error("Failed to build import monitor summary", error);
    return NextResponse.json({
      throughput: [],
      queue_backlog: {
        pending_batches: 0,
        pending_rows: 0,
        processing_batches: 0,
        processing_rows: 0,
        status: "ok",
      },
      stage_duration: [],
      error_distribution: [],
      slow_batches_top10: [],
      failed_tasks_recent: [],
      debug_message: message,
      debug_details: ["监控聚合查询失败", "请检查数据库连接、表是否存在，或 SQL 语句是否兼容当前环境"],
    });
  }
}
