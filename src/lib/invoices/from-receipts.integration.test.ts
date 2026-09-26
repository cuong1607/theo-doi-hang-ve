// ============================================================
// PHASE INV-FROM-RECEIPTS — database/service tests against the real
// Supabase cloud project (no local DB in this repo), same convention as
// snapshot.integration.test.ts:
//
//   node --env-file=.env.local --test src/lib/invoices/from-receipts.integration.test.ts
//
// Creates its own throwaway suppliers/products/receipts on isolated future
// dates (2031-09-xx) and deletes all of it in `after`, even on failure.
// Never touches pre-existing rows. Tests run sequentially and build on each
// other's data (one scenario, many assertions).
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { calculateInvoiceFinancials, type DiscountType, type SupplierType } from "./financials.ts";
import { normalizeReceiptDates } from "./receipt-days.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Chạy với `node --env-file=.env.local --test ...`."
  );
}
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const RUN_TAG = `IFRTEST_${Date.now()}`;
const D1 = "2031-09-01";
const D2 = "2031-09-02";
const D3 = "2031-09-03";
const D4 = "2031-09-04";
const D5 = "2031-09-05"; // company supplier
const D6 = "2031-09-06"; // household, no discount
const D7 = "2031-09-07"; // household, fixed discount
const D8 = "2031-09-08"; // concurrency
const ALL_DATES = [D1, D2, D3, D4, D5, D6, D7, D8];

const ids = {
  household: "",
  company: "",
  productA: "",
  productB: "",
  productC: "",
};
const receiptIds: Record<string, string> = {};
const createdInvoiceIds = new Set<string>();

type ItemInput = { productId: string; price: number; delivered: number; received: number };

async function createReceipt(supplierId: string, date: string, shift: "morning" | "afternoon", items: ItemInput[]) {
  return supabase.rpc("create_receipt", {
    p_receipt_date: date,
    p_shift: shift,
    p_supplier_id: supplierId,
    p_receiver_name: RUN_TAG,
    p_note: null,
    p_created_by: null,
    p_items: items.map((i) => ({
      product_id: i.productId,
      unit_price: i.price,
      delivered_qty: i.delivered,
      received_qty: i.received,
    })),
  });
}

async function mustCreateReceipt(label: string, ...args: Parameters<typeof createReceipt>) {
  const { data, error } = await createReceipt(...args);
  if (error || !data?.[0]) throw error ?? new Error(`receipt ${label} failed`);
  receiptIds[label] = data[0].receipt_id;
}

// Mirrors createInvoiceFromReceiptDays: server loads lines, prices them with
// calculateInvoiceFinancials, sends them to the RPC which re-validates.
async function createFromReceipts(
  supplierId: string,
  supplierType: SupplierType,
  dates: string[],
  invoiceNo: string,
  policy: { discountType?: DiscountType | null; discountValue?: number | null; vatRate?: number | null } = {},
  tamper?: (payload: Record<string, unknown>) => void
) {
  const normalized = normalizeReceiptDates(dates) ?? [];
  const { data: lines, error: linesError } = await supabase.rpc("get_receipt_days_invoice_lines", {
    p_supplier_id: supplierId,
    p_receipt_dates: normalized,
  });
  if (linesError) throw linesError;
  const typedLines = (lines ?? []) as { product_id: string; unit_price: number; quantity: number }[];
  const fin = calculateInvoiceFinancials({
    supplierType,
    items: typedLines.length
      ? typedLines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unit_price) }))
      : [{ quantity: 1, unitPrice: 0 }],
    discountType: policy.discountType ?? null,
    discountValue: policy.discountValue ?? null,
    vatRate: policy.vatRate ?? null,
  });
  if (!fin.ok) throw new Error(fin.error);
  const payload: Record<string, unknown> = {
    p_supplier_id: supplierId,
    p_receipt_dates: dates,
    p_invoice_no: invoiceNo,
    p_invoice_date: "2031-10-01",
    p_note: null,
    p_created_by: null,
    p_items: typedLines.map((l) => ({ product_id: l.product_id, unit_price: l.unit_price, quantity: l.quantity })),
    p_subtotal: fin.data.subtotal,
    p_discount_type: fin.data.discountType,
    p_discount_value: fin.data.discountValue,
    p_discount_amount: fin.data.discountAmount,
    p_vat_rate: fin.data.vatRate,
    p_vat_amount: fin.data.vatAmount,
    p_final_amount: fin.data.finalAmount,
  };
  tamper?.(payload);
  const result = await supabase.rpc("create_invoice_from_receipts", payload);
  const invoiceId = result.data?.[0]?.invoice_id as string | undefined;
  if (invoiceId) createdInvoiceIds.add(invoiceId);
  return { ...result, invoiceId, financials: fin.data };
}

