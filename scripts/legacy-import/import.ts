import type { createAdminClient } from "./db.ts";
import type { InvoiceGroup, NewProduct, ReceiptGroup } from "./types.ts";
import { LEGACY_RECEIVER_NAME } from "./normalize.ts";

type Supabase = ReturnType<typeof createAdminClient>;

export async function insertNewProducts(
  supabase: Supabase,
  newProducts: NewProduct[],
  supplierNameToId: Map<string, string>
): Promise<{ inserted: number; skus: string[] }> {
  if (newProducts.length === 0) return { inserted: 0, skus: [] };

  const rows = newProducts.map((p) => {
    const supplierId = supplierNameToId.get(p.supplierName);
    if (!supplierId) throw new Error(`Không tìm thấy NCC "${p.supplierName}" cho sản phẩm mới ${p.sku}.`);
    return {
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      current_price: p.price,
      supplier_id: supplierId,
    };
  });

  const { error } = await supabase.from("products").upsert(rows, { onConflict: "sku", ignoreDuplicates: true });
  if (error) throw error;

  return { inserted: rows.length, skus: rows.map((r) => r.sku) };
}

export type ReceiptImportOutcome = { legacyRef: string; receiptNo: string; inserted: boolean; error?: string };

export async function importReceipts(
  supabase: Supabase,
  groups: ReceiptGroup[],
  supplierNameToId: Map<string, string>,
  productSkuToId: Map<string, string>
): Promise<ReceiptImportOutcome[]> {
  const outcomes: ReceiptImportOutcome[] = [];

  for (const g of groups) {
    const supplierId = supplierNameToId.get(g.supplierName);
    if (!supplierId) {
      outcomes.push({ legacyRef: g.legacyRef, receiptNo: g.receiptNo, inserted: false, error: `Không tìm thấy NCC "${g.supplierName}"` });
      continue;
    }

    const items = [];
    let missingProduct: string | null = null;
    for (const item of g.items) {
      const productId = productSkuToId.get(item.sku);
      if (!productId) {
        missingProduct = item.sku;
        break;
      }
      items.push({
        product_id: productId,
        unit_price: item.unitPrice,
        delivered_qty: item.deliveredQty,
        received_qty: item.receivedQty,
      });
    }
    if (missingProduct) {
      outcomes.push({ legacyRef: g.legacyRef, receiptNo: g.receiptNo, inserted: false, error: `Không tìm thấy product cho SKU "${missingProduct}"` });
      continue;
    }

    const { data, error } = await supabase.rpc("import_legacy_receipt", {
      p_legacy_ref: g.legacyRef,
      p_receipt_no: g.receiptNo,
      p_receipt_date: g.receiptDate,
      p_shift: g.shift,
      p_supplier_id: supplierId,
      p_receiver_name: LEGACY_RECEIVER_NAME,
      p_note: `Nhập tự động từ Excel cũ (dòng gốc: ${g.sourceRows.join(", ")}).`,
      p_items: items,
    });

    if (error) {
      outcomes.push({ legacyRef: g.legacyRef, receiptNo: g.receiptNo, inserted: false, error: error.message });
      continue;
    }
    const row = data?.[0] as { receipt_id: string; receipt_no: string; inserted: boolean } | undefined;
    outcomes.push({ legacyRef: g.legacyRef, receiptNo: row?.receipt_no ?? g.receiptNo, inserted: row?.inserted ?? false });
  }

  return outcomes;
}

export type InvoiceImportOutcome = { legacyRef: string; invoiceNo: string; inserted: boolean; error?: string };

export async function importInvoices(
  supabase: Supabase,
  groups: InvoiceGroup[],
  supplierNameToId: Map<string, string>,
  productSkuToId: Map<string, string>
): Promise<InvoiceImportOutcome[]> {
  const outcomes: InvoiceImportOutcome[] = [];

  for (const g of groups) {
    const supplierId = supplierNameToId.get(g.supplierName);
    if (!supplierId) {
      outcomes.push({ legacyRef: g.legacyRef, invoiceNo: g.invoiceNo, inserted: false, error: `Không tìm thấy NCC "${g.supplierName}"` });
      continue;
    }

    const items = [];
    let missingProduct: string | null = null;
    for (const item of g.items) {
      const productId = productSkuToId.get(item.sku);
      if (!productId) {
        missingProduct = item.sku;
        break;
      }
      items.push({ product_id: productId, unit_price: item.unitPrice, quantity: item.quantity });
    }
    if (missingProduct) {
      outcomes.push({ legacyRef: g.legacyRef, invoiceNo: g.invoiceNo, inserted: false, error: `Không tìm thấy product cho SKU "${missingProduct}"` });
      continue;
    }

    const { data, error } = await supabase.rpc("import_legacy_invoice", {
      p_legacy_ref: g.legacyRef,
      p_supplier_id: supplierId,
      p_invoice_no: g.invoiceNo,
      p_invoice_date: g.invoiceDate,
      p_note: `Nhập tự động từ Excel cũ (Ngày Lưu gốc: ${g.savedAt}).`,
      p_items: items,
    });

    if (error) {
      outcomes.push({ legacyRef: g.legacyRef, invoiceNo: g.invoiceNo, inserted: false, error: error.message });
      continue;
    }
    const row = data?.[0] as { invoice_id: string; invoice_no: string; inserted: boolean } | undefined;
    outcomes.push({ legacyRef: g.legacyRef, invoiceNo: row?.invoice_no ?? g.invoiceNo, inserted: row?.inserted ?? false });
  }

  return outcomes;
}
