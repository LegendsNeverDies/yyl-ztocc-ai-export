"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Calendar, ChevronLeft, ChevronRight, X, Loader2, Package, FileText } from "lucide-react";
import { getShipmentsPage, getShipmentDetail } from "@/lib/server-actions";
import { EmptyState } from "@/components/shared/empty-state";
import { cn } from "@/lib/utils";
import type { DbShipment, DbOrderItem } from "@/types";

export default function OrdersPage() {
  const [shipments, setShipments] = useState<DbShipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [receiverName, setReceiverName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // 详情弹窗
  const [detailShipment, setDetailShipment] = useState<DbShipment | null>(null);
  const [detailRows, setDetailRows] = useState<DbOrderItem[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const pageSize = 20;
  const totalPages = Math.ceil(total / pageSize);

  const loadShipments = useCallback(async () => {
    setLoading(true);
    const { rows, total: t } = await getShipmentsPage(
      page, pageSize,
      search || undefined,
      receiverName || undefined,
      startDate || undefined,
      endDate || undefined
    );
    setShipments(rows as unknown as DbShipment[]);
    setTotal(t);
    setLoading(false);
  }, [page, search, receiverName, startDate, endDate]);

  useEffect(() => {
    loadShipments();
  }, [loadShipments]);

  const handleSearch = useCallback(() => {
    setPage(1);
    loadShipments();
  }, [loadShipments]);

  const handleViewDetail = useCallback(async (s: DbShipment) => {
    setDetailShipment(s);
    setDetailRows(null);
    setDetailLoading(true);
    try {
      const rows = await getShipmentDetail(s.id);
      setDetailRows(rows as unknown as DbOrderItem[]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setDetailShipment(null);
    setDetailRows(null);
  }, []);

  // 详情弹窗：ESC 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!detailShipment) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDetail(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [detailShipment, closeDetail]);

  const formatDate = (d?: string | Date | null) => {
    if (!d) return "-";
    return new Date(d).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1d2129]">已导入运单列表</h1>
        <p className="mt-1 text-sm text-[#86909c]">按外部编码聚合的出库单，点击“详情”查看 SKU 明细</p>
      </div>

      {/* 筛选栏 */}
      <div className="card mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <label className="mb-1 block text-xs font-medium text-[#86909c]">外部编码</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#86909c]" />
              <input className="input-field pl-8 text-sm" placeholder="搜索外部编码..." value={search}
                onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} />
            </div>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="mb-1 block text-xs font-medium text-[#86909c]">收件人姓名</label>
            <input className="input-field text-sm" placeholder="搜索收件人..." value={receiverName}
              onChange={(e) => setReceiverName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} />
          </div>
          <div className="w-[160px]">
            <label className="mb-1 block text-xs font-medium text-[#86909c]">提交开始</label>
            <input type="date" className="input-field text-sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="w-[160px]">
            <label className="mb-1 block text-xs font-medium text-[#86909c]">提交结束</label>
            <input type="date" className="input-field text-sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <button onClick={handleSearch} className="btn-primary h-[38px] text-sm">搜索</button>
        </div>
      </div>

      {/* 数据表格 */}
      {loading ? (
        <div className="card py-12 text-center text-sm text-[#86909c]">加载中...</div>
      ) : shipments.length === 0 ? (
        <EmptyState icon={<Calendar className="h-16 w-16 opacity-30" />} title="暂无运单数据"
          description="上传文件解析并提交下单后，数据将显示在此处" />
      ) : (
        <>
          <div className="card overflow-hidden !p-0">
            <div className="table-wrapper max-h-[60vh]">
              <table className="table-styled">
                <thead>
                  <tr>
                    <th>外部编码</th>
                    <th>收货门店</th>
                    <th>收件人</th>
                    <th>电话</th>
                    <th>地址</th>
                    <th className="text-center">SKU种类</th>
                    <th className="text-center">总数量</th>
                    <th>提交时间</th>
                    <th className="text-center">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shipments.map((s) => (
                    <tr key={s.id}>
                      <td className="text-xs whitespace-nowrap font-mono">{s.externalCode || <span className="text-[#86909c]">(无编码)</span>}</td>
                      <td className="text-xs whitespace-nowrap">{s.storeName || "-"}</td>
                      <td className="text-xs">{s.receiverName || "-"}</td>
                      <td className="text-xs whitespace-nowrap">{s.receiverPhone || "-"}</td>
                      <td className="text-xs max-w-[200px] truncate" title={s.receiverAddress || ""}>{s.receiverAddress || "-"}</td>
                      <td className="text-xs text-center">{s.skuCount}</td>
                      <td className="text-xs text-center font-medium text-[#0b6e6e]">{s.totalQuantity}</td>
                      <td className="text-xs whitespace-nowrap">{formatDate(s.submittedAt)}</td>
                      <td className="text-center">
                        <button onClick={() => handleViewDetail(s)} className="btn-ghost gap-1 text-xs text-[#0fc6c2]">
                          <FileText className="h-3.5 w-3.5" />详情
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 分页 */}
          <div className="mt-4 flex items-center justify-between text-sm text-[#86909c]">
            <span>共 {total} 个出库单，第 {page}/{totalPages} 页</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-ghost p-1.5"><ChevronLeft className="h-4 w-4" /></button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                const p = i + Math.max(1, page - 2);
                if (p > totalPages) return null;
                return (
                  <button key={p} onClick={() => setPage(p)}
                    className={cn("flex h-8 w-8 items-center justify-center rounded text-xs font-medium",
                      p === page ? "bg-[#0fc6c2] text-white" : "hover:bg-[#f0f0f0] text-[#4e5969]")}>
                    {p}
                  </button>
                );
              })}
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="btn-ghost p-1.5"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        </>
      )}

      {/* 详情弹窗 */}
      {detailShipment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeDetail}>
          <div className="card max-h-[82vh] w-full max-w-3xl overflow-auto !p-0" onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="sticky top-0 flex items-center justify-between border-b border-[#e5e6eb] bg-white px-5 py-3">
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5 text-[#0fc6c2]" />
                <h3 className="text-base font-semibold text-[#1d2129]">
                  出库单详情 {detailShipment.externalCode ? `· ${detailShipment.externalCode}` : "· (无编码)"}
                </h3>
              </div>
              <button onClick={closeDetail} className="btn-ghost p-1.5"><X className="h-4 w-4" /></button>
            </div>

            {/* 收货信息摘要 */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-5 py-4 text-sm md:grid-cols-3">
              <div><span className="text-[#86909c]">收货门店：</span>{detailShipment.storeName || "-"}</div>
              <div><span className="text-[#86909c]">收件人：</span>{detailShipment.receiverName || "-"}</div>
              <div><span className="text-[#86909c]">电话：</span>{detailShipment.receiverPhone || "-"}</div>
              <div className="md:col-span-3"><span className="text-[#86909c]">地址：</span>{detailShipment.receiverAddress || "-"}</div>
              <div><span className="text-[#86909c]">SKU种类：</span>{detailShipment.skuCount}</div>
              <div><span className="text-[#86909c]">总数量：</span>{detailShipment.totalQuantity}</div>
              <div><span className="text-[#86909c]">提交时间：</span>{formatDate(detailShipment.submittedAt)}</div>
            </div>

            {/* SKU 明细表 */}
            <div className="px-5 pb-5">
              <h4 className="mb-2 text-sm font-medium text-[#4e5969]">SKU 明细</h4>
              {detailLoading ? (
                <div className="flex items-center justify-center py-8 text-sm text-[#86909c]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#0fc6c2]" />加载明细...
                </div>
              ) : (
                <div className="table-wrapper">
                  <table className="table-styled text-xs">
                    <thead>
                      <tr>
                        <th className="text-center" style={{ width: 50 }}>#</th>
                        <th>SKU编码</th>
                        <th>SKU名称</th>
                        <th>规格</th>
                        <th className="text-center">数量</th>
                        <th>备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detailRows ?? []).map((r, i) => (
                        <tr key={r.id}>
                          <td className="text-center text-[#86909c]">{i + 1}</td>
                          <td className="whitespace-nowrap font-mono">{r.skuCode}</td>
                          <td>{r.skuName}</td>
                          <td>{r.skuSpec || "-"}</td>
                          <td className="text-center">{r.skuQuantity}</td>
                          <td>{r.remark || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
