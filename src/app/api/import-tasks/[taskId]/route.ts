import { NextRequest, NextResponse } from "next/server";
import { getTaskProgress } from "@/lib/import-service";

// GET /api/import-tasks/:taskId — 查询任务进度
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const progress = await getTaskProgress(taskId);
  if (!progress) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }
  return NextResponse.json(progress);
}
