import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shipments } from "@/lib/db-schema";
import { sql, desc, isNotNull } from "drizzle-orm";
import { checkExternalAuth, unauthorizedResponse } from "@/lib/external-auth";

/**
 * GET /api/external/waybills?page=1&pageSize=20
 * 列表同步（V3 拉取运单列表初始化/增量同步本地快照）
 */
export async function GET(req: NextRequest) {
  if (!checkExternalAuth(req)) return unauthorizedResponse();
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") || 20)));
  const offset = (page - 1) * pageSize;

  const rows = await db
    .select({
      id: shipments.id,
      externalCode: shipments.externalCode,
      storeName: shipments.storeName,
      receiverName: shipments.receiverName,
      receiverPhone: shipments.receiverPhone,
      receiverAddress: shipments.receiverAddress,
      skuCount: shipments.skuCount,
      totalQuantity: shipments.totalQuantity,
      submittedAt: shipments.submittedAt,
    })
    .from(shipments)
    .where(isNotNull(shipments.externalCode))
    .orderBy(desc(shipments.submittedAt))
    .limit(pageSize)
    .offset(offset);

  const totalRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(shipments)
    .where(isNotNull(shipments.externalCode));

  return NextResponse.json({
    rows,
    total: totalRow[0].c,
    page,
    pageSize,
    syncedAt: new Date().toISOString(),
  });
}
