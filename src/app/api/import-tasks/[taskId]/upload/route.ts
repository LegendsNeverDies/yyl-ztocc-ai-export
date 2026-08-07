import { NextRequest, NextResponse } from "next/server";
import { readFile } from "@/lib/file-reader";
import { attachParsedFileToTask } from "@/lib/import-service";
import { getRule } from "@/lib/server-actions";
import { db } from "@/lib/db";
import { importTasks } from "@/lib/db-schema";
import { eq } from "drizzle-orm";

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params;
    if (!taskId) {
      return NextResponse.json({ error: "缺少 taskId 参数" }, { status: 400 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "缺少 file 字段" }, { status: 400 });
    }

    // 读取文件为 ParsedFile
    const parsedFile = await readFile(file);

    // 查任务关联的 ruleId 并加载规则（解析前置需要 rule）
    const taskRows = await db.select({ ruleId: importTasks.ruleId }).from(importTasks).where(eq(importTasks.id, taskId)).limit(1);
    if (taskRows.length === 0) {
      return NextResponse.json({ error: `任务 ${taskId} 不存在` }, { status: 404 });
    }
    const rule = await getRule(taskRows[0].ruleId);
    if (!rule) {
      return NextResponse.json({ error: `规则 ${taskRows[0].ruleId} 不存在` }, { status: 404 });
    }

    // 附加文件：解析前置 + 真事务重建批次/outbox/解析切片
    await attachParsedFileToTask(taskId, parsedFile, rule);

    // 尝试触发一次后台消费
    const workerUrl = new URL(`/api/worker/run`, req.url);
    const workerHeaders: Record<string, string> = {};
    if (process.env.WORKER_API_KEY) {
      workerHeaders["x-worker-key"] = process.env.WORKER_API_KEY;
    }
    void fetch(workerUrl, { method: "POST", headers: workerHeaders })
      .then((res) => {
        if (!res.ok) {
          console.error("[import-tasks/upload] trigger worker/run failed", res.status, res.statusText);
        }
      })
      .catch((err) => {
        console.error("[import-tasks/upload] trigger worker/run error", err);
      });

    return NextResponse.json({ ok: true, task_id: taskId });
  } catch (error) {
    console.error("[import-tasks/upload] 上传并附加文件失败:", error);
    return NextResponse.json({ error: "上传失败", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
