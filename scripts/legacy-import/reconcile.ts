import type { ParsedImport } from "./types.ts";
import { findThanhTienAnomalies, loadWorkbook, readLichSu, readLichSuSummaryMarkers, type ThanhTienAnomaly } from "./workbook.ts";
import { ROW_DATE_OVERRIDES } from "./normalize.ts";

export type DateSupplierCheck = {
  date: string;
  supplierName: string;
  calculatedTotal: number;
  workbookTotal: number;
  calculatedVat: number;
  workbookVat: number;
  calculatedGrandTotal: number;
  workbookGrandTotal: number;
  matches: boolean;
  explainedByDateOverride: number;
};

export type ReconciliationResult = {
  dateSupplierChecks: DateSupplierCheck[];
  mismatchCount: number;
  matchCount: number;
  receiptTotals: {
    receiptCount: number;
    itemRowCount: number;
    totalDeliveredQty: number;
    totalReceivedQty: number;
    totalDifferenceQty: number;
    totalLineTotal: number;
    morningTotal: number;
    afternoonTotal: number;
  };
  invoiceTotals: {
    invoiceCount: number;
    itemRowCount: number;
    totalAmount: number;
  };
  catalogTotals: {
    supplierCount: number;
    existingProductCount: number;
    newProductCount: number;
  };
  sourceAnomalies: ThanhTienAnomaly[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function reconcile(
  parsed: ParsedImport,
  db: { existingProductSkus: Set<string>; supplierNameToCode: Map<string, string> }
): Promise<ReconciliationResult> {
  const wb = await loadWorkbook();
  const markers = readLichSuSummaryMarkers(wb);
  const sourceAnomalies = findThanhTienAnomalies(wb);

  // dedupe markers by (date, supplier) — all occurrences for the same key
  // carry the same value (verified against the source data).
  const markerByKey = new Map<string, { tong: number; vat: number; tongVat: number }>();
  for (const m of markers) {
    markerByKey.set(`${m.date}|${m.supplierName}`, { tong: m.tong, vat: m.vat, tongVat: m.tongVat });
  }

  // Sum calculated line_total per (date, supplier) from the parsed receipt
  // groups — across BOTH shifts, matching how the workbook computed its
  // Tổng Tiền column.
  const calcByKey = new Map<string, number>();
  // Contribution from rows whose date came from ROW_DATE_OVERRIDES (a source
  // row with no date, fixed to a specific date after user confirmation).
  // The workbook's own "Tổng Tiền" never counted these (blank date never
  // matches a date-based SUMIFS), so a mismatch of exactly this size is
  // expected and not a data problem.
  const overrideAdjustmentByKey = new Map<string, number>();
  const overriddenRowNumbers = new Set(Object.keys(ROW_DATE_OVERRIDES).map(Number));
  if (overriddenRowNumbers.size > 0) {
    const { rows: rawLichSuRows } = readLichSu(wb);
    for (const r of rawLichSuRows) {
      if (!overriddenRowNumbers.has(r.row)) continue;
      const key = `${r.date}|${r.supplierName}`;
      const contribution = round2(r.price * r.receivedQty);
      overrideAdjustmentByKey.set(key, round2((overrideAdjustmentByKey.get(key) ?? 0) + contribution));
    }
  }
  let receiptCount = 0;
  let itemRowCount = 0;
  let totalDeliveredQty = 0;
  let totalReceivedQty = 0;
  let totalLineTotal = 0;
  let morningTotal = 0;
  let afternoonTotal = 0;

  for (const g of parsed.receiptGroups) {
    receiptCount++;
    const key = `${g.receiptDate}|${g.supplierName}`;
    let receiptTotal = 0;
    for (const item of g.items) {
      itemRowCount++;
      const lineTotal = round2(item.unitPrice * item.receivedQty);
      totalDeliveredQty += item.deliveredQty;
      totalReceivedQty += item.receivedQty;
      totalLineTotal += lineTotal;
      receiptTotal += lineTotal;
    }
    if (g.shift === "morning") morningTotal += receiptTotal;
    else afternoonTotal += receiptTotal;
    calcByKey.set(key, round2((calcByKey.get(key) ?? 0) + receiptTotal));
  }

  const allKeys = new Set<string>([...markerByKey.keys(), ...calcByKey.keys()]);
  const dateSupplierChecks: DateSupplierCheck[] = [];
  for (const key of allKeys) {
    const [date, supplierName] = key.split("|");
    const workbook = markerByKey.get(key);
    const calculatedTotal = calcByKey.get(key) ?? 0;
    const calculatedVat = round2(calculatedTotal * 0.08);
    const calculatedGrandTotal = round2(calculatedTotal * 1.08);
    const workbookTotal = workbook?.tong ?? 0;
    const workbookVat = workbook?.vat ?? 0;
    const workbookGrandTotal = workbook?.tongVat ?? 0;
    const matches =
      Math.abs(calculatedTotal - workbookTotal) < 1 &&
      Math.abs(calculatedVat - workbookVat) < 1 &&
      Math.abs(calculatedGrandTotal - workbookGrandTotal) < 1;
    dateSupplierChecks.push({
      date,
      supplierName,
      calculatedTotal,
      workbookTotal,
      calculatedVat,
      workbookVat,
      calculatedGrandTotal,
      workbookGrandTotal,
      matches,
      explainedByDateOverride: overrideAdjustmentByKey.get(key) ?? 0,
    });
  }
  dateSupplierChecks.sort((a, b) => a.date.localeCompare(b.date) || a.supplierName.localeCompare(b.supplierName));

  const mismatchCount = dateSupplierChecks.filter((c) => !c.matches).length;

  let invoiceItemRowCount = 0;
  let invoiceTotalAmount = 0;
  for (const inv of parsed.invoiceGroups) {
    for (const item of inv.items) {
      invoiceItemRowCount++;
      invoiceTotalAmount += round2(item.unitPrice * item.quantity);
    }
  }

  return {
    dateSupplierChecks,
    mismatchCount,
    matchCount: dateSupplierChecks.length - mismatchCount,
    receiptTotals: {
      receiptCount,
      itemRowCount,
      totalDeliveredQty,
      totalReceivedQty,
      totalDifferenceQty: round2(totalReceivedQty - totalDeliveredQty),
      totalLineTotal: round2(totalLineTotal),
      morningTotal: round2(morningTotal),
      afternoonTotal: round2(afternoonTotal),
    },
    invoiceTotals: {
      invoiceCount: parsed.invoiceGroups.length,
      itemRowCount: invoiceItemRowCount,
      totalAmount: round2(invoiceTotalAmount),
    },
    catalogTotals: {
      supplierCount: db.supplierNameToCode.size,
      existingProductCount: db.existingProductSkus.size,
      newProductCount: parsed.newProducts.length,
    },
    sourceAnomalies,
  };
}