async function outstandingFor(invoiceId: string) {
  const { data, error } = await supabase
    .from("v_outstanding")
    .select("invoice_item_id, product_id, unit_price, invoice_qty, received_qty, remaining_qty, invoice_value, received_value, remaining_value, status, source_type")
    .eq("invoice_id", invoiceId);
  if (error) throw error;
  return data as {
    invoice_item_id: string;
    product_id: string;
    unit_price: number;
    invoice_qty: number;
    received_qty: number;
    remaining_qty: number;
    invoice_value: number;
    received_value: number;
    remaining_value: number;
    status: string;
    source_type: string;
  }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

before(async () => {
  const { count } = await supabase
    .from("receipts")
    .select("id", { count: "exact", head: true })
    .in("receipt_date", ALL_DATES);
  if (count) throw new Error(`Test dates ${ALL_DATES.join(",")} already have ${count} real receipts — aborting.`);

  const { data: suppliers, error: sErr } = await supabase
    .from("suppliers")
    .insert([
      { code: `${RUN_TAG}_H`, name: `${RUN_TAG} hộ KD`, supplier_type: "business_household" },
      { code: `${RUN_TAG}_C`, name: `${RUN_TAG} công ty`, supplier_type: "company" },
    ])
    .select("id, supplier_type");
  if (sErr || !suppliers) throw sErr;
  ids.household = suppliers.find((s) => s.supplier_type === "business_household")!.id;
  ids.company = suppliers.find((s) => s.supplier_type === "company")!.id;

  const { data: products, error: pErr } = await supabase
    .from("products")
    .insert([
      { sku: `${RUN_TAG}-A`, name: "SP A", unit: "cái", current_price: 999, supplier_id: ids.household },
      { sku: `${RUN_TAG}-B`, name: "SP B", unit: "cái", current_price: 999, supplier_id: ids.household },
      { sku: `${RUN_TAG}-C`, name: "SP C", unit: "cái", current_price: 999, supplier_id: ids.company },
    ])
    .select("id, sku");
  if (pErr || !products) throw pErr;
  ids.productA = products.find((p) => p.sku.endsWith("-A"))!.id;
  ids.productB = products.find((p) => p.sku.endsWith("-B"))!.id;
  ids.productC = products.find((p) => p.sku.endsWith("-C"))!.id;

  const { household: H, company: C, productA: A, productB: B, productC: PC } = ids;
  // D1: morning + afternoon, two receipts in the morning shift.
  await mustCreateReceipt("d1_m1", H, D1, "morning", [
    { productId: A, price: 100000, delivered: 10, received: 10 },
    { productId: B, price: 20000, delivered: 6, received: 5 },
  ]);
  await mustCreateReceipt("d1_m2", H, D1, "morning", [{ productId: B, price: 20000, delivered: 3, received: 3 }]);
  await mustCreateReceipt("d1_a", H, D1, "afternoon", [{ productId: A, price: 100000, delivered: 4, received: 4 }]);
  // D2: NOT selected — must never be counted.
  await mustCreateReceipt("d2", H, D2, "morning", [{ productId: A, price: 100000, delivered: 50, received: 50 }]);
  // D3: same SKU, different price.
  await mustCreateReceipt("d3", H, D3, "morning", [{ productId: A, price: 110000, delivered: 7, received: 7 }]);
  // D4: a zero-received line (excluded) + B.
  await mustCreateReceipt("d4", H, D4, "afternoon", [
    { productId: A, price: 100000, delivered: 5, received: 0 },
    { productId: B, price: 20000, delivered: 2, received: 2 },
  ]);
  await mustCreateReceipt("d5", C, D5, "morning", [{ productId: PC, price: 50000, delivered: 100, received: 100 }]);
  await mustCreateReceipt("d6", H, D6, "morning", [{ productId: B, price: 20000, delivered: 10, received: 10 }]);
  await mustCreateReceipt("d7", H, D7, "morning", [{ productId: B, price: 20000, delivered: 10, received: 10 }]);
  await mustCreateReceipt("d8", H, D8, "morning", [{ productId: B, price: 20000, delivered: 1, received: 1 }]);
});

after(async () => {
  // Invoices first (cascade removes items + linked days, which unlocks the
  // receipt days), then receipts, then catalog rows.
  const { data: tagged } = await supabase
    .from("invoices")
    .select("id")
    .in("supplier_id", [ids.household, ids.company].filter(Boolean));
  for (const row of tagged ?? []) createdInvoiceIds.add(row.id);
  for (const id of createdInvoiceIds) {
    await supabase.from("invoices").delete().eq("id", id);
  }
  await supabase.from("receipts").delete().eq("receiver_name", RUN_TAG);
  await supabase.from("products").delete().like("sku", `${RUN_TAG}%`);
  await supabase.from("suppliers").delete().like("code", `${RUN_TAG}%`);
  // receipt_no counters for the isolated dates — only if nothing else uses them.
  const { count } = await supabase
    .from("receipts")
    .select("id", { count: "exact", head: true })
    .in("receipt_date", ALL_DATES);
  if (!count) await supabase.from("receipt_no_counters").delete().in("receipt_date", ALL_DATES);
});

let invoiceX = "";

test("create from 3 non-consecutive days (01,03,04 + duplicate 01) — grouping, start date, household % discount", async () => {
  const res = await createFromReceipts(ids.household, "business_household", [D4, D1, D3, D1], `${RUN_TAG}-X`, {
    discountType: "percent",
    discountValue: 10,
  });
  assert.equal(res.error, null, res.error?.message);
  invoiceX = res.invoiceId!;

  const { data: inv } = await supabase
    .from("invoices")
    .select("source_type, receipt_start_date, subtotal, discount_amount, vat_amount, final_amount, invoice_receipt_days(receipt_date, supplier_id), invoice_items(product_id, unit_price, quantity, line_total)")
    .eq("id", invoiceX)
    .single();
  assert.ok(inv);
  assert.equal(inv.source_type, "from_receipts");
  assert.equal(inv.receipt_start_date, D1, "receipt_start_date = earliest selected day");
  const linkedDays = (inv.invoice_receipt_days as { receipt_date: string; supplier_id: string }[])
    .map((d) => d.receipt_date)
    .sort();
  assert.deepEqual(linkedDays, [D1, D3, D4], "duplicate date normalized, D2 not linked");
  assert.ok((inv.invoice_receipt_days as { supplier_id: string }[]).every((d) => d.supplier_id === ids.household));

  const items = (inv.invoice_items as { product_id: string; unit_price: number; quantity: number; line_total: number }[])
    .map((i) => `${i.product_id === ids.productA ? "A" : "B"}@${i.unit_price}x${i.quantity}`)
    .sort();
  // A@100000: 10 (D1 morning) + 4 (D1 afternoon) = 14; A@110000 from D3 is
  // its own line; B: 5 + 3 (two D1 morning receipts) + 2 (D4) = 10; the
  // 0-received A line on D4 is dropped; D2's 50 is absent.
  assert.deepEqual(items, ["A@100000x14", "A@110000x7", "B@20000x10"]);

  assert.equal(Number(inv.subtotal), 2370000);
  assert.equal(Number(inv.discount_amount), 237000);
  assert.equal(Number(inv.vat_amount), 0);
  assert.equal(Number(inv.final_amount), 2133000);
});

test("from_receipts outstanding: received only from linked days, D2 never counted, status 'complete'", async () => {
  const rows = await outstandingFor(invoiceX);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.source_type, "from_receipts");
    assert.equal(Number(r.received_qty), Number(r.invoice_qty), "received = invoice qty (no D2 50)");
    assert.equal(Number(r.remaining_qty), 0);
    assert.equal(r.status, "complete");
  }
  // Financial outstanding: allocation of final_amount (with discount), not raw subtotal.
  const invoiceValue = round2(rows.reduce((s, r) => s + Number(r.invoice_value), 0));
  const receivedValue = round2(rows.reduce((s, r) => s + Number(r.received_value), 0));
  const remainingValue = round2(rows.reduce((s, r) => s + Number(r.remaining_value), 0));
  assert.equal(invoiceValue, 2133000);
  assert.equal(receivedValue, 2133000);
  assert.equal(remainingValue, 0);

  const a100 = rows.find((r) => r.product_id === ids.productA && Number(r.unit_price) === 100000)!;
  const { data: contributing } = await supabase.rpc("get_outstanding_contributing_receipts", {
    p_invoice_item_id: a100.invoice_item_id,
  });
  const rowsIn = contributing as { receipt_date: string; received_qty: number }[];
  // Linked days only (D4's A line at this price received 0 — listed, adds 0).
  assert.ok(rowsIn.every((c) => [D1, D3, D4].includes(c.receipt_date)), "never D2");
  assert.deepEqual(
    [...new Set(rowsIn.filter((c) => Number(c.received_qty) > 0).map((c) => c.receipt_date))],
    [D1]
  );
  assert.equal(
    (contributing as { received_qty: number }[]).reduce((s, c) => s + Number(c.received_qty), 0),
    14
  );
});

