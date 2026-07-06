"use server";

import { db, sql } from "@/lib/db";
import { parseRules, shipments, orders } from "@/lib/db-schema";
import { eq, ilike, desc, and, inArray, sql as drizzleSql } from "drizzle-orm";
import type { ParseRule } from "@/types";
import { generateId } from "@/lib/utils";

// ====== 规则 CRUD ======
export async function saveRule(rule: Omit<ParseRule, "id" | "createdAt" | "updatedAt">): Promise<string> {
  const id = generateId();
  const config = JSON.parse(JSON.stringify(rule));

  await db.insert(parseRules).values({
    id,
    name: rule.name,
    description: rule.description,
    config,
  });

  return id;
}

export async function updateRule(id: string, rule: Omit<ParseRule, "id" | "createdAt" | "updatedAt">): Promise<void> {
  const config = JSON.parse(JSON.stringify(rule));

  await db
    .update(parseRules)
    .set({
      name: rule.name,
      description: rule.description,
      config,
      updatedAt: new Date(),
    })
    .where(eq(parseRules.id, id));
}

export async function deleteRule(id: string): Promise<void> {
  await db.delete(parseRules).where(eq(parseRules.id, id));
}

// 复制规则：读取原规则 → 以"原名 - 副本"另存
export async function duplicateRule(id: string): Promise<string> {
  const rule = await getRule(id);
  if (!rule) throw new Error("规则不存在");
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = rule;
  return saveRule({ ...rest, name: `${rule.name} - 副本` });
}

export async function getRule(id: string): Promise<ParseRule | null> {
  const result = await db.select().from(parseRules).where(eq(parseRules.id, id)).limit(1);
  if (result.length === 0) return null;

  const row = result[0];
  return {
    id: row.id,
    ...(row.config as Omit<ParseRule, "id" | "createdAt" | "updatedAt">),
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
  } as ParseRule;
}

export async function getAllRules(): Promise<ParseRule[]> {
  const result = await db.select().from(parseRules).orderBy(desc(parseRules.updatedAt));

  return result.map((row) => ({
    id: row.id,
    ...(row.config as Omit<ParseRule, "id" | "createdAt" | "updatedAt">),
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
  })) as ParseRule[];
}

// ====== 运单 CRUD ======
type SubmitRow = { externalCode: string; storeName: string; receiverName: string; receiverPhone: string; receiverAddress: string; skuCode: string; skuName: string; skuQuantity: number; skuSpec: string; remark: string };

// 按外部编码聚合写入主子表：一个外部编码=一条 shipment + 多条 orders 明细；无外部编码的行各自独立成单
export async function submitOrders(
  orderRows: SubmitRow[],
  batchId: string
): Promise<{ success: number; failed: number; errors: { rowIndex: number; message: string }[] }> {
  // 分组：有外编码按编码聚合，无编码每行独立
  const groups = new Map<string, SubmitRow[]>();
  orderRows.forEach((row, idx) => {
    const code = row.externalCode?.trim();
    const key = code ? `code:${code}` : `row:${idx}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  });

  // 预构建所有 shipment + order 数据
  const shipmentRows: (typeof shipments.$inferInsert)[] = [];
  const orderRowsAll: (typeof orders.$inferInsert)[] = [];

  for (const group of groups.values()) {
    const shipmentId = generateId();
    const code = group[0].externalCode?.trim() || null;
    const pick = (f: keyof SubmitRow): string | null => {
      for (const r of group) {
        const v = String(r[f] ?? "").trim();
        if (v) return v;
      }
      return null;
    };
    const totalQty = group.reduce((s, r) => s + (Number(r.skuQuantity) || 0), 0);

    shipmentRows.push({
      id: shipmentId,
      externalCode: code,
      storeName: pick("storeName"),
      receiverName: pick("receiverName"),
      receiverPhone: pick("receiverPhone"),
      receiverAddress: pick("receiverAddress"),
      remark: pick("remark"),
      skuCount: group.length,
      totalQuantity: String(totalQty),
      batchId,
    });

    for (const r of group) {
      orderRowsAll.push({
        shipmentId,
        skuCode: r.skuCode,
        skuName: r.skuName,
        skuQuantity: String(r.skuQuantity),
        skuSpec: r.skuSpec || null,
        remark: r.remark || null,
      });
    }
  }

  // 批量插入：shipments 和 orders 分批并发
  const SHIPMENT_BATCH = 100;
  const ORDER_BATCH = 500;

  const shipmentBatches: Promise<typeof shipments.$inferSelect[]>[] = [];
  for (let i = 0; i < shipmentRows.length; i += SHIPMENT_BATCH) {
    shipmentBatches.push(db.insert(shipments).values(shipmentRows.slice(i, i + SHIPMENT_BATCH)).returning());
  }

  const orderBatches: Promise<typeof orders.$inferSelect[]>[] = [];
  for (let i = 0; i < orderRowsAll.length; i += ORDER_BATCH) {
    orderBatches.push(db.insert(orders).values(orderRowsAll.slice(i, i + ORDER_BATCH)).returning());
  }

  // 先插 shipments（主表），再插 orders（子表，有外键依赖）
  let success = 0;
  let failed = 0;
  const errors: { rowIndex: number; message: string }[] = [];

  try {
    await Promise.all(shipmentBatches);
  } catch (e) {
    failed += orderRows.length;
    errors.push({ rowIndex: -1, message: `主表写入失败：${e instanceof Error ? e.message : String(e)}` });
    return { success, failed, errors };
  }

  try {
    await Promise.all(orderBatches);
    success = orderRows.length;
  } catch (e) {
    failed += orderRows.length;
    errors.push({ rowIndex: -1, message: `明细表写入失败：${e instanceof Error ? e.message : String(e)}` });
  }

  return { success, failed, errors };
}

export async function getExistingExternalCodes(codes?: string[]): Promise<Set<string>> {
  // 外部编码现存于主表 shipments；传入 codes 时只查这些（避免全表拉取）
  if (codes && codes.length === 0) return new Set();

  const whereClause = codes && codes.length > 0
    ? and(drizzleSql`${shipments.externalCode} IS NOT NULL`, inArray(shipments.externalCode, codes))
    : drizzleSql`${shipments.externalCode} IS NOT NULL`;

  const result = await db
    .select({ code: shipments.externalCode })
    .from(shipments)
    .where(whereClause);

  return new Set(result.map((r) => r.code).filter(Boolean) as string[]);
}

// 运单（主表）分页查询
export async function getShipmentsPage(
  page: number,
  pageSize: number,
  search?: string,
  receiverName?: string,
  startDate?: string,
  endDate?: string
): Promise<{ rows: typeof shipments.$inferSelect[]; total: number }> {
  const conditions = [];

  if (search) conditions.push(ilike(shipments.externalCode, `%${search}%`));
  if (receiverName) conditions.push(ilike(shipments.receiverName, `%${receiverName}%`));
  if (startDate) conditions.push(drizzleSql`${shipments.submittedAt} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(drizzleSql`${shipments.submittedAt} <= ${new Date(endDate + "T23:59:59")}`);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(shipments)
    .where(whereClause)
    .execute();

  const total = Number(countResult?.count || 0);

  const rows = await db
    .select()
    .from(shipments)
    .where(whereClause)
    .orderBy(desc(shipments.submittedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { rows, total };
}

// 单条运单的 SKU 明细
export async function getShipmentDetail(shipmentId: string): Promise<typeof orders.$inferSelect[]> {
  return db.select().from(orders).where(eq(orders.shipmentId, shipmentId));
}
