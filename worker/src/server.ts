import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 加载 .env.local（项目根目录）
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env.local") });

import Fastify from "fastify";
import { runWorker } from "../../src/lib/import-worker.ts";
import { runDispatcher } from "../../src/lib/outbox-dispatcher.ts";
import { CONFIG } from "../../src/lib/config.ts";

const PORT = parseInt(process.env.PORT || "8080");

const app = Fastify({ logger: true });

// 简易并发闸：限制同时处理的批次数，避免打满 DB 连接池
let inflight = 0;

app.get("/healthz", async () => ({ ok: true, inflight, concurrency: CONFIG.WORKER_CONCURRENCY }));

/**
 * POST /jobs/process-batch — 处理单个批次 Job
 * 由 Dispatcher 投递（QStash / 本地直投）
 */
app.post("/jobs/process-batch", async (request, reply) => {
  const payload = request.body as { task_id?: string; unit_id?: string };
  if (!payload?.task_id || !payload?.unit_id) {
    return reply.code(400).send({ ok: false, reason: "missing task_id/unit_id" });
  }

  // 并发闸：限制同时处理的批次数
  if (inflight >= CONFIG.WORKER_CONCURRENCY) {
    return reply.code(503).send({ ok: false, reason: "worker busy" });
  }

  inflight++;
  try {
    request.log.info({ task: payload.task_id, unit: payload.unit_id }, "process-batch start");
    // 复用 runWorker：它会原子 CAS claim 并处理
    const result = await runWorker();
    request.log.info({ task: payload.task_id, unit: payload.unit_id, processed: result.processed }, "process-batch done");
    return reply.code(200).send({ ok: true, processed: result.processed });
  } catch (e) {
    request.log.error({ err: e }, "process-batch uncaught");
    return reply.code(500).send({ ok: false, reason: e instanceof Error ? e.message : "unknown" });
  } finally {
    inflight--;
  }
});

/**
 * POST /jobs/run-worker — 兜底触发：处理所有 PENDING 批次
 * 由 Vercel Cron 或上传后 fire-and-forget 调用
 */
app.post("/jobs/run-worker", async (request, reply) => {
  // 鉴权
  const apiKey = request.headers["x-worker-key"] as string | undefined;
  if (process.env.WORKER_API_KEY && apiKey !== process.env.WORKER_API_KEY) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  try {
    // 1. Dispatcher：投递 Outbox 事件
    const dispatchResult = await runDispatcher();
    // 2. Worker：处理批次
    const workerResult = await runWorker();
    return reply.code(200).send({
      ok: true,
      dispatched: dispatchResult.dispatched,
      dispatch_failed: dispatchResult.failed,
      batches_processed: workerResult.processed,
    });
  } catch (e) {
    request.log.error({ err: e }, "run-worker uncaught");
    return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : "unknown" });
  }
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`worker listening on :${PORT}, concurrency=${CONFIG.WORKER_CONCURRENCY}`);
});

// ============================================================================
// 触发式 dispatch 兜底轮询（Vercel Hobby cron 不频繁，由常驻 worker 主动拉）
// ============================================================================
const DISPATCH_POLL_URL = process.env.DISPATCH_POLL_URL;
const DISPATCH_POLL_INTERVAL_S = Math.max(3, Number(process.env.DISPATCH_POLL_INTERVAL_S || 10));
if (DISPATCH_POLL_URL && process.env.CRON_SECRET) {
  app.log.info(`dispatch poll enabled: ${DISPATCH_POLL_URL} every ${DISPATCH_POLL_INTERVAL_S}s`);
  const poll = async () => {
    try {
      await fetch(DISPATCH_POLL_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
    } catch (e) {
      app.log.warn({ err: e instanceof Error ? e.message : e }, "dispatch poll failed (will retry)");
    }
  };
  setTimeout(poll, 5_000);
  setInterval(poll, DISPATCH_POLL_INTERVAL_S * 1000);
} else {
  app.log.info("dispatch poll disabled (set DISPATCH_POLL_URL + CRON_SECRET to enable)");
}
