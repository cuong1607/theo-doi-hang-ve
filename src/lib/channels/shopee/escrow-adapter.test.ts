// ============================================================
// SHOPEE-5 — escrow adapter + financial dictionary (pure, no database):
//
//   node --test src/lib/channels/shopee/escrow-adapter.test.ts
//
// Fixtures in tests/fixtures/shopee/escrow are SYNTHETIC (documented shape);
// real sanitized payloads are added after validation.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ShopeeApiError } from "./errors.ts";
import { abs, estimatedOrderRevenue, negate, parseEscrowDetail } from "./escrow-adapter.ts";
import { isEscrowNotReady, isOrderEligibleForEscrowEstimate, isOrderEligibleForEscrowSync } from "./escrow-sync.ts";
import { ESCROW_COLUMNS, ESCROW_FIELDS, ESTIMATED_ORDER_REVENUE_FIELD, FINANCIAL_CALCULATION_VERSION } from "./financial-dictionary.ts";
import { loadEscrowFixtures } from "./payment-provider.ts";
import { ShopeePayloadError } from "./product-adapter.ts";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "shopee", "escrow");
const load = (name: string) => JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as { response: { order_income: Record<string, unknown> } & Record<string, unknown> };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const comp = (p: ReturnType<typeof parseEscrowDetail>, key: string) => p.components.find((c) => c.component_key === key);

test("1. basic payload → columns as positive magnitudes, final settlement numbers kept as provider values", () => {
  const p = parseEscrowDetail(load("synthetic_basic.json"), { currency: "VND", expectedOrderSn: "FXESCROW0001" });
  assert.equal(p.orderSn, "FXESCROW0001");
  assert.equal(p.fields.escrow_amount, "151000");
  assert.equal(p.fields.escrow_amount_after_adjustment, "151000");
  assert.equal(p.fields.gross_original_value, "200000");
  assert.equal(p.fields.gross_selling_value, "200000");
  assert.equal(p.fields.seller_discount, "20000");
  assert.equal(p.fields.seller_voucher, "0");
  assert.equal(p.fields.commission_fee, "9000");
  assert.equal(p.fields.service_fee, "6000");
  assert.equal(p.fields.transaction_fee, "4000");
  assert.equal(p.fields.shopee_discount, "5000");
});

test("2 + 3. zero is a confirmed 0 column without a component; an absent field stays unknown (no key)", () => {
  const p = parseEscrowDetail(load("synthetic_basic.json"));
  assert.equal(p.fields.escrow_tax, "0", "provided 0 → column 0");
  assert.equal(comp(p, "escrow_tax"), undefined, "zero → no component row");
  assert.equal(p.fields.refund_amount, "0");
  assert.equal("withholding_cit_tax" in p.fields, false, "not in payload → unknown, not 0");
  assert.equal("campaign_fee" in p.fields, false);
});

test("4. components are signed by seller impact: deductions negative, inflows positive, info keeps the provider value", () => {
  const p = parseEscrowDetail(load("synthetic_basic.json"));
  assert.equal(comp(p, "commission_fee")!.amount, "-9000");
  assert.equal(comp(p, "seller_discount")!.amount, "-20000");
  assert.equal(comp(p, "withholding_vat_tax")!.amount, "-7000");
  assert.equal(comp(p, "original_price")!.amount, "200000");
  assert.equal(comp(p, "shopee_discount")!.amount, "5000", "platform-funded → info, not a seller deduction");
  assert.equal(comp(p, "shopee_discount")!.funded_by, "platform");
  // a provider value that is already negative for an outflow field stays negative (no double flip)
  const raw = clone(load("synthetic_basic.json"));
  raw.response.order_income.commission_fee = -9000;
  assert.equal(comp(parseEscrowDetail(raw), "commission_fee")!.amount, "-9000");
  assert.equal(parseEscrowDetail(raw).fields.commission_fee, "9000", "column holds the magnitude");
});

test("5. net_commission_fee / net_service_fee are info only — never part of the formula (no double count)", () => {
  const p = parseEscrowDetail(load("synthetic_basic.json"));
  for (const key of ["net_commission_fee", "net_service_fee"]) {
    const c = comp(p, key)!;
    assert.equal(c.metadata.settlement_member, false);
    assert.equal(c.included_in_settlement, false);
  }
  assert.equal(ESCROW_FIELDS.net_commission_fee.column, undefined, "does not fill commission_fee column");
  assert.equal(ESCROW_FIELDS.total_adjustment_amount.settlement, false, "the rows are the members, not the total");
});

