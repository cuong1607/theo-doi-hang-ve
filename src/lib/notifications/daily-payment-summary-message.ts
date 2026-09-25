// Pure calculation-free helpers for the DAILY_PAYMENT_SUMMARY event: the
// summary shape and message formatting. Kept in its own file with zero
// DB/"@/" imports so it can run under plain `node --test` (unlike
// buildDailyPaymentSummary in ./daily-payment-summary.ts, which touches the
// real DB via the "@/lib/supabase/admin" alias).

export { getTodayDateVN } from "./date-vn.ts";

export type DailyPaymentInvoiceLine = {
  invoiceId: string;
  invoiceNo: string;
  amountPaid: number;
};

export type DailyPaymentSupplierBreakdown = {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  invoices: DailyPaymentInvoiceLine[];
  supplierTotal: number;
};

export type DailyPaymentSummary = {
  date: string; // YYYY-MM-DD
  paymentCount: number; // distinct payments rows that day (CALCULATION's "payment_count")
  invoiceCount: number; // distinct invoices touched that day ("invoice_count")
  totalPaid: number;
  suppliers: DailyPaymentSupplierBreakdown[];
};

function formatDateVN(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatMoneyVN(n: number): string {
  return `${n.toLocaleString("vi-VN")} đ`;
}

// Tách calculation (buildDailyPaymentSummary) khỏi message formatting, per
// the phase spec — only ever reads an already-computed DailyPaymentSummary,
// never queries anything itself. paymentCount/invoiceCount are returned by
// buildDailyPaymentSummary (per the spec's CALCULATION section) but aren't
// rendered here — the spec's own example message never shows them, only
// per-invoice lines + supplier/grand totals.
export function formatDailyPaymentSummaryMessage(summary: DailyPaymentSummary): string {
  const lines: string[] = [`THANH TOÁN ${formatDateVN(summary.date)}`, ""];

  for (const s of summary.suppliers) {
    lines.push(s.supplierName);
    for (const inv of s.invoices) {
      lines.push(`- HĐ ${inv.invoiceNo}: ${formatMoneyVN(inv.amountPaid)}`);
    }
    lines.push(`Tổng NCC: ${formatMoneyVN(s.supplierTotal)}`);
    lines.push("");
  }

  lines.push("TỔNG THANH TOÁN:");
  lines.push(formatMoneyVN(summary.totalPaid));

  return lines.join("\n");
}
