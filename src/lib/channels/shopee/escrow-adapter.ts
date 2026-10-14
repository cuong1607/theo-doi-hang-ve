// ============================================================
// PHASE SHOPEE-5: get_escrow_detail payload → canonical financial input.
//
// The only code that reads an escrow payload. Meaning of every field comes
// from financial-dictionary.ts; this file only applies it:
//   order_income.<field>   → order_financials column (magnitude / signed) +
//                            one signed component (non-zero values only —
//                            zero is carried by the column as a confirmed 0)
//   order_adjustment[]     → one component per row (deterministic key)
//   unknown numeric field  → component category "other", unverified, kept
//   ignored patterns       → explicitly skipped (see dictionary)
// Amounts stay decimal STRINGS end to end — arithmetic happens in Postgres.
// ============================================================
import { createHash } from "node:crypto";

import { toDecimalString } from "../core/decimal.ts";
import type { Decimal } from "../core/types.ts";
import type { FinancialComponentCategory, FundedBy } from "../../financial/types.ts";
import {
  ADJUSTMENT_ROW,
  ESCROW_FIELDS,
  IGNORED_FIELD_PATTERNS,
  SIGNED_COLUMNS,
  type EscrowColumn,
  type EscrowFieldDefinition,
  type SellerImpact,
} from "./financial-dictionary.ts";
import { ShopeePayloadError } from "./product-adapter.ts";

const API = "v2.payment.get_escrow_detail";

export interface EscrowComponentInput {
  component_key: string;
  component_type: string;
  provider_field: string;
  category: FinancialComponentCategory;
  /** Signed by seller impact (+ to seller, − away from seller); info rows keep the provider value. */
  amount: Decimal;
  currency: string | null;
  funded_by: FundedBy;
  included_in_settlement: boolean;
  metadata: Record<string, unknown>;
}

export interface ParsedEscrow {
  orderSn: string;
  /** order_financials columns; absent key = unknown (NULL). */
  fields: Partial<Record<EscrowColumn, Decimal>>;
  components: EscrowComponentInput[];
  /** order_income fields not in the dictionary (stored as unverified components). */
  unknownFields: string[];
  /** Hash of the financially meaningful payload — unchanged → no rewrite. */
  fingerprint: string;
  /** Payload with buyer identity removed — what the raw snapshot stores. */
  sanitized: unknown;
}

const PII_KEYS = new Set(["buyer_user_name"]);

export function negate(d: Decimal): Decimal {
  if (/^-?0+(\.0+)?$/.test(d)) return d.replace(/^-/, "");
  return d.startsWith("-") ? d.slice(1) : `-${d}`;
}

export function abs(d: Decimal): Decimal {
  return d.startsWith("-") ? d.slice(1) : d;
}

const isZero = (d: Decimal) => /^-?0+(\.0+)?$/.test(d);

function signedFor(impact: SellerImpact, value: Decimal): Decimal {
  switch (impact) {
    case "inflow":
      return abs(value);
    case "outflow":
      return isZero(value) ? "0" : negate(abs(value));
    case "signed":
    case "info":
      return value;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha = (v: unknown) => createHash("sha256").update(stableStringify(v)).digest("hex");

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !PII_KEYS.has(k)).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

const UNKNOWN_FIELD: Omit<EscrowFieldDefinition, "type"> = {
  category: "other",
  impact: "info",
  fundedBy: "unknown",
  settlement: false,
  verified: false,
  notes: "Not in the dictionary yet — stored, never summed.",
};

/** Parses one get_escrow_detail envelope. Throws ShopeePayloadError when the shape is unusable. */
export function parseEscrowDetail(raw: unknown, options: { currency?: string | null; expectedOrderSn?: string } = {}): ParsedEscrow {
  if (!raw || typeof raw !== "object") throw new ShopeePayloadError(API, "payload không phải object");
  const env = raw as { error?: unknown; message?: unknown; response?: unknown };
  if (typeof env.error === "string" && env.error) throw new ShopeePayloadError(API, `error=${env.error} ${typeof env.message === "string" ? env.message : ""}`.trim());
  const response = env.response as Record<string, unknown> | undefined;
  if (!response || typeof response !== "object") throw new ShopeePayloadError(API, "thiếu response");
  const orderSn = response.order_sn == null ? "" : String(response.order_sn);
  if (!orderSn) throw new ShopeePayloadError(API, "thiếu order_sn");
  if (options.expectedOrderSn && orderSn !== options.expectedOrderSn) throw new ShopeePayloadError(API, `order_sn ${orderSn} ≠ ${options.expectedOrderSn}`);
  const income = response.order_income as Record<string, unknown> | undefined;
  if (!income || typeof income !== "object") throw new ShopeePayloadError(API, "thiếu order_income");

  const currency = options.currency ?? null;
  const fields: Partial<Record<EscrowColumn, Decimal>> = {};
  const components: EscrowComponentInput[] = [];
  const unknownFields: string[] = [];

  for (const [key, value] of Object.entries(income)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue; // arrays/objects: order_adjustment handled below; items etc. are breakdowns
    if (IGNORED_FIELD_PATTERNS.some((p) => p.test(key))) continue;
    const decimal = toDecimalString(value);
    if (decimal === null) continue; // non-numeric scalar (ids, flags) — not money
    const known = ESCROW_FIELDS[key];
    if (!known) unknownFields.push(key);
    const def: EscrowFieldDefinition = known ?? { ...UNKNOWN_FIELD, type: key };
    if (def.column) fields[def.column] = SIGNED_COLUMNS.has(def.column) ? decimal : abs(decimal);
    if (isZero(decimal)) continue;
    components.push({
      component_key: key,
      component_type: def.type,
      provider_field: key,
      category: def.category,
      amount: signedFor(def.impact, decimal),
      currency,
      funded_by: def.fundedBy,
      included_in_settlement: def.settlement && def.verified,
      // unverified = would belong to the formula but its meaning is not confirmed yet, or unknown field
      metadata: { impact: def.impact, settlement_member: def.settlement, verified: def.verified, unverified: !known || (def.settlement && !def.verified), unknown: !known, provider_value: decimal },
    });
  }

  const adjustments = Array.isArray(income.order_adjustment) ? (income.order_adjustment as Array<Record<string, unknown>>) : [];
  adjustments.forEach((row, index) => {
    const amount = toDecimalString(row?.amount);
    if (amount === null) return;
    components.push({
      component_key: `order_adjustment#${index}:${sha(row).slice(0, 12)}`,
      component_type: ADJUSTMENT_ROW.type,
      provider_field: "order_adjustment",
      category: ADJUSTMENT_ROW.category,
      amount,
      currency: typeof row.currency === "string" ? row.currency : currency,
      funded_by: ADJUSTMENT_ROW.fundedBy,
      included_in_settlement: ADJUSTMENT_ROW.settlement && ADJUSTMENT_ROW.verified,
      metadata: {
        impact: ADJUSTMENT_ROW.impact,
        settlement_member: ADJUSTMENT_ROW.settlement,
        verified: ADJUSTMENT_ROW.verified,
        unverified: !ADJUSTMENT_ROW.verified,
        reason: row.adjustment_reason ?? null,
        date: row.date ?? null,
        provider_value: amount,
      },
    });
  });

  const sanitized = sanitize(raw);
  return {
    orderSn,
    fields,
    components,
    unknownFields,
    fingerprint: sha({ order_income: (sanitized as { response: Record<string, unknown> }).response.order_income }),
    sanitized,
  };
}