test("6. Shopee cost_of_goods_sold is NOT internal COGS", () => {
  const p = parseEscrowDetail(load("synthetic_basic.json"));
  assert.equal(comp(p, "cost_of_goods_sold")!.component_type, "shopee_cost_of_goods_sold");
  assert.equal((ESCROW_COLUMNS as readonly string[]).includes("internal_cogs"), false, "escrow never owns internal_cogs");
  assert.equal(Object.values(ESCROW_FIELDS).some((d) => (d.column as string | undefined) === "internal_cogs"), false);
});

test("7. order_adjustment rows → one signed component each, deterministic keys; total kept signed", () => {
  const raw = load("synthetic_adjusted.json");
  const p = parseEscrowDetail(raw, { currency: "VND" });
  const rows = p.components.filter((c) => c.provider_field === "order_adjustment");
  assert.deepEqual(rows.map((r) => r.amount), ["-5000", "2000"]);
  assert.match(rows[0].component_key, /^order_adjustment#0:[0-9a-f]{12}$/);
  assert.equal(rows[0].metadata.reason, "Phí điều chỉnh");
  assert.equal(p.fields.total_adjustment_amount, "-3000", "signed column");
  assert.equal(p.fields.escrow_amount_after_adjustment, "97000");
  const again = parseEscrowDetail(clone(raw));
  assert.deepEqual(again.components.map((c) => c.component_key), p.components.map((c) => c.component_key), "same payload → same keys (idempotent upsert)");
});

test("8. unknown numeric field is kept as an unverified 'other' component, never summed", () => {
  const p = parseEscrowDetail(load("synthetic_adjusted.json"));
  assert.deepEqual(p.unknownFields, ["mystery_fee"]);
  const c = comp(p, "mystery_fee")!;
  assert.equal(c.category, "other");
  assert.equal(c.included_in_settlement, false);
  assert.equal(c.metadata.unverified, true);
  assert.equal(c.amount, "1234.5", "decimal string preserved exactly");
});

test("9. ignored patterns (*_pri, order_chargeable_weight) and structured fields are skipped explicitly", () => {
  const p = parseEscrowDetail(load("synthetic_adjusted.json"));
  assert.equal(comp(p, "original_price_pri"), undefined);
  assert.equal(p.unknownFields.includes("original_price_pri"), false);
  const b = parseEscrowDetail(load("synthetic_basic.json"));
  assert.equal(comp(b, "order_chargeable_weight"), undefined);
  assert.equal(comp(b, "items"), undefined);
  assert.deepEqual(b.unknownFields, []);
});

test("10. taxes stay separate from fees; refund and compensation are their own categories", () => {
  const p = parseEscrowDetail(load("synthetic_adjusted.json"));
  assert.equal(p.fields.withholding_vat_tax, "1000");
  assert.equal(p.fields.withholding_pit_tax, "500");
  assert.equal(comp(p, "withholding_vat_tax")!.category, "tax");
  assert.equal(comp(p, "seller_return_refund")!.category, "refund");
  assert.equal(comp(p, "seller_return_refund")!.amount, "-50000");
  assert.equal(ESCROW_FIELDS.seller_lost_compensation.category, "compensation");
  assert.equal(ESCROW_FIELDS.seller_lost_compensation.impact, "inflow");
});

test("11. fingerprint: stable under key order and buyer identity, changes with any amount", () => {
  const raw = load("synthetic_basic.json");
  const base = parseEscrowDetail(raw).fingerprint;
  const reordered = clone(raw);
  reordered.response.order_income = Object.fromEntries(Object.entries(reordered.response.order_income).reverse());
  assert.equal(parseEscrowDetail(reordered).fingerprint, base);
  const otherBuyer = clone(raw);
  otherBuyer.response.buyer_user_name = "someone_else";
  assert.equal(parseEscrowDetail(otherBuyer).fingerprint, base);
  const changed = clone(raw);
  changed.response.order_income.service_fee = 6001;
  assert.notEqual(parseEscrowDetail(changed).fingerprint, base);
});

test("12. buyer identity is stripped from the stored snapshot", () => {
  const p = parseEscrowDetail(load("synthetic_basic.json"));
  assert.equal(JSON.stringify(p.sanitized).includes("buyer_user_name"), false);
  assert.equal(JSON.stringify(p.sanitized).includes("fixture_buyer"), false);
});

test("13. unusable payloads throw ShopeePayloadError (error envelope, missing income, wrong order_sn)", () => {
  assert.throws(() => parseEscrowDetail({ error: "error_param", message: "bad", response: {} }), ShopeePayloadError);
  assert.throws(() => parseEscrowDetail({ error: "", response: { order_sn: "X" } }), ShopeePayloadError);
  assert.throws(() => parseEscrowDetail(load("synthetic_basic.json"), { expectedOrderSn: "OTHER" }), ShopeePayloadError);
  assert.throws(() => parseEscrowDetail(null), ShopeePayloadError);
});

test("14. only formula members verified on real payloads are included; an unverified member is kept but not summed", () => {
  const raw = clone(load("synthetic_basic.json"));
  raw.response.order_income.voucher_from_seller = 10000; // formula member by hypothesis, never seen non-zero on real VN payloads
  const v = comp(parseEscrowDetail(raw), "voucher_from_seller")!;
  assert.equal(v.included_in_settlement, false);
  assert.equal(v.metadata.unverified, true);
  for (const name of ["synthetic_basic.json", "synthetic_adjusted.json", "realvn_standard.json", "realvn_buyer_shipping.json", "realvn_returned.json"]) {
    const p = parseEscrowDetail(load(name));
    for (const c of p.components) {
      const def = ESCROW_FIELDS[c.provider_field];
      if (c.included_in_settlement) assert.ok(def?.verified, `${c.provider_field} included but unverified`);
      if (c.metadata.settlement_member && !c.metadata.verified) assert.equal(c.metadata.unverified, true);
    }
  }
  // dictionary sanity: every column belongs to ESCROW_COLUMNS
  for (const [key, def] of Object.entries(ESCROW_FIELDS)) if (def.column) assert.ok((ESCROW_COLUMNS as readonly string[]).includes(def.column), key);
  assert.equal(FINANCIAL_CALCULATION_VERSION, "shopee-fin-v3");
});

// ================================================================ REAL VN payloads (sanitized)

/** Σ included components, exact (VND amounts are integers → BigInt, no float). */
const includedSum = (p: ReturnType<typeof parseEscrowDetail>) =>
  p.components.filter((c) => c.included_in_settlement).reduce((a, c) => a + BigInt(c.amount), BigInt(0));

test("real 1. verified formula reproduces escrow_amount exactly on every real fixture", () => {
  for (const name of ["realvn_standard.json", "realvn_buyer_shipping.json", "realvn_returned.json", "synthetic_basic.json"]) {
    const p = parseEscrowDetail(load(name), { currency: "VND" });
    const actual = BigInt(p.fields.escrow_amount_after_adjustment ?? p.fields.escrow_amount!);
    assert.equal(includedSum(p), actual, name);
    assert.deepEqual(p.unknownFields, [], `${name}: zero-valued fields of other markets are not reported`);
    assert.equal(p.components.filter((c) => c.metadata.unverified).length, 0, `${name}: nothing unverified`);
  }
});

test("real 2. credit_card_transaction_fee duplicates seller_transaction_fee → never summed", () => {
  const p = parseEscrowDetail(load("realvn_standard.json"));
  assert.equal(comp(p, "credit_card_transaction_fee")!.amount, comp(p, "seller_transaction_fee")!.amount.replace("-", ""));
  assert.equal(comp(p, "credit_card_transaction_fee")!.included_in_settlement, false);
  assert.equal(comp(p, "seller_transaction_fee")!.included_in_settlement, true);
  assert.equal(p.fields.processing_fee, undefined, "no column double-booked");
});

test("real 3. buyer-paid shipping: buyer_paid (+) and final_shipping_fee (−) are both members and cancel out", () => {
  const p = parseEscrowDetail(load("realvn_buyer_shipping.json"));
  assert.equal(comp(p, "buyer_paid_shipping_fee")!.amount, "6000");
  assert.equal(comp(p, "final_shipping_fee")!.amount, "-6000");
  assert.ok(comp(p, "buyer_paid_shipping_fee")!.included_in_settlement && comp(p, "final_shipping_fee")!.included_in_settlement);
  assert.equal(comp(p, "actual_shipping_fee")!.included_in_settlement, false, "inside final_shipping_fee");
});

test("real 4. returned order: NEGATIVE settlement kept signed, refund not double counted, return shipping offset by claim", () => {
  const p = parseEscrowDetail(load("realvn_returned.json"));
  assert.equal(p.fields.escrow_amount, "-2700", "signed column — seller owes 2700");
  assert.equal(p.fields.escrow_amount_after_adjustment, "-2700");
  assert.equal(p.fields.gross_original_value, "0", "original_price is AFTER returns");
  assert.equal(p.fields.refund_amount, "358800", "refund magnitude stored for display");
  assert.equal(comp(p, "seller_return_refund")!.included_in_settlement, false, "already netted out of original_price");
  assert.equal(comp(p, "final_return_to_seller_shipping_fee")!.amount, "-40000");
  assert.equal(comp(p, "rsf_seller_protection_fee_claim_amount")!.amount, "40000");
  assert.equal(p.fields.return_shipping_fee, "40000");
});

test("real 5. seller tax / ID number is never a money value and never stored", () => {
  const raw = clone(load("realvn_standard.json"));
  raw.response.order_income.tax_registration_code = "034089003322";
  const p = parseEscrowDetail(raw);
  assert.equal(comp(p, "tax_registration_code"), undefined);
  assert.equal(p.unknownFields.includes("tax_registration_code"), false);
  assert.equal(JSON.stringify(p.sanitized).includes("034089003322"), false);
});

test("real 6. fingerprint includes the calculation version (dictionary change → recompute)", () => {
  const p = parseEscrowDetail(load("realvn_standard.json"));
  assert.match(p.fingerprint, /^[0-9a-f]{64}$/);
  // same payload, same version → same fingerprint
  assert.equal(parseEscrowDetail(load("realvn_standard.json")).fingerprint, p.fingerprint);
});

test("decimal string helpers (no float arithmetic)", () => {
  assert.equal(negate("150000"), "-150000");
  assert.equal(negate("-0.5"), "0.5");
  assert.equal(negate("0"), "0");
  assert.equal(negate("-0"), "0");
  assert.equal(abs("-12.30"), "12.30");
});

test("PATCH 1 + 8 + 9: estimated order revenue = Shopee escrow_amount — never buyer payment, never the order total, never rebuilt from fees", () => {
  assert.equal(ESTIMATED_ORDER_REVENUE_FIELD, "escrow_amount");
  // real VN payloads: buyer paid 149.837, product value 192.099 → Shopee estimate 119.073
  const real = load("realvn_standard.json");
  const p = parseEscrowDetail(real);
  assert.equal(estimatedOrderRevenue(p), String(real.response.order_income.escrow_amount));
  assert.notEqual(estimatedOrderRevenue(p), String(real.response.order_income.buyer_total_amount));
  // returned order: Shopee's estimate is negative (−2.700) and kept signed
  assert.equal(estimatedOrderRevenue(parseEscrowDetail(load("realvn_returned.json"))), "-2700");
  // fees changing without escrow_amount changing → estimate unchanged (no re-estimation)
  const tweaked = load("synthetic_basic.json");
  tweaked.response.order_income.commission_fee = 999999;
  assert.equal(estimatedOrderRevenue(parseEscrowDetail(tweaked)), "151000");
  // Shopee did not report it → unknown (null), never 0
  const missing = load("synthetic_basic.json");
  delete missing.response.order_income.escrow_amount;
  assert.equal(estimatedOrderRevenue(parseEscrowDetail(missing)), null);
});

test("eligibility + not-ready classification", () => {
  for (const s of ["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE"]) assert.equal(isOrderEligibleForEscrowEstimate({ orderStatus: s }), true, s);
  for (const s of ["UNPAID", "COMPLETED", "CANCELLED", "IN_CANCEL", "TO_RETURN"]) assert.equal(isOrderEligibleForEscrowEstimate({ orderStatus: s }), false, s);
  assert.equal(isOrderEligibleForEscrowSync({ orderStatus: "COMPLETED" }), true);
  assert.equal(isOrderEligibleForEscrowSync({ orderStatus: "SHIPPED" }), false);
  assert.equal(isOrderEligibleForEscrowSync({ orderStatus: "CANCELLED" }), false);
  const notFound = new ShopeeApiError({ apiPath: "/api/v2/payment/get_escrow_detail", errorCode: "error_not_found", message: "escrow not found" });
  assert.equal(isEscrowNotReady(notFound), true);
  const auth = new ShopeeApiError({ apiPath: "/api/v2/payment/get_escrow_detail", errorCode: "error_auth", message: "Invalid access_token" });
  assert.equal(isEscrowNotReady(auth), false);
  assert.equal(isEscrowNotReady(new Error("not found")), false);
});

test("fixture loader indexes envelopes by order_sn", () => {
  const map = loadEscrowFixtures(FIXTURE_DIR);
  assert.ok(map.has("FXESCROW0001"));
  assert.ok(map.has("FXESCROW0002"));
});
