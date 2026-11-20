// Pure, DB-free types + message formatting for the SUPPLIER_DEBT_REPORT
// event (Zalo "công nợ NCC" report). Zero "@/" imports so it runs under plain
// `node --test`, same convention as daily-payment-summary-message.ts.
//
// Content per the request: supplier name, invoice date, remaining amount.

export type SupplierDebtInvoiceLine = {
  invoiceDate: string; // YYYY-MM-DD
  remaining: number;
};

export type SupplierDebtBucket = {
  supplierId: string;
  supplierName: string;
  invoices: SupplierDebtInvoiceLine[];
  supplierTotal: number;
};

export type SupplierDebtReport = {
  date: string; // YYYY-MM-DD, the day the report was built (VN)
  suppliers: SupplierDebtBucket[];
  invoiceCount: number;
  totalRemaining: number;
};

/** Zalo text messages are capped (sender slices at 2000); stay well under it. */
export const SUPPLIER_DEBT_MESSAGE_MAX_CHARS = 1700;

export const SUPPLIER_DEBT_EMPTY_MESSAGE = "Hiện không có công nợ NCC nào còn nợ.";

function formatDateVN(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatMoneyVN(n: number): string {
  return `${n.toLocaleString("vi-VN")} đ`;
}

type Line = { text: string; supplier: string; continuable: boolean };

// Groups rows (already ordered by supplier name, invoice date) into buckets.
export function groupSupplierDebt(
  date: string,
  rows: Array<{ supplier_id: string; supplier_name: string; invoice_date: string; remaining_amount: number }>
): SupplierDebtReport {
  const map = new Map<string, SupplierDebtBucket>();
  for (const r of rows) {
    const remaining = Number(r.remaining_amount);
    let bucket = map.get(r.supplier_id);
    if (!bucket) {
      bucket = { supplierId: r.supplier_id, supplierName: r.supplier_name, invoices: [], supplierTotal: 0 };
      map.set(r.supplier_id, bucket);
    }
    bucket.invoices.push({ invoiceDate: r.invoice_date, remaining });
    bucket.supplierTotal += remaining;
  }
  const suppliers = [...map.values()];
  return {
    date,
    suppliers,
    invoiceCount: rows.length,
    totalRemaining: suppliers.reduce((sum, s) => sum + s.supplierTotal, 0),
  };
}

// Returns one or more messages, each <= maxChars. Splits on supplier
// boundaries first; a single supplier with very many invoices is split across
// messages with "(tiếp)" so no line is cut in half. Multi-part messages are
// prefixed "(i/n)". Empty report -> a single "no debt" message.
export function formatSupplierDebtReportMessages(
  report: SupplierDebtReport,
  maxChars: number = SUPPLIER_DEBT_MESSAGE_MAX_CHARS
): string[] {
  if (report.suppliers.length === 0) return [SUPPLIER_DEBT_EMPTY_MESSAGE];

  const title = `CÔNG NỢ NCC ${formatDateVN(report.date)}`;
  const footer = ["", "TỔNG CÒN NỢ:", formatMoneyVN(report.totalRemaining)];

  const lines: Line[] = [];
  for (const s of report.suppliers) {
    lines.push({ text: s.supplierName, supplier: s.supplierName, continuable: false });
    for (const inv of s.invoices) {
      lines.push({ text: `- ${formatDateVN(inv.invoiceDate)}: ${formatMoneyVN(inv.remaining)}`, supplier: s.supplierName, continuable: true });
    }
    lines.push({ text: `Còn nợ NCC: ${formatMoneyVN(s.supplierTotal)}`, supplier: s.supplierName, continuable: true });
    lines.push({ text: "", supplier: s.supplierName, continuable: false });
  }

  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;
  const reserve = 20 + footer.join("\n").length + title.length; // "(i/n)" prefix + title + footer headroom
  for (const l of lines) {
    const add = l.text.length + 1;
    if (current.length > 0 && size + add + reserve > maxChars) {
      pages.push(current);
      current = [];
      size = 0;
      // a supplier cut mid-way restarts on the next page under "<name> (tiếp)"
      if (l.continuable) {
        const cont = `${l.supplier} (tiếp)`;
        current.push(cont);
        size += cont.length + 1;
      }
    }
    current.push(l.text);
    size += add;
  }
  if (current.length > 0) pages.push(current);

  const total = pages.length;
  return pages.map((page, i) => {
    const head = total > 1 ? `${title} (${i + 1}/${total})` : title;
    const content = [...page];
    while (content[0] === "") content.shift();
    const body = [head, "", ...content];
    // drop the blank separator that trails a page, then add the footer on the last page
    while (body[body.length - 1] === "") body.pop();
    if (i === total - 1) body.push(...footer);
    return body.join("\n");
  });
}
