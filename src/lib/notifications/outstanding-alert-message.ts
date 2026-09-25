// Pure, DB-free message formatting for the LOW_STOCK_ALERT event (Phase
// ZL4). Kept separate from evaluateOutstandingNotifications() (which touches
// the DB) for the same reason as daily-receipt-summary-message.ts: this file
// has zero "@/" imports so it runs under plain `node --test`.

export type OutstandingAlertState = "near_empty" | "over_received";

export type OutstandingAlertItem = {
  invoiceItemId: string;
  supplierId: string;
  supplierName: string;
  sku: string;
  productName: string;
  invoiceNo: string;
  invoiceQty: number;
  receivedQty: number;
  remainingQty: number;
  alertState: OutstandingAlertState;
};

function formatQty(n: number): string {
  return n.toLocaleString("vi-VN");
}

// Single-SKU alert — full detail (NCC/SKU/Sản phẩm/SL hóa đơn/Đã nhận/Còn
// lại/HĐ), per the phase spec's two "Ví dụ" blocks. Used whenever a
// supplier's batch has exactly 1 alert-worthy SKU.
function formatSingleOutstandingAlertMessage(item: OutstandingAlertItem): string {
  const header = item.alertState === "over_received" ? "CẢNH BÁO CẦN XUẤT BÙ" : "CẢNH BÁO HÀNG SẮP HẾT";
  return [
    header,
    "",
    `NCC: ${item.supplierName}`,
    `SKU: ${item.sku}`,
    `Sản phẩm: ${item.productName}`,
    `SL hóa đơn: ${formatQty(item.invoiceQty)}`,
    `Đã nhận: ${formatQty(item.receivedQty)}`,
    `Còn lại: ${formatQty(item.remainingQty)}`,
    `HĐ: ${item.invoiceNo}`,
  ].join("\n");
}

// Multi-SKU alert for the same supplier — compact, one line per SKU, per
// the spec's "gom theo supplier/operation" batching preference. Used
// whenever a supplier's batch has 2+ alert-worthy SKUs (avoids sending N
// separate full-detail messages for one receipt/invoice operation that
// moved N SKUs at once).
function formatBatchOutstandingAlertMessage(supplierName: string, items: OutstandingAlertItem[]): string {
  const lines = ["CẢNH BÁO HÀNG", "", supplierName, ""];
  for (const item of items) {
    const suffix =
      item.alertState === "over_received"
        ? `cần xuất bù ${formatQty(item.remainingQty)}`
        : `còn ${formatQty(item.remainingQty)}`;
    lines.push(`- ${item.sku}: ${suffix}`);
  }
  return lines.join("\n");
}

// items must all share the same supplierId/supplierName — the caller
// (evaluateOutstandingNotifications) already groups alert candidates by
// supplier before calling this.
export function formatOutstandingAlertMessage(supplierName: string, items: OutstandingAlertItem[]): string {
  if (items.length === 0) {
    throw new Error("formatOutstandingAlertMessage: items must not be empty.");
  }
  return items.length === 1
    ? formatSingleOutstandingAlertMessage(items[0])
    : formatBatchOutstandingAlertMessage(supplierName, items);
}