test("receipt history: linked days show the invoice, unselected D2 stays unlinked, filters still work", async () => {
  const { data } = await supabase.rpc("get_receipt_daily_groups", {
    p_from_date: D1,
    p_to_date: D4,
    p_supplier_id: ids.household,
    p_limit: 50,
    p_offset: 0,
  });
  const byDate = new Map((data as { receipt_date: string; linked_invoice_id: string | null; linked_invoice_no: string | null; total_received_qty: number }[]).map((r) => [r.receipt_date, r]));
  assert.equal(byDate.size, 4);
  for (const d of [D1, D3, D4]) {
    assert.equal(byDate.get(d)!.linked_invoice_id, invoiceX);
    assert.equal(byDate.get(d)!.linked_invoice_no, `${RUN_TAG}-X`);
  }
  assert.equal(byDate.get(D2)!.linked_invoice_id, null);
  // Linked join must not inflate the day totals: D1 received = 10+5+3+4.
  assert.equal(Number(byDate.get(D1)!.total_received_qty), 22);

  const { data: skuFiltered } = await supabase.rpc("get_receipt_daily_groups", {
    p_from_date: D1,
    p_to_date: D4,
    p_supplier_id: ids.household,
    p_sku: `${RUN_TAG}-B`,
    p_limit: 50,
    p_offset: 0,
  });
  const skuDates = (skuFiltered as { receipt_date: string }[]).map((r) => r.receipt_date).sort();
  assert.deepEqual(skuDates, [D1, D4], "SKU filter still narrows rows");

  const { data: nameFiltered } = await supabase.rpc("get_receipt_daily_groups", {
    p_supplier_id: ids.household,
    p_product_name: "SP A",
    p_from_date: D1,
    p_to_date: D3,
    p_limit: 50,
    p_offset: 0,
  });
  assert.equal((nameFiltered as unknown[]).length, 3);
});

