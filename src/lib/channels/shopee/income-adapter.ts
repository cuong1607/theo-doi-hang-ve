// ============================================================
// PHASE SHOPEE-7: Shopee income / payout payloads → canonical rows.
//
// The ONLY place that knows Shopee field names of get_escrow_list,
// get_income_overview, get_payout_detail and get_wallet_transaction_list,
// and the ONLY place that decides signs (walletSignedAmount): downstream
// SQL sums amounts as given (+ money in, − money out).
//
// Tolerant (zod passthrough): unknown fields are ignored, an entry without a
// valid identity / amount becomes a ParseIssue, never a guess. Money stays a
// decimal string (toDecimalString) — no arithmetic here except negation of a
// decimal string, which is textual.
// Confirmed on the sandbox (17/10/2026): get_escrow_list envelope
// { escrow_list, more }, get_income_overview { total_income: { pending_amount,
// released_amount } }, get_wallet_transaction_list { transaction_list, more }.
// Entry fields follow the documented v2 schema (real entries pending).
// Pure: no I/O.
// ============================================================
import { createHash } from "node:crypto";
import { z } from "zod";

import { toDecimalString } from "../core/decimal.ts";
import { ShopeePayloadError, type ParseIssue } from "./product-adapter.ts";

export const INCOME_API = {
  escrowList: "v2.payment.get_escrow_list",
  overview: "v2.payment.get_income_overview",
  payoutDetail: "v2.payment.get_payout_detail",
  wallet: "v2.payment.get_wallet_transaction_list",
} as const;

const id = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const num = z.union([z.number(), z.string()]).nullish();
const envelope = z.object({ error: z.string().nullish(), message: z.string().nullish(), response: z.unknown().optional() }).passthrough();

