// ============================================================
// PHASE UP3 — edit-flow tests 6, 7, 8, 9, 12 from the phase spec.
//
// Exercises create_invoice / update_invoice RPCs directly (same calls
// createInvoice/updateInvoice in actions.ts make internally), computing
// each expected snapshot via calculateInvoiceFinancials exactly like the
// server action does. The action functions themselves can't be called
// from a plain node:test script — they call next/cache's revalidatePath,
// which requires a live Next.js request context — so this is the same
// approach snapshot.integration.test.ts (UP2) already uses.
//
//   node --env-file=.env.local --test src/lib/invoices/edit-flow.integration.test.ts
//
// Creates its own throwaway suppliers/products/invoices and always deletes
// them in `after`, even on failure — never touches pre-existing rows.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { calculateInvoiceFinancials } from "./financials.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Chạy với `node --env-file=.env.local --test ...`."
  );
}
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const RUN_TAG = `UP3TEST_${Date.now()}`;
let householdSupplierId: string;
let companySupplierId: string;
let householdProductId: string;
let companyProductId: string;
const createdInvoiceIds: string[] = [];

before(async () => {
  const { data: household, error: hhErr } = await supabase
    .from("suppliers")
    .insert({ code: `${RUN_TAG}_HH`, name: `${RUN_TAG} household`, supplier_type: "business_household" })
    .select("id")
    .single();
  if (hhErr || !household) throw hhErr ?? new Error("household supplier insert failed");
  householdSupplierId = household.id;

  const { data: company, error: coErr } = await supabase
    .from("suppliers")
    .insert({ code: `${RUN_TAG}_CO`, name: `${RUN_TAG} company`, supplier_type: "company" })
    .select("id")
    .single();
  if (coErr || !company) throw coErr ?? new Error("company supplier insert failed");
  companySupplierId = company.id;

  const { data: hhProduct, error: hhProductErr } = await supabase
    .from("products")
    .insert({
      sku: `${RUN_TAG}_HH`,
      name: `${RUN_TAG} household product`,
      unit: "cái",
      current_price: 1000,
      supplier_id: householdSupplierId,
    })
    .select("id")
    .single();
  if (hhProductErr || !hhProduct) throw hhProductErr ?? new Error("household product insert failed");
  householdProductId = hhProduct.id;

  const { data: coProduct, error: coProductErr } = await supabase
    .from("products")
    .insert({
      sku: `${RUN_TAG}_CO`,
      name: `${RUN_TAG} company product`,
      unit: "cái",
      current_price: 1000,
      supplier_id: companySupplierId,
    })
    .select("id")
    .single();
  if (coProductErr || !coProduct) throw coProductErr ?? new Error("company product insert failed");
  companyProductId = coProduct.id;
});

after(async () => {
  for (const id of createdInvoiceIds) {
    await supabase.from("invoice_items").delete().eq("invoice_id", id);
    await supabase.from("invoices").delete().eq("id", id);
  }
  if (householdProductId) await supabase.from("products").delete().eq("id", householdProductId);
  if (companyProductId) await supabase.from("products").delete().eq("id", companyProductId);
  if (householdSupplierId) await supabase.from("suppliers").delete().eq("id", householdSupplierId);
  if (companySupplierId) await supabase.from("suppliers").delete().eq("id", companySupplierId);
});

