import { NextRequest, NextResponse } from "next/server";
import { getTaskErrors } from "@/lib/import-service";

// GET /api/import-tasks/:taskId/errors?batch=&error_code=&page=&page_size=
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const url = new URL(req.url);
  const batch = url.searchParams.get("batch");
  const errorCode = url.searchParams.get("error_code") || undefined;
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(url.searchParams.get("page_size") || "50", 10);

  const result = await getTaskErrors(taskId, {
    batch: batch ? parseInt(batch, 10) : undefined,
    errorCode,
    page,
    pageSize,
  });
  return NextResponse.json(result);
}
