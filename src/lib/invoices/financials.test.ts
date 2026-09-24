// ============================================================
// PHASE UP2: calculateInvoiceFinancials unit tests
//
// Pure-function tests, no DB/network — run with `node --test`
// (Node's built-in test runner; this project runs on Node 24, which
// executes .ts test files directly, so no extra test framework dependency
// was added just for this).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateInvoiceFinancials } from "./financials.ts";

const oneItem = (quantity: number, unitPrice: number) => [{ quantity, unitPrice }];

// 1. household - no discount
test("household - no discount: final_amount = subtotal", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: oneItem(10, 1000),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.subtotal, 10000);
  assert.equal(result.data.discountType, null);
  assert.equal(result.data.discountAmount, 0);
  assert.equal(result.data.vatRate, 0);
  assert.equal(result.data.vatAmount, 0);
  assert.equal(result.data.finalAmount, 10000);
});

// 2. household - percent discount
test("household - percent discount: discount_amount = subtotal * pct / 100", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: oneItem(10, 1000), // subtotal 10000
    discountType: "percent",
    discountValue: 10,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.discountAmount, 1000);
  assert.equal(result.data.finalAmount, 9000);
});

// 3. household - fixed discount
test("household - fixed discount: discount_amount = discount_value", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: oneItem(10, 1000), // subtotal 10000
    discountType: "fixed_amount",
    discountValue: 1500,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.discountAmount, 1500);
  assert.equal(result.data.finalAmount, 8500);
});

// 4. household - discount 100%
test("household - 100% discount: final_amount = 0, not negative", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: oneItem(10, 1000),
    discountType: "percent",
    discountValue: 100,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.discountAmount, 10000);
  assert.equal(result.data.finalAmount, 0);
});

// 5. household - fixed discount > subtotal phải fail
test("household - fixed discount > subtotal fails", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: oneItem(10, 1000), // subtotal 10000
    discountType: "fixed_amount",
    discountValue: 10001,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "discountValue");
});

// 6. household - percent > 100 phải fail
test("household - percent discount > 100 fails", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: oneItem(10, 1000),
    discountType: "percent",
    discountValue: 101,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "discountValue");
});

// 7. company - VAT 8%
test("company - default VAT 8%: vat_amount + final_amount computed", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "company",
    items: oneItem(10, 1000), // subtotal 10000
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.vatRate, 8);
  assert.equal(result.data.vatAmount, 800);
  assert.equal(result.data.finalAmount, 10800);
  assert.equal(result.data.discountType, null);
  assert.equal(result.data.discountAmount, 0);
});

// 8. company - zero subtotal
test("company - zero subtotal (free item): all amounts zero, not a failure", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "company",
    items: oneItem(10, 0),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.subtotal, 0);
  assert.equal(result.data.vatAmount, 0);
  assert.equal(result.data.finalAmount, 0);
});

// 9. company - discount không hợp lệ phải fail
test("company - any discount input fails (company never gets a discount)", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "company",
    items: oneItem(10, 1000),
    discountType: "percent",
    discountValue: 10,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "discountType");
});

test("household - nonzero VAT input fails (household never gets VAT)", () => {
  const result = calculateInvoiceFinancials({
    supplierType: "business_household",
    items: oneItem(10, 1000),
    vatRate: 8,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "vatRate");
});

// 10. server calculation khác frontend preview thì server thắng
//
// There is nothing for a client-submitted final_amount to override: the
// server action's zod schema (src/lib/invoices/actions.ts) never accepts
// subtotal/discount_amount/vat_amount/final_amount from the client at all,
// and the RPC call only ever forwards this function's own output. This
// test instead proves the function is deterministic and re-derives from
// scratch every time regardless of what a caller might have computed
// before (e.g. a stale/tampered client preview) — calling it twice with
// the same inputs but a bogus intermediate never changes the result.
test("server always re-derives independently — a tampered preview cannot influence it", () => {
  const legitInput = {
    supplierType: "company" as const,
    items: oneItem(10, 1000),
    vatRate: 8,
  };
  const clientClaimedFinalAmount = 1; // what a malicious/buggy client might send
  void clientClaimedFinalAmount; // calculateInvoiceFinancials has no parameter for this at all

  const server1 = calculateInvoiceFinancials(legitInput);
  const server2 = calculateInvoiceFinancials(legitInput);
  assert.deepEqual(server1, server2);
  assert.equal(server1.ok, true);
  if (!server1.ok) return;
  assert.equal(server1.data.finalAmount, 10800);
  assert.notEqual(server1.data.finalAmount, clientClaimedFinalAmount);
});

test("items must be non-empty", () => {
  const result = calculateInvoiceFinancials({ supplierType: "company", items: [] });
  assert.equal(result.ok, false);
});

test("rounding matches numeric(15,2) — no drift across many small lines", () => {
  const items = Array.from({ length: 7 }, () => ({ quantity: 3, unitPrice: 33.33 }));
  const result = calculateInvoiceFinancials({ supplierType: "business_household", items });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 3 * 33.33 = 99.99 per line, 7 lines = 699.93
  assert.equal(result.data.subtotal, 699.93);
});