async function createInvoiceViaRpc(opts: {
  supplierId: string;
  productId: string;
  invoiceNo: string;
  supplierType: "business_household" | "company";
  discountType?: "percent" | "fixed_amount" | null;
  discountValue?: number | null;
  vatRate?: number | null;
  quantity?: number;
  unitPrice?: number;
}) {
  const quantity = opts.quantity ?? 10;
  const unitPrice = opts.unitPrice ?? 1000;
  const financials = calculateInvoiceFinancials({
    supplierType: opts.supplierType,
    items: [{ quantity, unitPrice }],
    discountType: opts.discountType ?? null,
    discountValue: opts.discountValue ?? null,
    vatRate: opts.vatRate ?? null,
  });
  assert.equal(financials.ok, true);
  if (!financials.ok) throw new Error("unreachable");

  const { data, error } = await supabase.rpc("create_invoice", {
    p_supplier_id: opts.supplierId,
    p_invoice_no: opts.invoiceNo,
    p_invoice_date: "2026-01-01",
    p_note: null,
    p_created_by: null,
    p_items: [{ product_id: opts.productId, unit_price: unitPrice, quantity }],
    p_subtotal: financials.data.subtotal,
    p_discount_type: financials.data.discountType,
    p_discount_value: financials.data.discountValue,
    p_discount_amount: financials.data.discountAmount,
    p_vat_rate: financials.data.vatRate,
    p_vat_amount: financials.data.vatAmount,
    p_final_amount: financials.data.finalAmount,
  });
  assert.equal(error, null, error?.message);
  const invoiceId = data![0].invoice_id as string;
  createdInvoiceIds.push(invoiceId);
  return { invoiceId, financials: financials.data };
}

async function updateInvoiceViaRpc(opts: {
  invoiceId: string;
  itemId: string;
  supplierId: string;
  productId: string;
  invoiceNo: string;
  supplierType: "business_household" | "company";
  discountType?: "percent" | "fixed_amount" | null;
  discountValue?: number | null;
  vatRate?: number | null;
  quantity?: number;
  unitPrice?: number;
}) {
  const quantity = opts.quantity ?? 10;
  const unitPrice = opts.unitPrice ?? 1000;
  const financials = calculateInvoiceFinancials({
    supplierType: opts.supplierType,
    items: [{ quantity, unitPrice }],
    discountType: opts.discountType ?? null,
    discountValue: opts.discountValue ?? null,
    vatRate: opts.vatRate ?? null,
  });
  assert.equal(financials.ok, true);
  if (!financials.ok) throw new Error("unreachable");

  const { error } = await supabase.rpc("update_invoice", {
    p_invoice_id: opts.invoiceId,
    p_supplier_id: opts.supplierId,
    p_invoice_no: opts.invoiceNo,
    p_invoice_date: "2026-01-01",
    p_note: null,
    p_items: [{ id: opts.itemId, product_id: opts.productId, unit_price: unitPrice, quantity }],
    p_subtotal: financials.data.subtotal,
    p_discount_type: financials.data.discountType,
    p_discount_value: financials.data.discountValue,
    p_discount_amount: financials.data.discountAmount,
    p_vat_rate: financials.data.vatRate,
    p_vat_amount: financials.data.vatAmount,
    p_final_amount: financials.data.finalAmount,
  });
  assert.equal(error, null, error?.message);
  return financials.data;
}

async function fetchSnapshot(invoiceId: string) {
  const { data } = await supabase
    .from("invoices")
    .select("supplier_id, subtotal, discount_type, discount_value, discount_amount, vat_rate, vat_amount, final_amount")
    .eq("id", invoiceId)
    .single();
  return data!;
}

// 6. household giữ snapshot cũ (re-submitting the same policy on edit must
// reproduce the exact same numbers, not drift).
test("edit: household invoice keeps its discount snapshot when nothing about the policy changes", async () => {
  const { invoiceId, financials: created } = await createInvoiceViaRpc({
    supplierId: householdSupplierId,
    productId: householdProductId,
    invoiceNo: `${RUN_TAG}-6`,
    supplierType: "business_household",
    discountType: "percent",
    discountValue: 3,
  });

  const { data: item } = await supabase.from("invoice_items").select("id").eq("invoice_id", invoiceId).single();

  const updated = await updateInvoiceViaRpc({
    invoiceId,
    itemId: item!.id,
    supplierId: householdSupplierId,
    productId: householdProductId,
    invoiceNo: `${RUN_TAG}-6`,
    supplierType: "business_household",
    discountType: "percent",
    discountValue: 3,
  });

  assert.deepEqual(updated, created);
  assert.equal(created.discountAmount, 300); // 3% of 10000
  assert.equal(created.finalAmount, 9700);
});

