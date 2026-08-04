import { NextRequest, NextResponse } from "next/server";
import { getTraceEvents } from "@/lib/import-service";

// GET /api/traces/:traceId — 查询 trace 时间线事件
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ traceId: string }> }
) {
  const { traceId } = await params;
  const rows = await getTraceEvents(traceId);
  return NextResponse.json({ trace_id: traceId, events: rows });
}
