// ============================================================
// PHASE SHOPEE-6: Shopee return payloads → canonical return records.
//
// The ONLY place that knows Shopee return field names
// (v2.returns.get_return_list / get_return_detail). Tolerant: unknown fields
// are ignored, missing optional fields become null (unknown), never a guess.
// A return whose identity (return_sn, order_sn) or any item identity
// (item_id, positive amount) is invalid is NOT returned — storing it with a
// missing item would make the inventory side wrong; it becomes an issue.
//
// Field names follow the documented v2 schema; sandbox confirmed the list
// envelope { response: { return: [], more } }. Detail fields still to be
// confirmed on a real return (docs/shopee-returns.md checklist).
// Pure: no I/O.
// ============================================================
import { createHash } from "node:crypto";
import { z } from "zod";

import { toDecimalString } from "../core/decimal.ts";
import { ShopeePayloadError, type ParseIssue } from "./product-adapter.ts";
import { returnStatusInfo } from "./return-status.ts";

const API = { list: "v2.returns.get_return_list", detail: "v2.returns.get_return_detail" } as const;

const id = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const num = z.union([z.number(), z.string()]).nullish();

const envelope = z
  .object({
    error: z.string().nullish(),
    message: z.string().nullish(),
    response: z.unknown().optional(),
  })
  .passthrough();

const listResponse = z.object({ more: z.boolean().nullish(), return: z.array(z.unknown()).nullish() }).passthrough();

const listEntry = z
  .object({
    return_sn: id,
    order_sn: z.string(),
    status: z.string().nullish(),
    update_time: z.number().nullish(),
  })
  .passthrough();

const returnItem = z
  .object({
    item_id: id,
    model_id: id.nullish(),
    name: z.string().nullish(),
    item_sku: z.string().nullish(),
    variation_sku: z.string().nullish(),
    amount: z.union([z.number(), z.string()]),
    refund_amount: num,
  })
  .passthrough();

