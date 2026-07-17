import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { checkExternalAuth, unauthorizedResponse } from "@/lib/external-auth";

/**
 * POST /api/external/waybills/:code/flag
 * V3 回写异常标记（加分项）：V2 侧记录该运单存在未关闭异常，避免 V2 继续按正常运单处理（如重复发货）
 * Body: { ticketId, ticketNo, reason }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  if (!checkExternalAuth(req)) return unauthorizedResponse();
  const { code } = await params;
  const body = await req.json().catch(() => ({}));

  // V2 侧轻量标记表（不改 shipments 主表，避免影响 V2 既有逻辑）
  await sql`CREATE TABLE IF NOT EXISTS v2_waybill_flags (
    waybill_code varchar(255) primary key,
    flagged boolean not null default true,
    ticket_id varchar(64),
    ticket_no varchar(32),
    reason text,
    flagged_at timestamptz default now()
  )`;

  await sql`
    INSERT INTO v2_waybill_flags (waybill_code, flagged, ticket_id, ticket_no, reason, flagged_at)
    VALUES (${code}, true, ${body.ticketId ?? null}, ${body.ticketNo ?? null}, ${body.reason ?? "V3异常处理中"}, now())
    ON CONFLICT (waybill_code) DO UPDATE SET
      flagged = true,
      ticket_id = EXCLUDED.ticket_id,
      ticket_no = EXCLUDED.ticket_no,
      reason = EXCLUDED.reason,
      flagged_at = now()
  `;

  return NextResponse.json({ success: true, code, flaggedAt: new Date().toISOString() });
}

/** 清除异常标记（V3 工单关闭时调用） */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  if (!checkExternalAuth(req)) return unauthorizedResponse();
  const { code } = await params;
  await sql`CREATE TABLE IF NOT EXISTS v2_waybill_flags (
    waybill_code varchar(255) primary key,
    flagged boolean not null default true,
    ticket_id varchar(64),
    ticket_no varchar(32),
    reason text,
    flagged_at timestamptz default now()
  )`;
  await sql`UPDATE v2_waybill_flags SET flagged = false WHERE waybill_code = ${code}`;
  return NextResponse.json({ success: true, code });
}
