// ============================================================
// PHASE UP2 — test 11: "invoice snapshot không đổi khi supplier thay đổi
// type/config sau đó".
//
// Unlike financials.test.ts (pure, no I/O), this hits the real Supabase
// cloud project (this repo has no local/dev DB — see supabase/migrations'
// workflow) via the create_invoice RPC, so it needs
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY:
//
//   node --env-file=.env.local --test src/lib/invoices/snapshot.integration.test.ts
//
// Creates its own throwaway supplier/product/invoice and always deletes
// them in `after`, even on failure — never touches pre-existing rows.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Chạy với `node --env-file=.env.local --test ...`."
  );
}
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const RUN_TAG = `UP2TEST_${Date.now()}`;
let supplierId: string;
let productId: string;
let invoiceId: string;

before(async () => {
  const { data: supplier, error: supplierErr } = await supabase
    .from("suppliers")
    .insert({ code: RUN_TAG, name: `${RUN_TAG} supplier`, supplier_type: "company" })
    .select("id")
    .single();
  if (supplierErr || !supplier) throw supplierErr ?? new Error("supplier insert failed");
  supplierId = supplier.id;

  const { data: product, error: productErr } = await supabase
    .from("products")
    .insert({ sku: RUN_TAG, name: `${RUN_TAG} product`, unit: "cái", current_price: 1000, supplier_id: supplierId })
    .select("id")
    .single();
  if (productErr || !product) throw productErr ?? new Error("product insert failed");
  productId = product.id;
});

after(async () => {
  if (invoiceId) {
    await supabase.from("invoice_items").delete().eq("invoice_id", invoiceId);
    await supabase.from("invoices").delete().eq("id", invoiceId);
  }
  if (productId) await supabase.from("products").delete().eq("id", productId);
  if (supplierId) await supabase.from("suppliers").delete().eq("id", supplierId);
});

test("invoice snapshot survives the supplier's type changing afterwards", async () => {
  // 1. Create the invoice while the supplier is still "company" — VAT 8%
  // applies and gets snapshotted (mirrors what createInvoice/actions.ts
  // does: subtotal/vat_amount/final_amount computed server-side, then
  // passed to the RPC — see calculateInvoiceFinancials).
  const subtotal = 10 * 1000;
  const vatRate = 8;
  const vatAmount = Math.round(((subtotal * vatRate) / 100 + Number.EPSILON) * 100) / 100;
  const finalAmount = Math.round((subtotal + vatAmount + Number.EPSILON) * 100) / 100;

  const { data: created, error: createErr } = await supabase.rpc("create_invoice", {
    p_supplier_id: supplierId,
    p_invoice_no: RUN_TAG,
    p_invoice_date: "2026-01-01",
    p_note: null,
    p_created_by: null,
    p_items: [{ product_id: productId, unit_price: 1000, quantity: 10 }],
    p_subtotal: subtotal,
    p_discount_type: null,
    p_discount_value: null,
    p_discount_amount: 0,
    p_vat_rate: vatRate,
    p_vat_amount: vatAmount,
    p_final_amount: finalAmount,
  });
  assert.equal(createErr, null, createErr?.message);
  invoiceId = created![0].invoice_id;

  const { data: before1 } = await supabase
    .from("invoices")
    .select("vat_rate, vat_amount, final_amount, discount_type, discount_amount")
    .eq("id", invoiceId)
    .single();
  assert.equal(before1!.vat_rate, 8);
  assert.equal(before1!.vat_amount, 800);
  assert.equal(before1!.final_amount, 10800);

  // 2. Change the supplier's type after the fact — this must not be able to
  // reach back into the already-created invoice.
  const { error: updateErr } = await supabase
    .from("suppliers")
    .update({ supplier_type: "business_household" })
    .eq("id", supplierId);
  assert.equal(updateErr, null, updateErr?.message);

  // 3. Re-fetch the invoice: its snapshot must be byte-for-byte identical.
  const { data: after1 } = await supabase
    .from("invoices")
    .select("vat_rate, vat_amount, final_amount, discount_type, discount_amount")
    .eq("id", invoiceId)
    .single();
  assert.deepEqual(after1, before1);
});