function describe(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function unwrap(apiName: string, raw: unknown): unknown {
  const env = envelope.safeParse(raw);
  if (!env.success) throw new ShopeePayloadError(apiName, describe(env.error));
  if (env.data.error) throw new ShopeePayloadError(apiName, `error=${env.data.error} ${env.data.message ?? ""}`.trim());
  return env.data.response ?? {};
}

const unixToIso = (s: number | string | null | undefined) => {
  const n = typeof s === "string" ? Number(s) : s;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};
const clean = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
const upper = (v: string | null | undefined) => clean(v)?.toUpperCase() ?? null;

/** Textual negation of a decimal string ("120.5" → "-120.5", "-3" → "3", "0" → "0"). */
export function negateDecimal(d: string): string {
  if (/^-?0+(\.0+)?$/.test(d)) return d.replace(/^-/, "");
  return d.startsWith("-") ? d.slice(1) : `-${d}`;
}
const absDecimal = (d: string) => d.replace(/^-/, "");
const isNegative = (d: string) => d.startsWith("-") && !/^-0+(\.0+)?$/.test(d);

// ------------------------------------------------------------ escrow list

export interface ReleasedEscrowEntry {
  orderSn: string;
  amount: string;
  releaseTime: string | null;
}

const escrowEntry = z.object({ order_sn: z.string(), payout_amount: num, escrow_release_time: z.union([z.number(), z.string()]).nullish() }).passthrough();

export function parseReleasedEscrowPage(raw: unknown): { entries: ReleasedEscrowEntry[]; more: boolean; issues: ParseIssue[] } {
  const res = z.object({ escrow_list: z.array(z.unknown()).nullish(), more: z.boolean().nullish() }).passthrough().safeParse(unwrap(INCOME_API.escrowList, raw));
  if (!res.success) throw new ShopeePayloadError(INCOME_API.escrowList, describe(res.error));
  const entries: ReleasedEscrowEntry[] = [];
  const issues: ParseIssue[] = [];
  for (const e of res.data.escrow_list ?? []) {
    const p = escrowEntry.safeParse(e);
    const amount = p.success ? toDecimalString(p.data.payout_amount ?? null) : null;
    if (!p.success || !clean(p.data.order_sn) || amount === null) {
      issues.push({ apiName: INCOME_API.escrowList, externalId: p.success ? p.data.order_sn : null, reason: p.success ? "payout_amount không hợp lệ" : describe(p.error) });
      continue;
    }
    entries.push({ orderSn: p.data.order_sn.trim(), amount, releaseTime: unixToIso(p.data.escrow_release_time) });
  }
  return { entries, more: res.data.more === true, issues };
}

// --------------------------------------------------------------- overview

export interface IncomeOverview {
  pendingAmount: string | null;
  releasedAmount: string | null;
  payload: unknown;
}

export function parseIncomeOverview(raw: unknown): IncomeOverview {
  const response = unwrap(INCOME_API.overview, raw);
  const res = z
    .object({ total_income: z.object({ pending_amount: num, released_amount: num }).passthrough().nullish() })
    .passthrough()
    .safeParse(response);
  if (!res.success) throw new ShopeePayloadError(INCOME_API.overview, describe(res.error));
  return {
    pendingAmount: toDecimalString(res.data.total_income?.pending_amount ?? null),
    releasedAmount: toDecimalString(res.data.total_income?.released_amount ?? null),
    payload: response,
  };
}

// ---------------------------------------------------------- payout detail

export interface MappedPayoutBatch {
  providerPayoutId: string;
  payoutAmount: string;
  payoutCurrency: string;
  fromAmount: string | null;
  fromCurrency: string | null;
  exchangeRate: string | null;
  payoutTime: string | null;
  payService: string | null;
  payeeId: string | null;
  orders: Array<{ orderSn: string; amount: string; currency: string }>;
  adjustments: Array<{
    providerAdjustmentId: string;
    adjustmentType: string;
    description: string | null;
    amount: string;
    currency: string;
    orderSn: string | null;
    module: string | null;
    scenario: string | null;
    remark: string | null;
    adjustmentLevel: string | null;
    raw: unknown;
  }>;
}

const payoutEntry = z
  .object({
    payout_info: z
      .object({
        from_currency: z.string().nullish(),
        payout_currency: z.string().nullish(),
        from_amount: num,
        payout_amount: num,
        exchange_rate: num,
        payout_time: z.union([z.number(), z.string()]).nullish(),
        pay_service: z.string().nullish(),
        payee_id: z.union([z.string(), z.number()]).nullish(),
        payout_id: id.nullish(),
      })
      .passthrough(),
    escrow_list: z.array(z.object({ escrow_amount: num, currency: z.string().nullish(), order_sn: z.string() }).passthrough()).nullish(),
    offline_adjustment_list: z
      .array(
        z
          .object({
            adjustment_amount: num,
            module: z.string().nullish(),
            remark: z.string().nullish(),
            scenario: z.string().nullish(),
            adjustment_level: z.string().nullish(),
            order_sn: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/**
 * get_payout_detail has no payout id → a stable one from the payout's own
 * identity (time + amount + currency + payee). Adjustments have none either →
 * hash of their fields + occurrence index among identical ones.
 */
export function parsePayoutDetailPage(raw: unknown): { payouts: MappedPayoutBatch[]; more: boolean; issues: ParseIssue[] } {
  const res = z.object({ payout_list: z.array(z.unknown()).nullish(), more: z.boolean().nullish() }).passthrough().safeParse(unwrap(INCOME_API.payoutDetail, raw));
  if (!res.success) throw new ShopeePayloadError(INCOME_API.payoutDetail, describe(res.error));
  const payouts: MappedPayoutBatch[] = [];
  const issues: ParseIssue[] = [];
  for (const e of res.data.payout_list ?? []) {
    const p = payoutEntry.safeParse(e);
    if (!p.success) {
      issues.push({ apiName: INCOME_API.payoutDetail, externalId: null, reason: describe(p.error) });
      continue;
    }
    const info = p.data.payout_info;
    const amount = toDecimalString(info.payout_amount ?? null);
    const currency = upper(info.payout_currency);
    const time = unixToIso(info.payout_time);
    if (amount === null || !currency || !time) {
      issues.push({ apiName: INCOME_API.payoutDetail, externalId: null, reason: "payout_info thiếu payout_amount / payout_currency / payout_time" });
      continue;
    }
    const payeeId = info.payee_id == null ? null : String(info.payee_id);
    const providerPayoutId = info.payout_id ?? `pd_${sha(`${time}|${amount}|${currency}|${payeeId ?? ""}`)}`;

    const orders = new Map<string, { orderSn: string; amount: string; currency: string }>();
    let bad = false;
    for (const o of p.data.escrow_list ?? []) {
      const a = toDecimalString(o.escrow_amount ?? null);
      if (a === null || !clean(o.order_sn)) {
        bad = true;
        break;
      }
      const sn = o.order_sn.trim();
      if (orders.has(sn)) {
        // one order twice in one payout cannot be represented as one row without arithmetic → issue
        bad = true;
        break;
      }
      orders.set(sn, { orderSn: sn, amount: a, currency: upper(o.currency) ?? currency });
    }
    if (bad) {
      issues.push({ apiName: INCOME_API.payoutDetail, externalId: providerPayoutId, reason: "escrow_list có dòng không hợp lệ / trùng order_sn" });
      continue;
    }

    const seen = new Map<string, number>();
    const adjustments: MappedPayoutBatch["adjustments"] = [];
    for (const a of p.data.offline_adjustment_list ?? []) {
      const amt = toDecimalString(a.adjustment_amount ?? null);
      if (amt === null) {
        bad = true;
        break;
      }
      const base = [a.module, a.scenario, a.remark, a.adjustment_level, a.order_sn, amt].map((v) => v ?? "").join("|");
      const k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      adjustments.push({
        providerAdjustmentId: `adj_${sha(`${base}#${k}`)}`,
        // offline adjustments are already signed by Shopee (+ credit, − deduction)
        adjustmentType: clean(a.scenario)?.toLowerCase() ?? clean(a.module)?.toLowerCase() ?? "other",
        description: clean(a.remark),
        amount: amt,
        currency,
        orderSn: clean(a.order_sn),
        module: clean(a.module),
        scenario: clean(a.scenario),
        remark: clean(a.remark),
        adjustmentLevel: clean(a.adjustment_level),
        raw: a,
      });
    }
    if (bad) {
      issues.push({ apiName: INCOME_API.payoutDetail, externalId: providerPayoutId, reason: "offline_adjustment_list có số tiền không hợp lệ" });
      continue;
    }
    payouts.push({
      providerPayoutId,
      payoutAmount: amount,
      payoutCurrency: currency,
      fromAmount: toDecimalString(info.from_amount ?? null),
      fromCurrency: upper(info.from_currency),
      exchangeRate: toDecimalString(info.exchange_rate ?? null),
      payoutTime: time,
      payService: clean(info.pay_service),
      payeeId,
      orders: [...orders.values()],
      adjustments,
    });
  }
  return { payouts, more: res.data.more === true, issues };
}

// ------------------------------------------------------------ wallet ledger

export type WalletKind = "escrow_release" | "withdrawal" | "withdrawal_completed" | "withdrawal_cancelled" | "adjustment";

/** Type → kind. Unknown types are adjustments (shown with their raw type). */
export function walletKind(transactionType: string): WalletKind {
  const t = transactionType.toUpperCase();
  if (t === "WITHDRAWAL_CREATED") return "withdrawal";
  if (t === "WITHDRAWAL_COMPLETED") return "withdrawal_completed";
  if (t === "WITHDRAWAL_CANCELLED") return "withdrawal_cancelled";
  if (t === "ESCROW_VERIFIED_ADD" || t.startsWith("FAST_ESCROW_DISBURSE")) return "escrow_release";
  return "adjustment";
}

const MONEY_OUT_TYPE = /(_MINUS|_DEDUCT|_CHARGE|_DEBIT|WITHDRAWAL_CREATED)$/;

/**
 * SIGN CONVENTION (the only place): + money into the wallet, − money out.
 * Shopee normally sends signed amounts; when an amount comes unsigned, the
 * explicit money_flow field decides, then the transaction type's documented
 * direction (…_MINUS / _DEDUCT / _CHARGE, WITHDRAWAL_CREATED). Never the
 * description text.
 */
export function walletSignedAmount(amount: string, transactionType: string, moneyFlow: string | null): string {
  if (isNegative(amount)) return amount;
  const flow = moneyFlow?.toUpperCase() ?? "";
  if (/OUT|MINUS|DEBIT/.test(flow)) return negateDecimal(absDecimal(amount));
  if (/IN|ADD|CREDIT/.test(flow)) return absDecimal(amount);
  return MONEY_OUT_TYPE.test(transactionType.toUpperCase()) ? negateDecimal(amount) : amount;
}

export interface MappedWalletTransaction {
  providerTransactionId: string;
  transactionType: string;
  kind: WalletKind;
  amount: string;
  currentBalance: string | null;
  currency: string;
  occurredAt: string;
  orderSn: string | null;
  withdrawalId: string | null;
  providerStatus: string | null;
  description: string | null;
  /** sanitized (buyer name removed) */
  payload: Record<string, unknown>;
}

const walletEntry = z
  .object({
    transaction_id: id.nullish(),
    status: z.string().nullish(),
    transaction_type: z.string(),
    amount: num,
    current_balance: num,
    create_time: z.union([z.number(), z.string()]),
    order_sn: z.string().nullish(),
    withdrawal_id: id.nullish(),
    root_withdrawal_id: id.nullish(),
    description: z.string().nullish(),
    reason: z.string().nullish(),
    money_flow: z.string().nullish(),
    currency: z.string().nullish(),
  })
  .passthrough();

const WALLET_PII_KEYS = new Set(["buyer_name", "buyer_username", "buyer_user_name", "pay_order_list"]);

export function parseWalletTransactionPage(raw: unknown, shopCurrency: string): { rows: MappedWalletTransaction[]; more: boolean; issues: ParseIssue[] } {
  const res = z.object({ transaction_list: z.array(z.unknown()).nullish(), more: z.boolean().nullish() }).passthrough().safeParse(unwrap(INCOME_API.wallet, raw));
  if (!res.success) throw new ShopeePayloadError(INCOME_API.wallet, describe(res.error));
  const rows: MappedWalletTransaction[] = [];
  const issues: ParseIssue[] = [];
  for (const e of res.data.transaction_list ?? []) {
    const p = walletEntry.safeParse(e);
    const amount = p.success ? toDecimalString(p.data.amount ?? null) : null;
    const at = p.success ? unixToIso(p.data.create_time) : null;
    if (!p.success || amount === null || !at || !clean(p.data.transaction_type)) {
      issues.push({ apiName: INCOME_API.wallet, externalId: p.success ? (p.data.transaction_id ?? null) : null, reason: p.success ? "amount / create_time không hợp lệ" : describe(p.error) });
      continue;
    }
    const d = p.data;
    const type = d.transaction_type.trim().toUpperCase();
    const signed = walletSignedAmount(amount, type, clean(d.money_flow));
    const withdrawalId = d.withdrawal_id && d.withdrawal_id !== "0" ? d.withdrawal_id : d.root_withdrawal_id && d.root_withdrawal_id !== "0" ? d.root_withdrawal_id : null;
    const orderSn = clean(d.order_sn);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) if (!WALLET_PII_KEYS.has(k)) payload[k] = v;
    rows.push({
      providerTransactionId: d.transaction_id ?? `wt_${sha(`${type}|${at}|${amount}|${orderSn ?? ""}|${withdrawalId ?? ""}|${d.current_balance ?? ""}`)}`,
      transactionType: type,
      kind: walletKind(type),
      amount: signed,
      currentBalance: toDecimalString(d.current_balance ?? null),
      currency: upper(d.currency) ?? shopCurrency,
      occurredAt: at,
      orderSn,
      withdrawalId,
      providerStatus: upper(d.status),
      description: clean(d.description) ?? clean(d.reason),
      payload,
    });
  }
  return { rows, more: res.data.more === true, issues };
}

// ------------------------------------------------------ RPC argument shapes

export const toReleaseRpcEntries = (entries: ReleasedEscrowEntry[], currency: string, apiName: string) =>
  entries.map((e) => ({ order_sn: e.orderSn, amount: e.amount, currency, release_time: e.releaseTime, payment_method: null, api_name: apiName }));

export const toWalletRpcRows = (rows: MappedWalletTransaction[]) =>
  rows.map((r) => ({
    provider_transaction_id: r.providerTransactionId,
    transaction_type: r.transactionType,
    kind: r.kind,
    amount: r.amount,
    current_balance: r.currentBalance,
    currency: r.currency,
    occurred_at: r.occurredAt,
    order_sn: r.orderSn,
    withdrawal_id: r.withdrawalId,
    provider_status: r.providerStatus,
    description: r.description,
    payload: r.payload,
  }));

export function toApplyPayoutArgs(p: MappedPayoutBatch) {
  return {
    p_payout: {
      provider_payout_id: p.providerPayoutId,
      payout_amount: p.payoutAmount,
      payout_currency: p.payoutCurrency,
      from_amount: p.fromAmount,
      from_currency: p.fromCurrency,
      exchange_rate: p.exchangeRate,
      payout_time: p.payoutTime,
      pay_service: p.payService,
      payee_id: p.payeeId,
      payment_method: p.payService,
      payout_status: "completed",
    },
    p_orders: p.orders.map((o) => ({ order_sn: o.orderSn, amount: o.amount, currency: o.currency, occurred_at: p.payoutTime })),
    p_adjustments: p.adjustments.map((a) => ({
      provider_adjustment_id: a.providerAdjustmentId,
      adjustment_type: a.adjustmentType,
      description: a.description,
      amount: a.amount,
      currency: a.currency,
      order_sn: a.orderSn,
      module: a.module,
      scenario: a.scenario,
      remark: a.remark,
      adjustment_level: a.adjustmentLevel,
      occurred_at: p.payoutTime,
      raw: a.raw,
    })),
  };
}
