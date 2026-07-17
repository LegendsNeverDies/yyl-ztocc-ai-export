import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shipments, orders } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { checkExternalAuth, unauthorizedResponse } from "@/lib/external-auth";

/**
 * GET /api/external/waybills/:code/skus?skuCode=XXX
 * 校验 SKU 是否归属于指定运单（扫描录入时验证扫描到的 SKU 确实在该运单明细中）
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  if (!checkExternalAuth(req)) return unauthorizedResponse();
  const { code } = await params;
  const { searchParams } = new URL(req.url);
  const skuCode = searchParams.get("skuCode");

  const [row] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.externalCode, code))
    .limit(1);

  if (!row) {
    return NextResponse.json({ exists: false, belongs: false }, { status: 404 });
  }

  const skus = await db.select().from(orders).where(eq(orders.shipmentId, row.id));

  if (skuCode) {
    const found = skus.find((s) => s.skuCode === skuCode);
    return NextResponse.json({
      exists: true,
      belongs: !!found,
      sku: found || null,
    });
  }

  return NextResponse.json({ exists: true, skus });
}