test("already-invoiced day cannot be used again (HD001), mixed supplier / foreign day rejected (HD004)", async () => {
  const again = await createFromReceipts(ids.household, "business_household", [D1, D2], `${RUN_TAG}-DUP`);
  assert.equal(again.error?.code, "HD001");

  // D5 only has receipts of the COMPANY supplier — using it for the
  // household supplier (i.e. mixing suppliers) must fail.
  const mixed = await createFromReceipts(ids.household, "business_household", [D2, D5], `${RUN_TAG}-MIX`);
  assert.equal(mixed.error?.code, "HD004");
  assert.equal(mixed.invoiceId, undefined);
});

test("empty selection (HD006), duplicate invoice_no (HD003), stale lines (HD002), bad financials (HD008)", async () => {
  const empty = await createFromReceipts(ids.household, "business_household", [], `${RUN_TAG}-EMPTY`);
  assert.equal(empty.error?.code, "HD006");

  const dupNo = await createFromReceipts(ids.household, "business_household", [D2], `${RUN_TAG}-X`);
  assert.equal(dupNo.error?.code, "HD003");

  const stale = await createFromReceipts(ids.household, "business_household", [D2], `${RUN_TAG}-STALE`, {}, (p) => {
    const items = p.p_items as { quantity: number }[];
    items[0].quantity = Number(items[0].quantity) + 1; // client-side tampering / stale preview
  });
  assert.equal(stale.error?.code, "HD002");

  const badFin = await createFromReceipts(ids.household, "business_household", [D2], `${RUN_TAG}-BADFIN`, {}, (p) => {
    p.p_vat_rate = 8; // VAT on a household supplier
    p.p_vat_amount = 400000;
    p.p_final_amount = Number(p.p_subtotal) + 400000;
  });
  assert.equal(badFin.error?.code, "HD008");

  // None of the failures left anything behind for D2.
  const { count } = await supabase
    .from("invoice_receipt_days")
    .select("id", { count: "exact", head: true })
    .eq("supplier_id", ids.household)
    .eq("receipt_date", D2);
  assert.equal(count, 0);
});

