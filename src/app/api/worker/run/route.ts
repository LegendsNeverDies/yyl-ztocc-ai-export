import { NextRequest, NextResponse } from "next/server";
import { runWorker } from "@/lib/import-worker";
import { runDispatcher } from "@/lib/outbox-dispatcher";

/**
 * POST /api/worker/run
 * Worker 触发端点：由 Vercel Cron 或外部定时器调用
 * 每次调用：1) 投递 Outbox 事件 2) 拉取并处理 PENDING 批次
 *
 * 配置：在 vercel.json 中添加 cron，或外部定时器每 5-10 秒调用一次
 * 鉴权：通过 WORKER_API_KEY 环境变量保护（仅 Cron 或已知调用方可访问）
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-worker-key") || req.nextUrl.searchParams.get("key");
  const expectedKey = process.env.WORKER_API_KEY;
  const sameOrigin = req.headers.get("sec-fetch-site") === "same-origin";
  if (expectedKey && apiKey !== expectedKey && !sameOrigin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  try {
    // 1. Dispatcher：投递 Outbox 事件
    const dispatchResult = await runDispatcher();

    // 2. Worker：处理批次
    const workerResult = await runWorker();

    const elapsed = Date.now() - startTime;
    return NextResponse.json({
      ok: true,
      elapsed_ms: elapsed,
      dispatched: dispatchResult.dispatched,
      dispatch_failed: dispatchResult.failed,
      batches_processed: workerResult.processed,
      results: workerResult.results,
    });
  } catch (error) {
    console.error("[worker/run] 失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// GET 也支持（便于 Vercel Cron 直接调用）
export const GET = POST;
