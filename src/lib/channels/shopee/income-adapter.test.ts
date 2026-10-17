// SHOPEE-7: income / payout adapter (pure) — node --test src/lib/channels/shopee/income-adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { negateDecimal, parseIncomeOverview, parsePayoutDetailPage, parseReleasedEscrowPage, parseWalletTransactionPage, walletKind, walletSignedAmount } from "./income-adapter.ts";
import { isCrossBorderOnlyError } from "./income-provider.ts";
import { ShopeeApiError } from "./errors.ts";
import { ShopeePayloadError } from "./product-adapter.ts";

const env = (response: unknown) => ({ error: "", message: "", request_id: "r", response });

test("SHOPEE-7 21: sign convention — signed amounts kept, unsigned decided by money_flow then type, never by description", () => {
  assert.equal(walletSignedAmount("-1500", "ADJUSTMENT_ADD", null), "-1500", "a provider sign is never flipped");
  assert.equal(walletSignedAmount("1500", "ADJUSTMENT_MINUS", null), "-1500");
  assert.equal(walletSignedAmount("1500", "SPM_DEDUCT", null), "-1500");
  assert.equal(walletSignedAmount("25000", "WITHDRAWAL_CREATED", null), "-25000");
  assert.equal(walletSignedAmount("2000", "ADJUSTMENT_ADD", null), "2000");
  assert.equal(walletSignedAmount("2000", "SOMETHING_NEW", "MONEY_OUT"), "-2000");
  assert.equal(walletSignedAmount("2000", "ADJUSTMENT_MINUS", "MONEY_IN"), "2000", "explicit flow wins over the type");
  assert.equal(negateDecimal("0"), "0");
  assert.equal(negateDecimal("-0.50"), "0.50");
  assert.equal(negateDecimal("12.345"), "-12.345");
});

test("SHOPEE-7: wallet kinds", () => {
  assert.equal(walletKind("ESCROW_VERIFIED_ADD"), "escrow_release");
  assert.equal(walletKind("FAST_ESCROW_DISBURSE"), "escrow_release");
  assert.equal(walletKind("WITHDRAWAL_CREATED"), "withdrawal");
  assert.equal(walletKind("withdrawal_completed"), "withdrawal_completed");
  assert.equal(walletKind("WITHDRAWAL_CANCELLED"), "withdrawal_cancelled");
  assert.equal(walletKind("ESCROW_VERIFIED_MINUS"), "adjustment");
  assert.equal(walletKind("PAID_ADS_CHARGE"), "adjustment");
});

test("SHOPEE-7 5: get_escrow_list — exact decimal strings, bad entries become issues, envelope errors throw", () => {
  const page = parseReleasedEscrowPage(
    env({ more: true, escrow_list: [{ order_sn: "A", payout_amount: 74694, escrow_release_time: 1792203600 }, { order_sn: "B", payout_amount: "12.30" }, { order_sn: "C", payout_amount: "x" }, { payout_amount: 1 }] }),
  );
  assert.deepEqual(page.entries, [
    { orderSn: "A", amount: "74694", releaseTime: "2026-10-17T02:20:00.000Z" },
    { orderSn: "B", amount: "12.30", releaseTime: null },
  ]);
  assert.equal(page.more, true);
  assert.equal(page.issues.length, 2);
  assert.throws(() => parseReleasedEscrowPage({ error: "error_auth", message: "no" }), ShopeePayloadError);
  // sandbox envelope
  assert.deepEqual(parseReleasedEscrowPage(env({ escrow_list: [], more: false })).entries, []);
});

test("SHOPEE-7 6: get_income_overview (sandbox shape)", () => {
  const o = parseIncomeOverview(env({ total_income: { pending_amount: 0, released_amount: 1234.5 } }));
  assert.deepEqual([o.pendingAmount, o.releasedAmount], ["0", "1234.5"]);
  assert.deepEqual([parseIncomeOverview(env({})).pendingAmount, parseIncomeOverview(env({})).releasedAmount], [null, null], "missing = unknown, not 0");
});