test("company supplier: VAT 8% default", async () => {
  const res = await createFromReceipts(ids.company, "company", [D5], `${RUN_TAG}-C`, { vatRate: 8 });
  assert.equal(res.error, null, res.error?.message);
  const { data: inv } = await supabase.from("invoices").select("subtotal, vat_rate, vat_amount, discount_amount, final_amount").eq("id", res.invoiceId!).single();
  assert.equal(Number(inv!.subtotal), 5000000);
  assert.equal(Number(inv!.vat_rate), 8);
  assert.equal(Number(inv!.vat_amount), 400000);
  assert.equal(Number(inv!.discount_amount), 0);
  assert.equal(Number(inv!.final_amount), 5400000);

  const rows = await outstandingFor(res.invoiceId!);
  assert.equal(round2(rows.reduce((s, r) => s + Number(r.invoice_value), 0)), 5400000, "outstanding money includes VAT");
});

test("household: no discount, and fixed-amount discount", async () => {
  const none = await createFromReceipts(ids.household, "business_household", [D6], `${RUN_TAG}-H0`);
  assert.equal(none.error, null, none.error?.message);
  const { data: inv0 } = await supabase.from("invoices").select("subtotal, discount_amount, final_amount").eq("id", none.invoiceId!).single();
  assert.equal(Number(inv0!.subtotal), 200000);
  assert.equal(Number(inv0!.final_amount), 200000);

  const fixed = await createFromReceipts(ids.household, "business_household", [D7], `${RUN_TAG}-HF`, {
    discountType: "fixed_amount",
    discountValue: 50000,
  });
  assert.equal(fixed.error, null, fixed.error?.message);
  const { data: invF } = await supabase.from("invoices").select("discount_amount, final_amount").eq("id", fixed.invoiceId!).single();
  assert.equal(Number(invF!.discount_amount), 50000);
  assert.equal(Number(invF!.final_amount), 150000);
});

