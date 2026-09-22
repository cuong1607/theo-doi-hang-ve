import ExcelJS from "exceljs";
import path from "node:path";
import type { Cell, Worksheet } from "exceljs";
import type { DanhMucRow, HoaDonRow, LichSuRow } from "./types.ts";
import { ROW_DATE_OVERRIDES } from "./normalize.ts";

const WORKBOOK_PATH = path.join(process.cwd(), "src", "THEO DOI HANG VE.xlsx");

export function cellVal(cell: Cell): unknown {
  let v: unknown = cell.value;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (obj.result !== undefined) v = obj.result;
    else if (obj.richText) v = (obj.richText as { text: string }[]).map((t) => t.text).join("");
  }
  return v;
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateStr(v: unknown): string | null {
  if (!(v instanceof Date)) return null;
  return v.toISOString().slice(0, 10);
}

function requiredSheet(wb: ExcelJS.Workbook, name: string): Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`Không tìm thấy sheet "${name}" trong workbook.`);
  return ws;
}

export async function loadWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK_PATH);
  return wb;
}

export function readDanhMuc(wb: ExcelJS.Workbook): DanhMucRow[] {
  const ws = requiredSheet(wb, "Danh Muc");
  const rows: DanhMucRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sku = str(cellVal(row.getCell(1)));
    if (!sku) continue;
    rows.push({
      row: r,
      sku,
      name: str(cellVal(row.getCell(2))),
      unit: str(cellVal(row.getCell(3))),
      price: num(cellVal(row.getCell(4))),
      supplierName: str(cellVal(row.getCell(5))),
    });
  }
  return rows;
}

// Shift text seen in the sheet, normalized to morning/afternoon by stripping
// diacritics + case and matching the "sang"/"chieu" substring. Variants
// observed in the real data: "Ca Sang", "Ca Chieu", "Ca chieu", "ca chiều".
export function normalizeShift(raw: string): "morning" | "afternoon" | null {
  const s = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (s.includes("sang")) return "morning";
  if (s.includes("chieu")) return "afternoon";
  return null;
}

export function readLichSu(wb: ExcelJS.Workbook): { rows: LichSuRow[]; totalNonEmptyRows: number } {
  const ws = requiredSheet(wb, "Lich Su");
  const rows: LichSuRow[] = [];
  let totalNonEmptyRows = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const ngay = cellVal(row.getCell(1));
    const ca = cellVal(row.getCell(2));
    const sku = cellVal(row.getCell(3));
    if (ngay == null && ca == null && sku == null) continue;
    totalNonEmptyRows++;

    const d = dateStr(ngay) ?? ROW_DATE_OVERRIDES[r] ?? null;
    const shiftRaw = str(ca);
    const shift = normalizeShift(shiftRaw);
    const skuStr = str(sku);
    const price = num(cellVal(row.getCell(5)));
    const deliveredQty = num(cellVal(row.getCell(6)));
    const receivedQty = num(cellVal(row.getCell(7)));
    const supplierName = str(cellVal(row.getCell(10)));

    if (!d || !shift || !skuStr || price == null || deliveredQty == null || receivedQty == null || !supplierName) {
      // Recorded as an issue by the caller (parse.ts), which re-derives the
      // same missing-field checks with full context. We still skip adding
      // an unusable row here.
      rows.push({
        row: r,
        date: d ?? "",
        shift: shift ?? "morning",
        shiftRaw,
        sku: skuStr,
        productName: str(cellVal(row.getCell(4))),
        price: price ?? 0,
        deliveredQty: deliveredQty ?? 0,
        receivedQty: receivedQty ?? 0,
        supplierName,
      });
      continue;
    }

    rows.push({
      row: r,
      date: d,
      shift,
      shiftRaw,
      sku: skuStr,
      productName: str(cellVal(row.getCell(4))),
      price,
      deliveredQty,
      receivedQty,
      supplierName,
    });
  }
  return { rows, totalNonEmptyRows };
}