// 7. company giữ VAT snapshot cũ
test("edit: company invoice keeps its VAT snapshot when nothing about the policy changes", async () => {
  const { invoiceId, financials: created } = await createInvoiceViaRpc({
    supplierId: companySupplierId,
    productId: companyProductId,
    invoiceNo: `${RUN_TAG}-7`,
    supplierType: "company",
    vatRate: 8,
  });

  const { data: item } = await supabase.from("invoice_items").select("id").eq("invoice_id", invoiceId).single();

  const updated = await updateInvoiceViaRpc({
    invoiceId,
    itemId: item!.id,
    supplierId: companySupplierId,
    productId: companyProductId,
    invoiceNo: `${RUN_TAG}-7`,
    supplierType: "company",
    vatRate: 8,
  });

  assert.deepEqual(updated, created);
  assert.equal(created.vatAmount, 800);
  assert.equal(created.finalAmount, 10800);
});

// 8. đổi household -> company: xóa discount, set VAT mặc định 8%
test("edit: switching household -> company clears discount and applies default VAT 8%", async () => {
  const { invoiceId } = await createInvoiceViaRpc({
    supplierId: householdSupplierId,
    productId: householdProductId,
    invoiceNo: `${RUN_TAG}-8`,
    supplierType: "business_household",
    discountType: "percent",
    discountValue: 10,
  });
  const { data: item } = await supabase.from("invoice_items").select("id").eq("invoice_id", invoiceId).single();

  // Simulates what the edit form sends after the user switches supplier and
  // confirms the policy reset: new supplier, discount cleared, VAT defaulted.
  await updateInvoiceViaRpc({
    invoiceId,
    itemId: item!.id,
    supplierId: companySupplierId,
    productId: companyProductId,
    invoiceNo: `${RUN_TAG}-8`,
    supplierType: "company",
    discountType: null,
    vatRate: 8,
  });

  const snapshot = await fetchSnapshot(invoiceId);
  assert.equal(snapshot.supplier_id, companySupplierId);
  assert.equal(snapshot.discount_type, null);
  assert.equal(Number(snapshot.discount_amount), 0);
  assert.equal(Number(snapshot.vat_rate), 8);
  assert.equal(Number(snapshot.vat_amount), 800);
  assert.equal(Number(snapshot.final_amount), 10800);
});

// 9. đổi company -> household: VAT = 0, chọn discount hoặc không áp dụng
test("edit: switching company -> household zeroes VAT and lets a discount be chosen", async () => {
  const { invoiceId } = await createInvoiceViaRpc({
    supplierId: companySupplierId,
    productId: companyProductId,
    invoiceNo: `${RUN_TAG}-9`,
    supplierType: "company",
    vatRate: 8,
  });
  const { data: item } = await supabase.from("invoice_items").select("id").eq("invoice_id", invoiceId).single();

  await updateInvoiceViaRpc({
    invoiceId,
    itemId: item!.id,
    supplierId: householdSupplierId,
    productId: householdProductId,
    invoiceNo: `${RUN_TAG}-9`,
    supplierType: "business_household",
    discountType: "fixed_amount",
    discountValue: 1500,
  });

  const snapshot = await fetchSnapshot(invoiceId);
  assert.equal(snapshot.supplier_id, householdSupplierId);
  assert.equal(Number(snapshot.vat_rate), 0);
  assert.equal(Number(snapshot.vat_amount), 0);
  assert.equal(snapshot.discount_type, "fixed_amount");
  assert.equal(Number(snapshot.discount_amount), 1500);
  assert.equal(Number(snapshot.final_amount), 8500);
});

// 12. invoice list dùng final_amount (v_invoice_summary.total_amount must
// mirror invoices.final_amount exactly, not a fresh SUM(line_total)).
test("list: v_invoice_summary.total_amount equals invoices.final_amount", async () => {
  const { invoiceId, financials } = await createInvoiceViaRpc({
    supplierId: companySupplierId,
    productId: companyProductId,
    invoiceNo: `${RUN_TAG}-12`,
    supplierType: "company",
    vatRate: 8,
  });

  const { data: summaryRow } = await supabase
    .from("v_invoice_summary")
    .select("total_amount, final_amount")
    .eq("id", invoiceId)
    .single();

  assert.equal(Number(summaryRow!.total_amount), financials.finalAmount);
  assert.equal(Number(summaryRow!.final_amount), financials.finalAmount);
});