test("concurrency: two simultaneous creates for the same day — exactly one wins, the other fails cleanly", async () => {
  const [a, b] = await Promise.all([
    createFromReceipts(ids.household, "business_household", [D8], `${RUN_TAG}-RACE1`),
    createFromReceipts(ids.household, "business_household", [D8], `${RUN_TAG}-RACE2`),
  ]);
  const wins = [a, b].filter((r) => !r.error);
  const losses = [a, b].filter((r) => r.error);
  assert.equal(wins.length, 1, "exactly one invoice created");
  assert.equal(losses.length, 1);
  assert.equal(losses[0].error!.code, "HD001");
  const { count } = await supabase
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .in("invoice_no", [`${RUN_TAG}-RACE1`, `${RUN_TAG}-RACE2`]);
  assert.equal(count, 1, "no half-created invoice for the loser");
});

test("edit lock: linked day's receipts can't change qty, get new receipts, be moved in/out, or be deleted", async () => {
  const { data: d1Receipt } = await supabase
    .from("receipts")
    .select("id, receipt_items(id, product_id, unit_price, delivered_qty, received_qty)")
    .eq("id", receiptIds.d1_m1)
    .single();
  const items = (d1Receipt!.receipt_items as { id: string; product_id: string; unit_price: number; delivered_qty: number; received_qty: number }[]).map((i) => ({
    id: i.id,
    product_id: i.product_id,
    unit_price: i.unit_price,
    delivered_qty: i.delivered_qty,
    received_qty: i.received_qty,
  }));
  const updateArgs = (date: string, overrideItems = items, note: string | null = null) => ({
    p_receipt_id: receiptIds.d1_m1,
    p_receipt_date: date,
    p_shift: "morning",
    p_supplier_id: ids.household,
    p_receiver_name: RUN_TAG,
    p_note: note,
    p_items: overrideItems,
  });

  // 23: change received qty 10 -> 12 on a linked day.
  const qtyEdit = await supabase.rpc(
    "update_receipt",
    updateArgs(D1, items.map((i) => (i.product_id === ids.productA ? { ...i, received_qty: 12 } : i)))
  );
  assert.equal(qtyEdit.error?.code, "HD010");
  assert.match(qtyEdit.error!.message, new RegExp(`${RUN_TAG}-X`), "message names the invoice");

  // Note-only edit (items re-sent unchanged) is still allowed.
  const noteEdit = await supabase.rpc("update_receipt", updateArgs(D1, items, "ghi chú mới"));
  assert.equal(noteEdit.error, null, noteEdit.error?.message);

  // 24: new receipt on a linked day.
  const newOnLinked = await createReceipt(ids.household, D3, "afternoon", [
    { productId: ids.productB, price: 20000, delivered: 1, received: 1 },
  ]);
  assert.equal(newOnLinked.error?.code, "HD010");

  // 26: move a linked receipt OUT of its linked day.
  const moveOut = await supabase.rpc("update_receipt", updateArgs(D2));
  assert.equal(moveOut.error?.code, "HD010");

  // 25: move an unlinked receipt (D2) INTO a linked day.
  const { data: d2Receipt } = await supabase
    .from("receipts")
    .select("receipt_items(id, product_id, unit_price, delivered_qty, received_qty)")
    .eq("id", receiptIds.d2)
    .single();
  const moveIn = await supabase.rpc("update_receipt", {
    p_receipt_id: receiptIds.d2,
    p_receipt_date: D1,
    p_shift: "morning",
    p_supplier_id: ids.household,
    p_receiver_name: RUN_TAG,
    p_note: null,
    p_items: d2Receipt!.receipt_items,
  });
  assert.equal(moveIn.error?.code, "HD010");

  // Direct deletes (any future path) are blocked too.
  const delReceipt = await supabase.from("receipts").delete().eq("id", receiptIds.d4);
  assert.equal(delReceipt.error?.code, "HD010");
  const delItem = await supabase.from("receipt_items").delete().eq("receipt_id", receiptIds.d3);
  assert.equal(delItem.error?.code, "HD010");

  // Nothing changed: outstanding for X is still exactly as created.
  const rows = await outstandingFor(invoiceX);
  assert.ok(rows.every((r) => Number(r.remaining_qty) === 0));
  const { data: d2Still } = await supabase.from("receipts").select("receipt_date").eq("id", receiptIds.d2).single();
  assert.equal(d2Still!.receipt_date, D2);
});

