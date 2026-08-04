import { NextRequest, NextResponse } from "next/server";
import { searchTraces } from "@/lib/import-service";

/**
 * GET /api/traces/search — Trace 多条件搜索
 *
 * 支持的查询参数（模块九要求）：
 *   trace_id     - 链路追踪 ID
 *   task_id      - 导入任务 ID
 *   file_name    - 文件名（模糊匹配）
 *   batch_index  - 批次号
 *   row_start    - 行号范围起始
 *   row_end      - 行号范围结束
 *   error_code   - 错误码（如 E001）
 *   page         - 页码（默认 1）
 *   page_size    - 每页条数（默认 50）
 *
 * 返回：按时间倒序排列的事件 + 错误明细，支持分页
 * 点击失败节点可看到：批次号、行号、字段名、脱敏原始值、错误码、错误原因、阶段耗时等
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const trace_id = url.searchParams.get("trace_id") || undefined;
  const task_id = url.searchParams.get("task_id") || undefined;
  const file_name = url.searchParams.get("file_name") || undefined;
  const batch_index_str = url.searchParams.get("batch_index");
  const row_start_str = url.searchParams.get("row_start");
  const row_end_str = url.searchParams.get("row_end");
  const error_code = url.searchParams.get("error_code") || undefined;
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const page_size = parseInt(url.searchParams.get("page_size") || "50", 10);

  // 至少要有一个过滤条件，避免全表扫描
  if (!trace_id && !task_id && !file_name && batch_index_str === null && row_start_str === null && row_end_str === null && !error_code) {
    return NextResponse.json(
      { error: "请至少提供一个搜索条件（trace_id / task_id / file_name / batch_index / row_start / row_end / error_code）" },
      { status: 400 }
    );
  }

  const result = await searchTraces({
    trace_id,
    task_id,
    file_name,
    batch_index: batch_index_str ? parseInt(batch_index_str, 10) : undefined,
    row_start: row_start_str ? parseInt(row_start_str, 10) : undefined,
    row_end: row_end_str ? parseInt(row_end_str, 10) : undefined,
    error_code,
    page,
    pageSize: page_size,
  });

  return NextResponse.json(result);
}
