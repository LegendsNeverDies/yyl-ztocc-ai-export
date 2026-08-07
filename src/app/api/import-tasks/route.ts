import { NextRequest, NextResponse } from "next/server";
import { createImportTask, createImportTaskFromMeta } from "@/lib/import-service";
import { getRule } from "@/lib/server-actions";
import { readFile } from "@/lib/file-reader";
import { db } from "@/lib/db";
import { importTasks } from "@/lib/db-schema";
import { desc, sql as drizzleSql } from "drizzle-orm";
import type { ImportTaskProgress, ParseRule } from "@/types";

// 规则进程内缓存（压测规则固定，热调用省 1 次 DB RTT）
const ruleCache = new Map<string, ParseRule>();

async function getRuleCached(ruleId: string): Promise<ParseRule | null> {
  const cached = ruleCache.get(ruleId);
  if (cached) return cached;
  const rule = await getRule(ruleId);
  if (rule) ruleCache.set(ruleId, rule);
  return rule;
}

// GET /api/import-tasks — 任务列表（分页）
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(url.searchParams.get("page_size") || "50", 10);

  const [countResult] = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(importTasks)
    .execute();
  const total = Number(countResult?.count || 0);

  const rows = await db
    .select({
      id: importTasks.id,
      file_name: importTasks.fileName,
      status: importTasks.status,
      total_rows: importTasks.totalRows,
      processed_rows: importTasks.processedRows,
      success_rows: importTasks.successRows,
      failed_rows: importTasks.failedRows,
      created_at: importTasks.createdAt,
    })
    .from(importTasks)
    .orderBy(desc(importTasks.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  type Row = {
    id: string;
    file_name: string;
    status: string;
    total_rows: number;
    processed_rows: number;
    success_rows: number;
    failed_rows: number;
    created_at: Date | null;
  };

  return NextResponse.json({
    rows: (rows as Row[]).map((r) => ({
      id: r.id,
      file_name: r.file_name,
      status: r.status,
      total_rows: r.total_rows,
      processed_rows: r.processed_rows,
      success_rows: r.success_rows,
      failed_rows: r.failed_rows,
      created_at: r.created_at?.toISOString() ?? "",
    })),
    total,
  });
}

/**
 * POST /api/import-tasks
 * 上传文件 + 规则ID → 创建异步导入任务 → 立即返回 task_id
 *
 * 设计要点：
 * - 文件解析（readFile）在服务端完成，因为 Worker 需要可重读的文件数据
 * - 解析只是把文件读为 RawRow 网格（不做规则解析），耗时通常 < 1s
 * - 任务创建 + 批次 + Outbox 在同一事务
 * - 上传接口不等待 Worker 处理
 *
 * 简化：文件数据直接存入 DB（JSONB），避免依赖外部对象存储
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const ruleId = formData.get("rule_id") as string | null;
    const batchSizeStr = formData.get("batch_size") as string | null;
    const totalRowsStr = formData.get("total_rows") as string | null;
    // 二步上传：第一步只传元数据，file_name 作为普通字段（file 可不传）
    const fileNameStr = (formData.get("file_name") as string | null) || (file ? file.name : null);

    // 二步上传第一步允许不传 file（只传 total_rows + file_name + file_type）
    if (!totalRowsStr && !file) {
      return NextResponse.json({ error: "缺少 file 或 total_rows 字段" }, { status: 400 });
    }
    if (!ruleId) {
      return NextResponse.json({ error: "缺少 rule_id 字段" }, { status: 400 });
    }

    // 校验规则存在
    const rule = await getRuleCached(ruleId);
    if (!rule) {
      return NextResponse.json({ error: `规则 ${ruleId} 不存在` }, { status: 404 });
    }
    // 如果前端提供了 total_rows（预扫描），采用二步上传方案：先创建任务并返回上传端点
    if (totalRowsStr) {
      const totalRows = Math.max(0, parseInt(totalRowsStr, 10));
      const batchSize = batchSizeStr ? Math.max(250, Math.min(2000, parseInt(batchSizeStr, 10))) : 1000;
      const created = await createImportTaskFromMeta({
        fileName: fileNameStr || "unknown",
        fileType: (formData.get("file_type") as string) === "pdf" ? "pdf" : "excel",
        ruleId,
        totalRows,
        batchSize,
      });

      const uploadUrl = new URL(`/api/import-tasks/${created.taskId}/upload`, req.url).toString();
      const elapsed = Date.now() - startTime;
      console.log(`[import-tasks] 任务预创建完成 task_id=${created.taskId} trace_id=${created.traceId} rows=${created.totalRows} batches=${created.totalBatches} 耗时=${elapsed}ms`);

      return NextResponse.json({
        task_id: created.taskId,
        trace_id: created.traceId,
        status: "PENDING",
        total_rows: created.totalRows,
        total_batches: created.totalBatches,
        upload_url: uploadUrl,
      });
    }

    // 读取文件为 RawRow 网格（不做规则解析）——兼容旧流程（注意：会阻塞请求）
    // 走到此处说明未走二步上传分支（totalRowsStr 为空），前面已校验 file 必存在
    const parsedFile = await readFile(file as File);

    // 预扫描总行数（parsedFile.rows 即总行数，包含表头等非数据行；Worker 会按规则过滤）
    const batchSize = batchSizeStr ? Math.max(250, Math.min(2000, parseInt(batchSizeStr, 10))) : 1000;

    // 创建任务（同事务写入任务+批次+Outbox+解析切片+trace）
    // 解析前置：上传时就 parseFile 一次，结果按批存 import_task_rows，worker 只读切片
    const created = await createImportTask({
      fileName: (file as File).name,
      fileType: parsedFile.fileType,
      ruleId,
      rule,
      parsedFile,
      batchSize,
    });

    // 触发一次后台消费：上传成功后立即尝试拉起 Worker，避免完全依赖外部 Cron
    const workerUrl = new URL("/api/worker/run", req.url);
    const workerHeaders: Record<string, string> = {};
    if (process.env.WORKER_API_KEY) {
      workerHeaders["x-worker-key"] = process.env.WORKER_API_KEY;
    }
    void fetch(workerUrl, { method: "POST", headers: workerHeaders })
      .then((res) => {
        if (!res.ok) {
          console.error("[import-tasks] trigger worker/run failed", res.status, res.statusText);
        }
      })
      .catch((err) => {
        console.error("[import-tasks] trigger worker/run error", err);
      });

    const elapsed = Date.now() - startTime;
    console.log(`[import-tasks] 任务创建完成 task_id=${created.taskId} trace_id=${created.traceId} rows=${created.totalRows} batches=${created.totalBatches} 耗时=${elapsed}ms`);

    return NextResponse.json({
      task_id: created.taskId,
      trace_id: created.traceId,
      status: "PENDING",
      total_rows: created.totalRows,
      total_batches: created.totalBatches,
    });
  } catch (error) {
    console.error("[import-tasks] 创建任务失败:", error);
    return NextResponse.json(
      { error: "创建导入任务失败", message: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
