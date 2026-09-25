// Pure calculation-free helpers for the DAILY_RECEIPT_SUMMARY event: the
// summary shape, "today in Asia/Ho_Chi_Minh", and message formatting. Kept
// in its own file with zero DB/"@/" imports so it can run under plain
// `node --test` (unlike buildDailyReceiptSummary in ./daily-receipt-summary.ts,
// which touches the real DB via the "@/lib/supabase/admin" alias that only
// Next's bundler — not plain Node — knows how to resolve).

export type DailyReceiptSupplierBreakdown = {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  receiptCount: number;
  totalDelivered: number;
  totalReceived: number;
  totalDifference: number;
  totalAmount: number;
};

export type DailyReceiptSummary = {
  date: string; // YYYY-MM-DD
  receiptCount: number;
  totalDelivered: number;
  totalReceived: number;
  totalDifference: number;
  totalAmount: number;
  suppliers: DailyReceiptSupplierBreakdown[];
};

// "Ngày tính theo Asia/Ho_Chi_Minh" — computed via Intl so it's correct
// regardless of the server process's own TZ (e.g. Vercel runs UTC, which is
// 7h behind and would otherwise roll over to the wrong calendar day for part
// of the evening).
export function getTodayDateVN(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatDateVN(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatQty(n: number): string {
  return n.toLocaleString("vi-VN");
}

function formatMoneyVN(n: number): string {
  return `${n.toLocaleString("vi-VN")} đ`;
}

// Same flat rate as the /receipts/daily/[date]/[supplierId] detail page's
// "VAT 8%" card — receipts have no per-supplier VAT snapshot the way
// invoices do (that's a UP1-era invoice-only concept), so this is a display
// convention, not a stored/policy value.
const RECEIPT_VAT_RATE = 0.08;

function calcAmountAfterVat(amount: number): number {
  return Math.round(amount * (1 + RECEIPT_VAT_RATE) * 100) / 100;
}

// Tách calculation (buildDailyReceiptSummary) khỏi message formatting, per
// the phase spec — this function only ever reads an already-computed
// DailyReceiptSummary, never queries anything itself.
export function formatDailyReceiptSummaryMessage(summary: DailyReceiptSummary): string {
  const lines: string[] = [`HÀNG VỀ ${formatDateVN(summary.date)}`, ""];

  for (const s of summary.suppliers) {
    lines.push(s.supplierName);
    lines.push(`- SL giao: ${formatQty(s.totalDelivered)}`);
    lines.push(`- SL nhận: ${formatQty(s.totalReceived)}`);
    lines.push(`- Chênh lệch: ${formatQty(s.totalDifference)}`);
    lines.push(`- Tổng tiền: ${formatMoneyVN(s.totalAmount)}`);
    lines.push(`- Tổng tiền sau VAT: ${formatMoneyVN(calcAmountAfterVat(s.totalAmount))}`);
    lines.push("");
  }

  lines.push("TỔNG");
  lines.push(`- Số phiếu: ${summary.receiptCount}`);
  lines.push(`- SL giao: ${formatQty(summary.totalDelivered)}`);
  lines.push(`- SL nhận: ${formatQty(summary.totalReceived)}`);
  lines.push(`- Chênh lệch: ${formatQty(summary.totalDifference)}`);
  lines.push(`- Tổng tiền: ${formatMoneyVN(summary.totalAmount)}`);
  lines.push(`- Tổng tiền sau VAT: ${formatMoneyVN(calcAmountAfterVat(summary.totalAmount))}`);

  return lines.join("\n");
}
