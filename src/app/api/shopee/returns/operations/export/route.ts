// SHOPEE-6B §56: XLSX export of the daily return-operation list, same filters
// as /shopee/returns/operations (one row per item; operation columns repeated
// so the sheet filters cleanly). Same auth as the page (channel:view).
// File name: <Carrier>_<HoanTra|HoanHuy|HangHoan>_<date>[_<Ca>].xlsx
import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { authorizeRoute } from "@/lib/auth/session";
import { returnOpStatusInfo } from "@/lib/channels/shopee/return-logistics-status";
import { getTodayDateVN } from "@/lib/notifications/date-vn";
import { isReturnOperationType, RETURN_OPERATION_LABELS } from "@/lib/return-operations/classify";
import { getDailyReturnOperationsList, loadDeliveryWindows, MAX_EXPORT_ROWS } from "@/lib/return-operations/queries";
import { returnOperationReason } from "@/lib/return-operations/reasons";
import { displayDate } from "@/lib/return-operations/time";
import { OUTSIDE_WINDOW_ID } from "@/lib/return-operations/windows";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";

export const dynamic = "force-dynamic";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ASCII-only file name part ("Ca sáng" → "CaSang"). */
function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export async function GET(request: Request) {
  const authz = await authorizeRoute("channel:view");
  if (!authz.ok) return authz.response;
  const p = Object.fromEntries(new URL(request.url).searchParams.entries());
  const date = p.date && DATE.test(p.date) ? p.date : getTodayDateVN();
  const carrier = !p.carrier || p.carrier === "all" ? null : p.carrier === "__none__" ? "" : p.carrier;
  const tab = p.tab === "open" ? "open" : isReturnOperationType(p.tab) ? p.tab : null;
  const type = tab && tab !== "open" ? tab : isReturnOperationType(p.type) ? p.type : null;
  const windowId = p.window && p.window !== "all" && tab !== "open" ? p.window : null;
  const db = createAdminClient();
  const [{ rows, total }, windows] = await Promise.all([
    getDailyReturnOperationsList(db, {
      date,
      shopId: p.shop && p.shop !== "all" ? p.shop : null,
      carrier,
      operationType: type,
      deliveryWindowId: windowId,
      status: p.status && p.status !== "all" ? p.status : null,
      search: p.q,
      view: tab === "open" ? "open" : "delivered",
      page: 1,
      pageSize: MAX_EXPORT_ROWS,
    }),
    loadDeliveryWindows(db),
  ]);
  const windowName = new Map(windows.map((w) => [w.id, w.name]));

  const wb = new ExcelJS.Workbook();
  wb.creator = "theo-doi-hang-ve";
  const ws = wb.addWorksheet("Hang hoan");
  ws.addRow([`Hàng hoàn ${tab === "open" ? "đang hoàn về" : `đã giao về shop ngày ${displayDate(date)}`}${carrier ? ` · ${carrier}` : ""}${type ? ` · ${RETURN_OPERATION_LABELS[type]}` : ""}${total > rows.length ? ` · ${rows.length}/${total} đơn (giới hạn xuất)` : ""}`]);
  ws.addRow(["Chỉ theo dõi vận hành — không phải phiếu nhập kho."]);
  const header = ws.addRow(["Giờ giao thành công", "Ca giao", "Loại", "Lý do hoàn", "Mã đơn", "Mã đơn hoàn", "Mã vận đơn", "Mã vận đơn hoàn (RTS)", "Sản phẩm", "Phân loại", "SKU", "SL", "ĐVVC", "Trạng thái", "Đã nhận lúc", "Shop"]);
  header.font = { bold: true };
  for (const r of rows) {
    const items = r.items.length > 0 ? r.items : [{ name: "", model: null, sku: null, quantity: r.itemQuantity }];
    const reason = returnOperationReason(r);
    for (const it of items) {
      ws.addRow([
        r.deliveredToSellerAt ? formatDateTime(r.deliveredToSellerAt) : "",
        r.deliveredToSellerAt ? (r.windowId ? (windowName.get(r.windowId) ?? "") : "Ngoài ca") : "",
        RETURN_OPERATION_LABELS[r.operationType],
        reason,
        r.externalOrderSn,
        r.returnSn ?? "",
        r.trackingNumber ?? "",
        r.rtsTrackingNumber ?? "",
        it.name,
        it.model ?? "",
        it.sku ?? "",
        Number(it.quantity),
        r.carrier ?? "",
        returnOpStatusInfo(r.canonicalStatus).label,
        r.receivedConfirmedAt ? formatDateTime(r.receivedConfirmedAt) : "",
        r.shopName,
      ]);
    }
  }
  ws.columns.forEach((c, i) => (c.width = [17, 10, 10, 36, 18, 18, 18, 18, 40, 20, 18, 6, 14, 18, 17, 16][i] ?? 14));

  const parts = [carrier ? slug(carrier) : tab === "open" ? "DangHoan" : "TatCa", type === "customer_return" ? "HoanTra" : type === "failed_delivery_return" ? "HoanHuy" : "HangHoan", date];
  if (windowId) parts.push(windowId === OUTSIDE_WINDOW_ID ? "NgoaiCa" : slug(windowName.get(windowId) ?? "Ca"));
  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${parts.join("_")}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}
