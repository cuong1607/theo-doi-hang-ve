// SHOPEE-8 §74: XLSX export of analytics tables, with the page's filters.
//   ?kind=products       SKU performance (all rows, ≤ 5 000)
//   ?kind=profitability  loss-making orders (≤ 5 000)
//   ?kind=payouts        payout reconciliation in the period (≤ 5 000)
// Same auth as the pages (channel:view); the shop set is resolved on the
// server (resolveAnalyticsScope) — a shop id from the URL is only a request.
// Money cells: the exact NUMERIC string converted for Excel (VND amounts
// are far below 2^53 — no precision loss); the totals themselves were
// computed in SQL.
import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { authorizeRoute } from "@/lib/auth/session";
import { getLossOrders, getProductAnalytics, isProductSort } from "@/lib/channels/core/analytics";
import { listPayouts } from "@/lib/channels/core/payouts";
import { getAnalyticsContext } from "@/components/analytics/context";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const MAX_ROWS = 5000;

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function GET(request: Request) {
  const authz = await authorizeRoute("channel:view");
  if (!authz.ok) return authz.response;
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const ctx = await getAnalyticsContext(params, "30d");
  if (!ctx) return NextResponse.json({ success: false, errorMessage: "Chưa có shop." }, { status: 404 });
  const db = createAdminClient();
  const wb = new ExcelJS.Workbook();
  wb.creator = "theo-doi-hang-ve";
  const meta = `Kỳ ${ctx.period.from} → ${ctx.period.to} · ${ctx.scope.selectedShopId ? ctx.scope.shops.find((s) => s.id === ctx.scope.selectedShopId)?.name : "Tất cả shop"} · ${ctx.scope.currency}`;
  let name: string;

  if (params.kind === "products") {
    const type = params.type === "atomic" || params.type === "combo" ? params.type : null;
    const { rows } = await getProductAnalytics(db, ctx.scope, ctx.period, { type, search: params.q, sort: isProductSort(params.sort) ? params.sort : "estimated_profit", desc: params.dir !== "asc", limit: MAX_ROWS });
    const ws = wb.addWorksheet("San pham");
    ws.addRow([meta]);
    ws.addRow(["Doanh thu / lợi nhuận đơn phân bổ cho dòng theo tỷ lệ giá trị dòng. Ô trống = chưa đủ dữ liệu (không phải 0)."]);
    ws.addRow(["SKU", "Tên", "Loại", "SL bán", "Đơn", "Giá trị đơn", "DT ước tính", "Giá vốn", "LN dự kiến", "Margin dự kiến %", "LN thực tế", "Margin thực tế %", "SL trả", "Tỷ lệ trả %", "Cảnh báo giá vốn"]);
    for (const r of rows) {
      ws.addRow([r.sku, r.name, r.product_type === "combo" ? "Combo" : "Sản phẩm", num(r.units), r.orders, num(r.order_value), num(r.estimated_revenue), num(r.cogs), num(r.estimated_profit), num(r.estimated_margin), num(r.actual_profit), num(r.actual_margin), num(r.returned_units), num(r.return_rate), r.cost_flag ?? ""]);
    }
    name = "phan-tich-san-pham";
  } else if (params.kind === "profitability") {
    const { rows } = await getLossOrders(db, ctx.scope, ctx.period, MAX_ROWS, 0);
    const ws = wb.addWorksheet("Don lo");
    ws.addRow([meta]);
    ws.addRow(["Mã đơn", "Ngày tạo", "Trạng thái đơn", "Tình trạng", "Giá trị đơn", "LN dự kiến", "LN thực tế", "Margin %"]);
    for (const o of rows) ws.addRow([o.external_order_sn, o.created_at_channel, o.order_status, o.loss_state === "actual_loss" ? "Lỗ thực tế" : "Dự kiến lỗ", num(o.order_value), num(o.estimated_profit), num(o.actual_profit), num(o.margin)]);
    name = "don-lo";
  } else if (params.kind === "payouts") {
    const shopId = ctx.scope.selectedShopId ?? undefined;
    const { rows } = await listPayouts(db, { shopId, dateFrom: ctx.period.from, dateTo: ctx.period.to }, 1, MAX_ROWS);
    const ws = wb.addWorksheet("Payout");
    ws.addRow([meta]);
    ws.addRow(["Mã payout", "Shop", "Thời gian", "Trạng thái", "Số tiền", "Giải ngân đơn", "Điều chỉnh", "Số dư trước", "Số dư sau", "Kỳ vọng", "Chênh lệch", "Đối soát", "Xử lý", "Lý do"]);
    for (const p of rows.filter((r) => ctx.scope.shopIds.includes(r.shopId))) {
      ws.addRow([p.providerPayoutId, p.shopName, p.payoutTime, p.payoutStatus, num(p.payoutAmount), num(p.ordersReleasedTotal), num(p.adjustmentsTotal), num(p.openingBalance), num(p.closingBalance), num(p.expectedAmount), num(p.differenceAmount), p.reconciliationStatus, p.resolutionStatus, p.resolutionReason ?? ""]);
    }
    name = "doi-soat-payout";
  } else {
    return NextResponse.json({ success: false, errorMessage: "Loại xuất không hợp lệ." }, { status: 400 });
  }

  for (const ws of wb.worksheets) {
    ws.getRow(ws.rowCount > 2 && params.kind === "products" ? 3 : 2).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 16));
  }
  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}-${ctx.period.from}_${ctx.period.to}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
