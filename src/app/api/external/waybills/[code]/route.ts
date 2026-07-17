import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shipments, orders } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { checkExternalAuth, unauthorizedResponse } from "@/lib/external-auth";

/**
 * GET /api/external/waybills/:code
 * 校验运单存在 + 返回详情（含 SKU 明细）
 * V3 发起异常上报时的实时真实性校验走此接口
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  if (!checkExternalAuth(req)) return unauthorizedResponse();
  const { code } = await params;

  const [row] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.externalCode, code))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { exists: false, waybill: null, skus: [] },
      { status: 404 }
    );
  }

  const skus = await db.select().from(orders).where(eq(orders.shipmentId, row.id));
  return NextResponse.json({
    exists: true,
    waybill: row,
    skus,
    fetchedAt: new Date().toISOString(),
  });
}
