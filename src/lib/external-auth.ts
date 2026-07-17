import { NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.EXTERNAL_API_KEY;

/** 校验 X-API-Key 头（V3 调用 V2 时携带） */
export function checkExternalAuth(req: NextRequest): boolean {
  if (!API_KEY) return false;
  return req.headers.get("x-api-key") === API_KEY;
}

export function unauthorizedResponse() {
  return NextResponse.json(
    { error: "unauthorized", message: "无效或缺失的 API Key" },
    { status: 401 }
  );
}