test("edit from_receipts invoice: header/discount only; manual update RPC refused (HD009)", async () => {
  const { data: before } = await supabase.from("invoices").select("subtotal").eq("id", invoiceX).single();
  const subtotal = Number(before!.subtotal);
  const fin = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: [{ quantity: 1, unitPrice: subtotal }],
    discountType: "fixed_amount",
    discountValue: 70000,
  });
  assert.ok(fin.ok);
  const upd = await supabase.rpc("update_invoice_from_receipts_header", {
    p_invoice_id: invoiceX,
    p_invoice_no: `${RUN_TAG}-X2`,
    p_invoice_date: "2031-10-05",
    p_note: "sửa",
    p_subtotal: fin.data.subtotal,
    p_discount_type: fin.data.discountType,
    p_discount_value: fin.data.discountValue,
    p_discount_amount: fin.data.discountAmount,
    p_vat_rate: fin.data.vatRate,
    p_vat_amount: fin.data.vatAmount,
    p_final_amount: fin.data.finalAmount,
  });
  assert.equal(upd.error, null, upd.error?.message);
  const { data: after } = await supabase
    .from("invoices")
    .select("invoice_no, invoice_date, final_amount, receipt_start_date, supplier_id, invoice_receipt_days(receipt_date)")
    .eq("id", invoiceX)
    .single();
  assert.equal(after!.invoice_no, `${RUN_TAG}-X2`);
  assert.equal(Number(after!.final_amount), 2300000);
  assert.equal(after!.receipt_start_date, D1, "receipt_start_date unchanged");
  assert.equal((after!.invoice_receipt_days as unknown[]).length, 3, "linked days unchanged");

  // Tampered subtotal is refused.
  const badSubtotal = await supabase.rpc("update_invoice_from_receipts_header", {
    p_invoice_id: invoiceX,
    p_invoice_no: `${RUN_TAG}-X2`,
    p_invoice_date: "2031-10-05",
    p_note: null,
    p_subtotal: 1,
    p_discount_type: null,
    p_discount_value: null,
    p_discount_amount: 0,
    p_vat_rate: 0,
    p_vat_amount: 0,
    p_final_amount: 1,
  });
  assert.equal(badSubtotal.error?.code, "HD008");

  const manualPath = await supabase.rpc("update_invoice", {
    p_invoice_id: invoiceX,
    p_supplier_id: ids.household,
    p_invoice_no: `${RUN_TAG}-X2`,
    p_invoice_date: "2031-10-05",
    p_note: null,
    p_items: [{ product_id: ids.productA, unit_price: 1, quantity: 999 }],
    p_subtotal: 999,
    p_discount_type: null,
    p_discount_value: null,
    p_discount_amount: 0,
    p_vat_rate: 0,
    p_vat_amount: 0,
    p_final_amount: 999,
  });
  assert.equal(manualPath.error?.code, "HD009");

  // Supplier of an invoice with linked days can't be switched underneath
  // them (composite FK invoice_id+supplier_id).
  const supplierSwap = await supabase.from("invoices").update({ supplier_id: ids.company }).eq("id", invoiceX);
  assert.ok(supplierSwap.error, "supplier change blocked by composite FK");
});