const returnDetail = z
  .object({
    return_sn: id,
    order_sn: z.string(),
    status: z.string().nullish(),
    reason: z.string().nullish(),
    text_reason: z.string().nullish(),
    refund_amount: num,
    currency: z.string().nullish(),
    needs_logistics: z.boolean().nullish(),
    tracking_number: z.string().nullish(),
    reverse_logistic_status: z.string().nullish(),
    return_refund_type: z.string().nullish(),
    create_time: z.number().nullish(),
    update_time: z.number().nullish(),
    item: z.array(z.unknown()).nullish(),
    seller_compensation: z
      .object({ seller_compensation_status: z.string().nullish(), compensation_amount: num })
      .passthrough()
      .nullish(),
    negotiation: z.object({ negotiation_status: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

function describe(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

const unixToIso = (s: number | null | undefined) => (typeof s === "number" && Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null);
const clean = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** Shopee uses model_id 0 for "no variation" — stored as null (same as order lines). */
const modelId = (v: string | null | undefined) => (v && v !== "0" ? v : null);

export interface ReturnListEntry {
  returnSn: string;
  orderSn: string;
  status: string | null;
  updatedAt: string | null;
}

export interface ReturnListPage {
  entries: ReturnListEntry[];
  more: boolean;
  issues: ParseIssue[];
}

export function parseReturnListPage(raw: unknown): ReturnListPage {
  const env = envelope.safeParse(raw);
  if (!env.success) throw new ShopeePayloadError(API.list, describe(env.error));
  if (env.data.error) throw new ShopeePayloadError(API.list, `error=${env.data.error} ${env.data.message ?? ""}`.trim());
  const res = listResponse.safeParse(env.data.response ?? {});
  if (!res.success) throw new ShopeePayloadError(API.list, describe(res.error));
  const entries: ReturnListEntry[] = [];
  const issues: ParseIssue[] = [];
  for (const e of res.data.return ?? []) {
    const p = listEntry.safeParse(e);
    if (!p.success) {
      issues.push({ apiName: API.list, externalId: null, reason: describe(p.error) });
      continue;
    }
    entries.push({ returnSn: p.data.return_sn, orderSn: p.data.order_sn.trim(), status: clean(p.data.status), updatedAt: unixToIso(p.data.update_time) });
  }
  return { entries, more: res.data.more === true, issues };
}

export interface MappedReturnItemRow {
  externalItemId: string;
  externalModelId: string | null;
  itemSku: string | null;
  variationSku: string | null;
  itemName: string | null;
  quantity: string;
  refundAmount: string | null;
}

export interface MappedReturnDetail {
  externalReturnSn: string;
  externalOrderSn: string;
  status: string | null;
  reason: string | null;
  textReason: string | null;
  refundAmount: string | null;
  currency: string | null;
  needsLogistics: boolean | null;
  trackingNumber: string | null;
  reverseLogisticsStatus: string | null;
  sellerCompensationStatus: string | null;
  sellerCompensationAmount: string | null;
  negotiationStatus: string | null;
  returnRefundType: string | null;
  createdAtChannel: string | null;
  updatedAtChannel: string | null;
  isTerminal: boolean;
  completedAt: string | null;
  items: MappedReturnItemRow[];
}

/** get_return_detail → one return, or an issue (never a partial return). */
export function parseReturnDetail(raw: unknown): { detail: MappedReturnDetail; sanitized: unknown } | { issue: ParseIssue } {
  const env = envelope.safeParse(raw);
  if (!env.success) throw new ShopeePayloadError(API.detail, describe(env.error));
  if (env.data.error) throw new ShopeePayloadError(API.detail, `error=${env.data.error} ${env.data.message ?? ""}`.trim());
  const p = returnDetail.safeParse(env.data.response ?? {});
  if (!p.success) return { issue: { apiName: API.detail, externalId: null, reason: describe(p.error) } };
  const d = p.data;
  const items: MappedReturnItemRow[] = [];
  for (const raw of d.item ?? []) {
    const it = returnItem.safeParse(raw);
    const qty = it.success ? toDecimalString(it.data.amount) : null;
    if (!it.success || !qty || Number(qty) <= 0) {
      return { issue: { apiName: API.detail, externalId: d.return_sn, reason: `item không hợp lệ: ${it.success ? "amount ≤ 0" : describe(it.error)}` } };
    }
    items.push({
      externalItemId: it.data.item_id,
      externalModelId: modelId(it.data.model_id ?? null),
      itemSku: clean(it.data.item_sku),
      variationSku: clean(it.data.variation_sku),
      itemName: clean(it.data.name),
      quantity: qty,
      refundAmount: toDecimalString(it.data.refund_amount ?? null),
    });
  }
  const info = returnStatusInfo(d.status);
  const updatedAt = unixToIso(d.update_time);
  const detail: MappedReturnDetail = {
    externalReturnSn: d.return_sn,
    externalOrderSn: d.order_sn.trim(),
    status: clean(d.status)?.toUpperCase() ?? null,
    reason: clean(d.reason),
    textReason: clean(d.text_reason),
    refundAmount: toDecimalString(d.refund_amount ?? null),
    currency: clean(d.currency)?.toUpperCase() ?? null,
    needsLogistics: d.needs_logistics ?? null,
    trackingNumber: clean(d.tracking_number),
    reverseLogisticsStatus: clean(d.reverse_logistic_status),
    sellerCompensationStatus: clean(d.seller_compensation?.seller_compensation_status),
    sellerCompensationAmount: toDecimalString(d.seller_compensation?.compensation_amount ?? null),
    negotiationStatus: clean(d.negotiation?.negotiation_status),
    returnRefundType: clean(d.return_refund_type),
    createdAtChannel: unixToIso(d.create_time),
    updatedAtChannel: updatedAt,
    isTerminal: info.terminal,
    completedAt: info.completed ? updatedAt : null,
    items,
  };
  return { detail, sanitized: sanitizeReturnPayload(env.data.response) };
}

/** Buyer identity / contact / addresses / media never leave the adapter (snapshots included). */
const PII_KEYS = new Set(["user", "buyer_videos", "image", "images", "return_pickup_address", "return_address", "virtual_contact_number", "activity"]);
export function sanitizeReturnPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeReturnPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !PII_KEYS.has(k)).map(([k, v]) => [k, sanitizeReturnPayload(v)]));
  }
  return value;
}

/** What makes a return snapshot "meaningfully different" (status / time / items). */
export function returnFingerprint(d: MappedReturnDetail): string {
  const items = d.items.map((i) => `${i.externalItemId}:${i.externalModelId ?? "-"}:${i.quantity}`).sort().join(",");
  return createHash("sha256").update(`${d.status}|${d.updatedAtChannel}|${d.refundAmount}|${d.sellerCompensationAmount}|${items}`).digest("hex").slice(0, 32);
}

/** Row shape for apply_channel_return (00057). */
export function toApplyReturnArgs(d: MappedReturnDetail) {
  return {
    p_return: {
      external_return_sn: d.externalReturnSn,
      status: d.status,
      reason: d.reason,
      text_reason: d.textReason,
      refund_amount: d.refundAmount,
      currency: d.currency,
      needs_logistics: d.needsLogistics,
      tracking_number: d.trackingNumber,
      reverse_logistics_status: d.reverseLogisticsStatus,
      seller_compensation_status: d.sellerCompensationStatus,
      seller_compensation_amount: d.sellerCompensationAmount,
      negotiation_status: d.negotiationStatus,
      return_refund_type: d.returnRefundType,
      created_at_channel: d.createdAtChannel,
      updated_at_channel: d.updatedAtChannel,
      is_terminal: d.isTerminal,
      completed_at: d.completedAt,
    },
    p_items: d.items.map((i) => ({
      external_item_id: i.externalItemId,
      external_model_id: i.externalModelId,
      item_sku: i.itemSku,
      variation_sku: i.variationSku,
      item_name: i.itemName,
      quantity: i.quantity,
      refund_amount: i.refundAmount,
    })),
  };
}