test("SHOPEE-7 8 + 11 + 38: get_payout_detail — stable derived ids, signed adjustments, duplicate order → issue", () => {
  const entry = {
    payout_info: { from_currency: "SGD", payout_currency: "VND", from_amount: 10, payout_amount: 180000, exchange_rate: 18000, payout_time: 1792203600, pay_service: "Payoneer", payee_id: 9 },
    escrow_list: [{ order_sn: "A", escrow_amount: 100000, currency: "VND" }, { order_sn: "B", escrow_amount: 81000, currency: "VND" }],
    offline_adjustment_list: [
      { adjustment_amount: -500, module: "fee", scenario: "fee_correction", remark: "r", adjustment_level: "order", order_sn: "A" },
      { adjustment_amount: -500, module: "fee", scenario: "fee_correction", remark: "r", adjustment_level: "order", order_sn: "A" },
    ],
  };
  const p1 = parsePayoutDetailPage(env({ payout_list: [entry], more: false }));
  const p2 = parsePayoutDetailPage(env({ payout_list: [entry], more: false }));
  assert.equal(p1.payouts.length, 1);
  const p = p1.payouts[0];
  assert.equal(p.providerPayoutId, p2.payouts[0].providerPayoutId, "same payout → same id on every sync");
  assert.deepEqual([p.payoutAmount, p.payoutCurrency, p.fromCurrency, p.exchangeRate, p.payeeId], ["180000", "VND", "SGD", "18000", "9"]);
  assert.deepEqual(p.adjustments.map((a) => a.amount), ["-500", "-500"]);
  assert.notEqual(p.adjustments[0].providerAdjustmentId, p.adjustments[1].providerAdjustmentId, "two identical adjustments are two rows");
  assert.equal(p.adjustments[0].providerAdjustmentId, p2.payouts[0].adjustments[0].providerAdjustmentId);

  const dup = parsePayoutDetailPage(env({ payout_list: [{ ...entry, escrow_list: [entry.escrow_list[0], entry.escrow_list[0]] }] }));
  assert.deepEqual([dup.payouts.length, dup.issues.length], [0, 1]);
  const noAmount = parsePayoutDetailPage(env({ payout_list: [{ payout_info: { payout_currency: "VND", payout_time: 1 } }] }));
  assert.deepEqual([noAmount.payouts.length, noAmount.issues.length], [0, 1]);
});

test("SHOPEE-7 39: wallet ledger — PII stripped, withdrawal ids, derived ids when transaction_id is missing", () => {
  const page = parseWalletTransactionPage(
    env({
      more: false,
      transaction_list: [
        { transaction_id: 11, status: "COMPLETED", transaction_type: "ESCROW_VERIFIED_ADD", amount: 100000, current_balance: 105000, create_time: 1792203600, order_sn: "A", buyer_name: "Nguyen Van A" },
        { status: "PENDING", transaction_type: "WITHDRAWAL_CREATED", amount: 105000, current_balance: 0, create_time: 1792207200, withdrawal_id: 0, root_withdrawal_id: 77 },
        { transaction_type: "ADJUSTMENT_ADD", amount: "oops", create_time: 1 },
      ],
    }),
    "VND",
  );
  assert.equal(page.rows.length, 2);
  assert.equal(page.issues.length, 1);
  const [rel, wd] = page.rows;
  assert.deepEqual([rel.providerTransactionId, rel.kind, rel.amount, rel.currentBalance, rel.orderSn, rel.currency], ["11", "escrow_release", "100000", "105000", "A", "VND"]);
  assert.equal(rel.payload.buyer_name, undefined);
  assert.deepEqual([wd.kind, wd.amount, wd.withdrawalId, wd.providerStatus], ["withdrawal", "-105000", "77", "PENDING"]);
  assert.match(wd.providerTransactionId, /^wt_[0-9a-f]{24}$/);
});

test("SHOPEE-7: local shop detection from the provider's own error", () => {
  assert.equal(isCrossBorderOnlyError(new ShopeeApiError({ apiPath: "/x", errorCode: "error_param", message: "This payment API is only applicable for cross boarder shop" })), true);
  assert.equal(isCrossBorderOnlyError(new ShopeeApiError({ apiPath: "/x", errorCode: "error_param", message: "page_size invalid" })), false);
  assert.equal(isCrossBorderOnlyError(new Error("cross border")), false, "only a provider answer counts");
});