test("manual invoice: outstanding keeps the existing receipt_date >= invoice_date rule, new 'complete'/'low' statuses", async () => {
  const create = (invoiceNo: string, invoiceDate: string, qty: number) => {
    const fin = calculateInvoiceFinancials({
      supplierType: "business_household",
      items: [{ quantity: qty, unitPrice: 100000 }],
    });
    assert.ok(fin.ok);
    return supabase.rpc("create_invoice", {
      p_supplier_id: ids.household,
      p_invoice_no: invoiceNo,
      p_invoice_date: invoiceDate,
      p_note: null,
      p_created_by: null,
      p_items: [{ product_id: ids.productA, unit_price: 100000, quantity: qty }],
      p_subtotal: fin.data.subtotal,
      p_discount_type: null,
      p_discount_value: null,
      p_discount_amount: 0,
      p_vat_rate: 0,
      p_vat_amount: 0,
      p_final_amount: fin.data.finalAmount,
    });
  };

  // SKU A for the household supplier on/after D2: D2 50 + D3 7 (price ignored
  // by the manual rule, linked or not — unchanged behavior) + D4 0 = 57.
  const m1 = await create(`${RUN_TAG}-M1`, D2, 100);
  assert.equal(m1.error, null, m1.error?.message);
  createdInvoiceIds.add(m1.data![0].invoice_id);
  const [r1] = await outstandingFor(m1.data![0].invoice_id);
  assert.equal(r1.source_type, "manual");
  assert.equal(Number(r1.received_qty), 57);
  assert.equal(r1.status, "normal");

  const m2 = await create(`${RUN_TAG}-M2`, D2, 57);
  createdInvoiceIds.add(m2.data![0].invoice_id);
  assert.equal((await outstandingFor(m2.data![0].invoice_id))[0].status, "complete", "remaining 0 => Đã đủ");

  const m3 = await create(`${RUN_TAG}-M3`, D2, 60);
  createdInvoiceIds.add(m3.data![0].invoice_id);
  assert.equal((await outstandingFor(m3.data![0].invoice_id))[0].status, "low", "remaining 3 => Sắp hết");

  const m4 = await create(`${RUN_TAG}-M4`, D2, 50);
  createdInvoiceIds.add(m4.data![0].invoice_id);
  assert.equal((await outstandingFor(m4.data![0].invoice_id))[0].status, "need_makeup", "remaining -7 => Cần xuất bù");

  // Manual invoices still reject a repeated SKU at the DB level only when
  // the price repeats too — the one-line-per-SKU rule is the app's zod
  // schema (unchanged); here just confirm (product, price) uniqueness.
  const { error: dupLine } = await supabase
    .from("invoice_items")
    .insert({ invoice_id: m1.data![0].invoice_id, product_id: ids.productA, unit_price: 100000, quantity: 1 });
  assert.equal(dupLine?.code, "23505");
});

test("delete from_receipts invoice: linked days cascade away, become selectable and editable again", async () => {
  const { error } = await supabase.from("invoices").delete().eq("id", invoiceX);
  assert.equal(error, null, error?.message);
  createdInvoiceIds.delete(invoiceX);

  const { count } = await supabase
    .from("invoice_receipt_days")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", invoiceX);
  assert.equal(count, 0);

  const { data: groups } = await supabase.rpc("get_receipt_daily_groups", {
    p_from_date: D1,
    p_to_date: D4,
    p_supplier_id: ids.household,
    p_limit: 50,
    p_offset: 0,
  });
  assert.ok((groups as { linked_invoice_id: string | null }[]).every((g) => g.linked_invoice_id === null));

  // Receipt data survived and is editable again.
  const { data: d1 } = await supabase.from("receipts").select("id").eq("id", receiptIds.d1_m1).single();
  assert.ok(d1);
  const again = await createFromReceipts(ids.household, "business_household", [D1, D3], `${RUN_TAG}-Y`);
  assert.equal(again.error, null, again.error?.message);
});
