import { NextRequest, NextResponse } from "next/server";
import { getTaskBatches } from "@/lib/import-service";

// GET /api/import-tasks/:taskId/batches — 查询批次性能日志
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const rows = await getTaskBatches(taskId);
  return NextResponse.json({ rows });
}
