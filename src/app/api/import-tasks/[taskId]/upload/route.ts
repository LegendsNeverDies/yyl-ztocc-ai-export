import { NextRequest, NextResponse } from "next/server";
import { readFile } from "@/lib/file-reader";
import { attachParsedFileToTask } from "@/lib/import-service";

export async function POST(req: NextRequest, ctx: any) {
  try {
    const params = ctx?.params ?? {};
    const taskId = params.taskId as string | undefined;
    if (!taskId) {
      return NextResponse.json({ error: "缺少 taskId 参数" }, { status: 400 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "缺少 file 字段" }, { status: 400 });
    }

    // 解析文件（在 Worker 中也会解析，但在上传端需要获得 parsedFile 以便重建批次/Outbox）
    const parsedFile = await readFile(file);

    await attachParsedFileToTask(taskId, parsedFile);

    // 尝试触发一次后台消费
    const workerUrl = new URL(`/api/worker/run`, req.url);
    const workerHeaders: Record<string, string> = {};
    if (process.env.WORKER_API_KEY) {
      workerHeaders["x-worker-key"] = process.env.WORKER_API_KEY;
    }
    void fetch(workerUrl, { method: "POST", headers: workerHeaders }).catch(() => {});

    return NextResponse.json({ ok: true, task_id: taskId });
  } catch (error) {
    console.error("[import-tasks/upload] 上传并附加文件失败:", error);
    return NextResponse.json({ error: "上传失败", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
