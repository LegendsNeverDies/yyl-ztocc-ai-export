import "server-only";
import { db } from "@/lib/db";
import { eventOutbox } from "@/lib/db-schema";
import { eq, and, lte, sql as drizzleSql } from "drizzle-orm";
import { recordTrace } from "@/lib/import-worker";

const MAX_DISPATCH_PER_RUN = 50;
const MAX_RETRY = 5;

/**
 * Outbox Dispatcher：轮询 event_outbox 中 PENDING 事件并"投递"
 *
 * 在本架构中，Worker 通过轮询 import_task_batches 表直接拉取 PENDING 批次，
 * Outbox 事件主要作为"可靠事件记录"——保证任务创建与事件写入同事务。
 * Dispatcher 的职责是：把 PENDING 事件标记为 SENT（已投递给 Worker 消费链路），
 * 并记录 trace。这样即使服务在"任务已创建但消息未投递"时宕机，
 * 恢复后 Dispatcher 会继续把 PENDING 事件标记为 SENT，Worker 仍会消费对应批次。
 *
 * 幂等性：Worker 以 (task_id, unit_id) 为去重键，重复消费不会重复入库。
 */
export async function runDispatcher(): Promise<{ dispatched: number; failed: number }> {
  const now = new Date();
  // 拉取待投递事件（PENDING 且 next_retry_at <= now）
  const pending = await db
    .select()
    .from(eventOutbox)
    .where(and(eq(eventOutbox.status, "PENDING"), lte(eventOutbox.nextRetryAt, now)))
    .limit(MAX_DISPATCH_PER_RUN);

  let dispatched = 0;
  let failed = 0;

  for (const evt of pending) {
    try {
      // 投递：标记为 SENT
      // 在更完整的实现中，这里会 queue.add(evt.payload) 到 Redis/BullMQ
      // 本架构中 Worker 直接轮询 import_task_batches，故只需标记 SENT + 记 trace
      await db
        .update(eventOutbox)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(eventOutbox.id, evt.id));

      await recordTrace(
        evt.traceId,
        evt.aggregateId,
        ((evt.payload as { payload?: { payload?: { unit_id?: string } } })?.payload?.payload?.unit_id) ?? null,
        `${evt.eventType}Dispatched`,
        "SENT",
        `事件 ${evt.eventType} 已投递至 Worker 队列`
      );
      dispatched++;
    } catch {
      // 投递失败：retryCount+1，设置退避
      const nextRetry = newRetryAt(evt.retryCount + 1);
      const newStatus = evt.retryCount + 1 >= MAX_RETRY ? "FAILED" : "PENDING";
      await db
        .update(eventOutbox)
        .set({
          status: newStatus,
          retryCount: evt.retryCount + 1,
          nextRetryAt: nextRetry,
        })
        .where(eq(eventOutbox.id, evt.id));
      failed++;
    }
  }

  return { dispatched, failed };
}

function newRetryAt(retryCount: number): Date {
  // 指数退避：2^retry * 1秒，上限 60 秒
  const delayMs = Math.min(Math.pow(2, retryCount) * 1000, 60_000);
  return new Date(Date.now() + delayMs);
}
