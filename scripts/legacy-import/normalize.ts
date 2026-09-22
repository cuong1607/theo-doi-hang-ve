// Confirmed with the user (Phase 15 kickoff, 2026-09-22): these 3 SKUs that
// appear in "Lich Su" but not in "Danh Muc" are data-entry typos (transposed
// digits / truncated suffix), not genuinely new products. Same price as the
// real product in every occurrence in the sheet. Mapped to the real SKU
// instead of being left as "unknown SKU".
export const SKU_TYPO_MAP: Record<string, string> = {
  ga_chong_tham_2mx2m2x10cm: "ga_chong_tham_2m2x2mx10cm",
  ga_chong_tham_2mx2m2x20cm: "ga_chong_tham_2mx2mx20cm",
  ruot_goi_tua_1_chiec: "ruot_goi_tua_1_chiec_45cmx45cm",
};

// Confirmed with the user (Phase 15 kickoff, 2026-09-22): Lich Su row 3476
// ("goi_tua_lung_tatami", Giang Nhàn, afternoon) is missing its date in the
// source sheet — the real date is 2026-09-14. Keyed by row number since this
// is a one-off fix to a specific cell, not a general pattern.
export const ROW_DATE_OVERRIDES: Record<number, string> = {
  3476: "2026-09-14",
};

// receiver_name is NOT NULL on receipts but the legacy sheet never recorded
// who received the goods. Confirmed with the user: use "Thủy" for every
// legacy-imported receipt (the real name of the person who has always
// received deliveries).
export const LEGACY_RECEIVER_NAME = "Thủy";

const pad = (n: number, width: number) => String(n).padStart(width, "0");

export function compactDate(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

export function shiftCode(shift: "morning" | "afternoon"): "S" | "C" {
  return shift === "morning" ? "S" : "C";
}

export function legacyReceiptRef(date: string, shift: "morning" | "afternoon", supplierCode: string): string {
  return `LEGACY:RECEIPT:${date}:${shift}:${supplierCode}`;
}

export function legacyReceiptNo(date: string, shift: "morning" | "afternoon", supplierCode: string): string {
  return `LEGACY-PN-${compactDate(date)}-${shiftCode(shift)}-${supplierCode}`;
}

export function legacyInvoiceRef(savedAt: string): string {
  return `LEGACY:INVOICE:${savedAt}`;
}

export function legacyInvoiceNo(invoiceDate: string, savedAt: string, supplierCode: string): string {
  const d = new Date(savedAt);
  const hh = pad(d.getUTCHours(), 2);
  const mm = pad(d.getUTCMinutes(), 2);
  return `LEGACY-HD-${compactDate(invoiceDate)}-${supplierCode}-${hh}${mm}`;
}