// The "Tổng Tiền / VAT(8%) / Tổng Tiền VAT" columns in Lich Su are not
// receipt boundaries — verified against the real data that they're a
// per (date, supplier) aggregate across BOTH shifts, stamped once on the
// first row the sheet happens to list for that combo. Used only for
// reconciliation, never imported into receipt_items.
export type LichSuSummaryMarker = { date: string; supplierName: string; tong: number; vat: number; tongVat: number; row: number };

export function readLichSuSummaryMarkers(wb: ExcelJS.Workbook): LichSuSummaryMarker[] {
  const ws = requiredSheet(wb, "Lich Su");
  const markers: LichSuSummaryMarker[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const tong = num(cellVal(row.getCell(11)));
    if (tong == null) continue;
    const d = dateStr(cellVal(row.getCell(1)));
    const supplierName = str(cellVal(row.getCell(10)));
    if (!d || !supplierName) continue;
    markers.push({
      date: d,
      supplierName,
      tong,
      vat: num(cellVal(row.getCell(12))) ?? 0,
      tongVat: num(cellVal(row.getCell(13))) ?? 0,
      row: r,
    });
  }
  return markers;
}

// Sanity check on the SOURCE data: "Thành Tiền" (col I) is supposed to be a
// formula (Đơn giá * SL Nhận), but a few rows in the real workbook have a
// hand-typed value that doesn't match — a genuine data-entry error in the
// legacy sheet, not an import bug. Surfaced in the reconciliation report
// because it's exactly why "Tổng Tiền" for that (date, supplier) disagrees
// with the recalculated total; the import itself is unaffected since
// receipt_items.line_total is always derived from unit_price * received_qty,
// never from this column.
export type ThanhTienAnomaly = {
  row: number;
  date: string;
  supplierName: string;
  sku: string;
  price: number;
  receivedQty: number;
  sheetThanhTien: number;
  expectedThanhTien: number;
};

export function findThanhTienAnomalies(wb: ExcelJS.Workbook): ThanhTienAnomaly[] {
  const ws = requiredSheet(wb, "Lich Su");
  const anomalies: ThanhTienAnomaly[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const ngay = cellVal(row.getCell(1));
    const d = dateStr(ngay);
    if (!d) continue;
    const price = num(cellVal(row.getCell(5))) ?? 0;
    const receivedQty = num(cellVal(row.getCell(7))) ?? 0;
    const sheetThanhTien = num(cellVal(row.getCell(9))) ?? 0;
    const expected = price * receivedQty;
    if (Math.abs(sheetThanhTien - expected) > 0.5) {
      anomalies.push({
        row: r,
        date: d,
        supplierName: str(cellVal(row.getCell(10))),
        sku: str(cellVal(row.getCell(3))),
        price,
        receivedQty,
        sheetThanhTien,
        expectedThanhTien: expected,
      });
    }
  }
  return anomalies;
}

export function readHoaDon(wb: ExcelJS.Workbook): { rows: HoaDonRow[]; totalNonEmptyRows: number } {
  const ws = requiredSheet(wb, "Lich_Su_Hoa_Don");
  const rows: HoaDonRow[] = [];
  let totalNonEmptyRows = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sku = cellVal(row.getCell(3));
    if (sku == null) continue;
    totalNonEmptyRows++;

    const ngayLuu = cellVal(row.getCell(1));
    const ngayXh = cellVal(row.getCell(2));
    const savedAt = ngayLuu instanceof Date ? ngayLuu.toISOString() : str(ngayLuu);
    const invoiceDate = dateStr(ngayXh) ?? "";
    const price = num(cellVal(row.getCell(5))) ?? 0;
    const quantity = num(cellVal(row.getCell(6))) ?? 0;

    rows.push({
      row: r,
      savedAt,
      invoiceDate,
      sku: str(sku),
      productName: str(cellVal(row.getCell(4))),
      price,
      quantity,
      supplierName: str(cellVal(row.getCell(8))),
    });
  }
  return { rows, totalNonEmptyRows };
}
