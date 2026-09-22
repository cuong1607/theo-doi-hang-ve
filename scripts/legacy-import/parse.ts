import { readDanhMuc, readHoaDon, readLichSu, loadWorkbook } from "./workbook.ts";
import { SKU_TYPO_MAP, legacyInvoiceNo, legacyInvoiceRef, legacyReceiptNo, legacyReceiptRef } from "./normalize.ts";
import type {
  HoaDonRow,
  InvoiceGroup,
  LichSuRow,
  NewProduct,
  ParsedImport,
  ReceiptGroup,
  RowIssue,
} from "./types.ts";

export type SupplierLookup = Map<string, string>; // name.trim() -> code

function resolveSku(sku: string): string {
  return SKU_TYPO_MAP[sku] ?? sku;
}

// Confirmed with the user: Danh Muc rows with no price are discontinued
// products ("hàng cũ không bán nữa") — skip creating them rather than
// defaulting current_price to 0. None of them appear in any Lich Su /
// Lich_Su_Hoa_Don transaction row, so skipping has no downstream effect.
function parseDanhMuc(danhMucRows: ReturnType<typeof readDanhMuc>, existingProductSkus: Set<string>) {
  const newProducts: NewProduct[] = [];
  const skippedProducts: NewProduct[] = [];
  for (const r of danhMucRows) {
    if (existingProductSkus.has(r.sku)) continue;
    const product: NewProduct = {
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      price: r.price ?? 0,
      priceWasMissing: r.price == null,
      supplierName: r.supplierName,
      sourceRow: r.row,
    };
    if (r.price == null) skippedProducts.push(product);
    else newProducts.push(product);
  }
  return { newProducts, skippedProducts };
}

