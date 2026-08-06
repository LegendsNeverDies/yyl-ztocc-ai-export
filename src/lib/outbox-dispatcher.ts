import "server-only";
import { db, query, withTransaction } from "@/lib/db";
import { eventOutbox } from "@/lib/db-schema";
import { eq, and, lte, sql as drizzleSql } from "drizzle-orm";
import { recordTrace } from "@/lib/import-worker";
import { CONFIG } from "@/lib/config";

/**
 * Outbox Dispatcher：轮询 event_outbox 中 PENDING 事件并真正投递到 Worker
 *
 * 改造点（借鉴 oms-v4）：
 * - 事务内 FOR UPDATE SKIP LOCKED 锁定 pending 事件（防并发重复投递）
 * - 真正 POST 到 Worker（本地 /api/worker/run 或独立 worker 进程）
 * - 投递成功标记 SENT，失败 retry_count++ + 退避
 *
 * 幂等性：Worker 以 (task_id, unit_id) 原子 CAS 去重，重复投递不会重复入库。
 */
export async function runDispatcher(): Promise<{ dispatched: number; failed: number }> {
  // 事务内 FOR UPDATE SKIP LOCKED 锁定一批 pending，避免多实例重复投递
  let pendingRows: { id: string; aggregate_id: string; event_type: string; trace_id: string; payload: any; retry_count: number }[] = [];
  try {
    const res = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, aggregate_id, event_type, trace_id, payload, retry_count
         FROM event_outbox
         WHERE status = 'PENDING' AND next_retry_at <= NOW()
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [CONFIG.DISPATCH_BATCH_LIMIT]
      );
      return rows;
    });
    pendingRows = res as typeof pendingRows;
  } catch (e) {
    console.error("[dispatcher] 查询 pending 事件失败:", e);
    return { dispatched: 0, failed: 0 };
  }

  let dispatched = 0;
  let failed = 0;

  for (const evt of pendingRows) {
    try {
      // 真正投递：POST 到 worker
      // 优先用独立的 WORKER_PUBLIC_URL（常驻 worker），否则 fallback 到本地 /api/worker/run
      const workerUrl = process.env.WORKER_PUBLIC_URL
        ? `${process.env.WORKER_PUBLIC_URL}/jobs/process-batch`
        : null;

      if (workerUrl) {
        // 投递到独立 worker 进程
        const resp = await fetch(workerUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(process.env.WORKER_API_KEY ? { "x-worker-key": process.env.WORKER_API_KEY } : {}) },
          body: JSON.stringify(evt.payload),
        });
        if (!resp.ok) {
          throw new Error(`worker responded ${resp.status}`);
        }
      } else {
        // 无独立 worker：fire-and-forget 触发本地 /api/worker/run（它内部会 claim 批次）
        const localWorkerUrl = process.env.WEB_INTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        void fetch(`${localWorkerUrl}/api/worker/run`, {
          method: "POST",
          headers: { ...(process.env.WORKER_API_KEY ? { "x-worker-key": process.env.WORKER_API_KEY } : {}) },
        }).catch(() => {});
      }

      // 标记 SENT
      await db
        .update(eventOutbox)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(eventOutbox.id, evt.id));

      await recordTrace(
        evt.trace_id,
        evt.aggregate_id,
        (evt.payload?.payload?.payload?.unit_id as string) ?? null,
        `${evt.event_type}Dispatched`,
        "SENT",
        `事件 ${evt.event_type} 已投递至 Worker 队列`
      );
      dispatched++;
    } catch (e) {
      // 投递失败：retry_count++ + 退避
      const nextRetry = newRetryAt(evt.retry_count + 1);
      const newStatus = evt.retry_count + 1 >= CONFIG.OUTBOX_MAX_RETRY ? "FAILED" : "PENDING";
      await db
        .update(eventOutbox)
        .set({
          status: newStatus,
          retryCount: evt.retry_count + 1,
          nextRetryAt: nextRetry,
        })
        .where(eq(eventOutbox.id, evt.id));
      failed++;
      console.error(`[dispatcher] 投递事件 ${evt.id} 失败:`, e instanceof Error ? e.message : e);
    }
  }

  return { dispatched, failed };
}

function newRetryAt(retryCount: number): Date {
  // 指数退避：2^retry * 1秒，上限 60 秒
  const delayMs = Math.min(Math.pow(2, retryCount) * 1000, 60_000);
  return new Date(Date.now() + delayMs);
}