function parseLichSu(
  rows: LichSuRow[],
  validSkus: Set<string>,
  supplierLookup: SupplierLookup
): { groups: ReceiptGroup[]; issues: RowIssue[]; mergedDuplicates: ParsedImport["mergedDuplicates"] } {
  const issues: RowIssue[] = [];
  const mergedDuplicates: ParsedImport["mergedDuplicates"] = [];

  // Pass 1: validate + resolve each row, dropping unusable ones into `issues`.
  type Usable = {
    row: number;
    date: string;
    shift: "morning" | "afternoon";
    sku: string;
    price: number;
    deliveredQty: number;
    receivedQty: number;
    supplierName: string;
  };
  const usable: Usable[] = [];

  for (const r of rows) {
    if (!r.date) {
      issues.push({ sheet: "Lich Su", row: r.row, reason: "missing_date", detail: { sku: r.sku, supplierName: r.supplierName } });
      continue;
    }
    if (!r.sku || !r.supplierName) {
      issues.push({ sheet: "Lich Su", row: r.row, reason: "missing_core_field", detail: r });
      continue;
    }
    if (!supplierLookup.has(r.supplierName)) {
      issues.push({ sheet: "Lich Su", row: r.row, reason: "unknown_supplier", detail: { supplierName: r.supplierName } });
      continue;
    }
    const resolvedSku = resolveSku(r.sku);
    if (!validSkus.has(resolvedSku)) {
      issues.push({ sheet: "Lich Su", row: r.row, reason: "unknown_sku", detail: { sku: r.sku, productName: r.productName, price: r.price, supplierName: r.supplierName } });
      continue;
    }
    usable.push({
      row: r.row,
      date: r.date,
      shift: r.shift,
      sku: resolvedSku,
      price: r.price,
      deliveredQty: r.deliveredQty,
      receivedQty: r.receivedQty,
      supplierName: r.supplierName,
    });
  }

  // Pass 2: group by (date, shift, supplier) — user-confirmed strategy.
  // Every row for a given combo becomes one receipt, regardless of where it
  // sits in the sheet. Duplicate SKUs within one group are merged (summed
  // qty) rather than rejected — verified against the real data that every
  // such duplicate carries the same unit_price.
  const groupMap = new Map<string, Usable[]>();
  for (const u of usable) {
    const key = `${u.date}|${u.shift}|${u.supplierName}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(u);
  }

  const groups: ReceiptGroup[] = [];
  for (const [key, groupRows] of groupMap) {
    const [date, shift] = key.split("|") as [string, "morning" | "afternoon"];
    const supplierName = groupRows[0].supplierName;
    const supplierCode = supplierLookup.get(supplierName)!;

    const itemsBySku = new Map<string, { unitPrice: number; deliveredQty: number; receivedQty: number; sourceRows: number[] }>();
    for (const u of groupRows) {
      const existing = itemsBySku.get(u.sku);
      if (existing) {
        if (existing.unitPrice !== u.price) {
          issues.push({
            sheet: "Lich Su",
            row: u.row,
            reason: "duplicate_price_conflict",
            detail: {
              note: "Trùng SKU trong cùng (ngày, ca, NCC) nhưng đơn giá khác nhau — không tự gộp.",
              sku: u.sku,
              groupKey: key,
              existingPrice: existing.unitPrice,
              thisPrice: u.price,
            },
          });
          continue;
        }
        existing.deliveredQty += u.deliveredQty;
        existing.receivedQty += u.receivedQty;
        existing.sourceRows.push(u.row);
        mergedDuplicates.push({ sheet: "Lich Su", sku: u.sku, rows: existing.sourceRows.slice(), groupKey: key });
      } else {
        itemsBySku.set(u.sku, {
          unitPrice: u.price,
          deliveredQty: u.deliveredQty,
          receivedQty: u.receivedQty,
          sourceRows: [u.row],
        });
      }
    }

    if (itemsBySku.size === 0) continue;

    groups.push({
      legacyRef: legacyReceiptRef(date, shift, supplierCode),
      receiptNo: legacyReceiptNo(date, shift, supplierCode),
      receiptDate: date,
      shift,
      supplierName,
      items: [...itemsBySku.entries()].map(([sku, v]) => ({ sku, ...v })),
      sourceRows: groupRows.map((r) => r.row),
    });
  }

  groups.sort((a, b) => a.receiptDate.localeCompare(b.receiptDate) || a.receiptNo.localeCompare(b.receiptNo));

  return { groups, issues, mergedDuplicates };
}

function parseHoaDon(
  rows: HoaDonRow[],
  validSkus: Set<string>,
  supplierLookup: SupplierLookup
): { groups: InvoiceGroup[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const groupMap = new Map<string, HoaDonRow[]>();

  for (const r of rows) {
    if (!r.invoiceDate) {
      issues.push({ sheet: "Lich_Su_Hoa_Don", row: r.row, reason: "missing_date", detail: { sku: r.sku, supplierName: r.supplierName } });
      continue;
    }
    if (!supplierLookup.has(r.supplierName)) {
      issues.push({ sheet: "Lich_Su_Hoa_Don", row: r.row, reason: "unknown_supplier", detail: { supplierName: r.supplierName } });
      continue;
    }
    const resolvedSku = resolveSku(r.sku);
    if (!validSkus.has(resolvedSku)) {
      issues.push({ sheet: "Lich_Su_Hoa_Don", row: r.row, reason: "unknown_sku", detail: { sku: r.sku, productName: r.productName } });
      continue;
    }
    if (!groupMap.has(r.savedAt)) groupMap.set(r.savedAt, []);
    groupMap.get(r.savedAt)!.push({ ...r, sku: resolvedSku });
  }

  const groups: InvoiceGroup[] = [];
  for (const [savedAt, groupRows] of groupMap) {
    const supplierName = groupRows[0].supplierName;
    const supplierCode = supplierLookup.get(supplierName)!;
    const invoiceDate = groupRows[0].invoiceDate;

    const itemsBySku = new Map<string, { unitPrice: number; quantity: number; sourceRow: number }>();
    for (const r of groupRows) {
      if (itemsBySku.has(r.sku)) {
        issues.push({
          sheet: "Lich_Su_Hoa_Don",
          row: r.row,
          reason: "duplicate_price_conflict",
          detail: { note: "Trùng SKU trong cùng hóa đơn (Ngày Lưu) — cần xem thủ công.", sku: r.sku, savedAt },
        });
        continue;
      }
      itemsBySku.set(r.sku, { unitPrice: r.price, quantity: r.quantity, sourceRow: r.row });
    }

    if (itemsBySku.size === 0) continue;

    groups.push({
      legacyRef: legacyInvoiceRef(savedAt),
      invoiceNo: legacyInvoiceNo(invoiceDate, savedAt, supplierCode),
      invoiceDate,
      supplierName,
      items: [...itemsBySku.entries()].map(([sku, v]) => ({ sku, ...v })),
      sourceRows: groupRows.map((r) => r.row),
      savedAt,
    });
  }

  groups.sort((a, b) => a.savedAt.localeCompare(b.savedAt));

  return { groups, issues };
}

export async function parseWorkbook(opts: {
  existingProductSkus: Set<string>;
  supplierLookup: SupplierLookup;
}): Promise<ParsedImport> {
  const wb = await loadWorkbook();
  const danhMucRows = readDanhMuc(wb);
  const { rows: lichSuRows, totalNonEmptyRows: lichSuTotalRows } = readLichSu(wb);
  const { rows: hoaDonRows, totalNonEmptyRows: hoaDonTotalRows } = readHoaDon(wb);

  const { newProducts, skippedProducts } = parseDanhMuc(danhMucRows, opts.existingProductSkus);

  // A SKU is "valid" for transaction rows if it's already a DB product OR
  // it's one of the new products about to be created. Discontinued products
  // (skipped, no price) are deliberately NOT valid — if a transaction row
  // ever referenced one it should surface as "unknown SKU", not import
  // against a product that was never created.
  const validSkus = new Set<string>([...opts.existingProductSkus, ...newProducts.map((p) => p.sku)]);

  const lichSu = parseLichSu(lichSuRows, validSkus, opts.supplierLookup);
  const hoaDon = parseHoaDon(hoaDonRows, validSkus, opts.supplierLookup);

  return {
    danhMucRows,
    newProducts,
    skippedProducts,
    receiptGroups: lichSu.groups,
    invoiceGroups: hoaDon.groups,
    issues: [...lichSu.issues, ...hoaDon.issues],
    mergedDuplicates: lichSu.mergedDuplicates,
    stats: {
      lichSuTotalRows,
      lichSuDetailRows: lichSuRows.length,
      hoaDonTotalRows,
    },
  };
}
