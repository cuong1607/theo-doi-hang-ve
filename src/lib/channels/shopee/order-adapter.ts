// ============================================================
// PHASE SHOPEE-3: Shopee order payloads → canonical MappedOrder.
//
// The ONLY place that knows Shopee order field names. Real Go-Live payloads
// differing from the documented examples are fixed here (and in
// ./dto/order.ts) — never in the sync service or the business logic.
//
// Validation granularity:
//   * order list entries: one by one (a bad entry is an issue, not a page failure)
//   * an order whose identity (order_sn) or ANY line identity (item_id,
//     quantity) is invalid is NOT returned: storing it with a missing line
//     would make its item totals silently wrong. It becomes an issue
//     (logged, counted failed, retried next run).
//   * non-critical fields missing → null (unknown), never a guess.
// Pure: no I/O.
// ============================================================
import { createHash } from "node:crypto";

import { toDecimalString } from "../core/decimal.ts";
import type { MappedOrder, MappedOrderItem } from "../core/mapped.ts";
import type { Timestamp } from "../core/types.ts";
import { shopeeOrderDetailResponseSchema, shopeeOrderItemSchema, shopeeOrderListItemSchema, shopeeOrderListResponseSchema, shopeeOrderSchema } from "./dto/order.ts";
import { ShopeePayloadError, type ParseIssue } from "./product-adapter.ts";

const API = { list: "v2.order.get_order_list", detail: "v2.order.get_order_detail" } as const;

function unixToIso(seconds: number | null | undefined): Timestamp | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

function idText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t === "" || t === "0" ? null : t;
}

function describe(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function rawField(entry: unknown, key: string): string | null {
  if (entry && typeof entry === "object" && key in entry) {
    const v = (entry as Record<string, unknown>)[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Per-order line identity. Base = order_item_id|item_id|model_id ("-" for
 * missing parts). order_item_id alone is NOT used: Shopee shares it across a
 * bundle deal. Only when the SAME base repeats inside one order (unconfirmed
 * provider behaviour — e.g. a gift/add-on line of the same model) is
 * "#<occurrence>" appended (2, 3, …, in payload order). The occurrence suffix
 * is a fallback, not a guaranteed-stable identity — see docs.
 */
export function buildShopeeOrderItemIdentity(input: {
  orderItemId: string | null;
  itemId: string;
  modelId: string | null;
  occurrenceIndex?: number;
}): string {
  const base = `${input.orderItemId ?? "-"}|${input.itemId}|${input.modelId ?? "-"}`;
  return input.occurrenceIndex && input.occurrenceIndex > 1 ? `${base}#${input.occurrenceIndex}` : base;
}

// ------------------------------------------------------- get_order_list

export interface OrderListPage {
  orders: Array<{ orderSn: string; orderStatus: string | null; bookingSn: string | null }>;
  more: boolean;
  nextCursor: string | null;
  issues: ParseIssue[];
}

export function parseOrderListPage(raw: unknown): OrderListPage {
  const parsed = shopeeOrderListResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ShopeePayloadError(API.list, describe(parsed.error));
  if (parsed.data.error) throw new ShopeePayloadError(API.list, `error=${parsed.data.error} ${parsed.data.message ?? ""}`.trim());
  const response = parsed.data.response;
  if (!response) throw new ShopeePayloadError(API.list, "thiếu response");

  const orders: OrderListPage["orders"] = [];
  const issues: ParseIssue[] = [];
  for (const entry of response.order_list ?? []) {
    const r = shopeeOrderListItemSchema.safeParse(entry);
    if (!r.success) {
      issues.push({ apiName: API.list, externalId: rawField(entry, "order_sn"), reason: describe(r.error) });
      continue;
    }
    orders.push({ orderSn: r.data.order_sn, orderStatus: clean(r.data.order_status), bookingSn: clean(r.data.booking_sn) });
  }
  const cursor = response.next_cursor === null || response.next_cursor === undefined ? null : String(response.next_cursor);
  return { orders, more: response.more === true, nextCursor: cursor === "" ? null : cursor, issues };
}

// ----------------------------------------------------- get_order_detail

export interface ParsedOrderDetails {
  orders: MappedOrder[];
  rawBySn: Map<string, unknown>;
  issues: ParseIssue[];
}

/** One raw order object → MappedOrder, or an issue. */
export function mapShopeeOrderEntry(entry: unknown, options: { fallbackCurrency?: string | null } = {}): { order: MappedOrder } | { issue: ParseIssue } {
  const r = shopeeOrderSchema.safeParse(entry);
  if (!r.success) return { issue: { apiName: API.detail, externalId: rawField(entry, "order_sn"), reason: describe(r.error) } };
  const o = r.data;

  const items: MappedOrderItem[] = [];
  const seen = new Map<string, number>();
  const rawItems = o.item_list ?? [];
  for (let i = 0; i < rawItems.length; i++) {
    const li = shopeeOrderItemSchema.safeParse(rawItems[i]);
    if (!li.success) {
      return { issue: { apiName: API.detail, externalId: o.order_sn, reason: `item_list[${i}]: ${describe(li.error)}` } };
    }
    const line = li.data;
    const orderItemId = idText(line.order_item_id);
    const base = buildShopeeOrderItemIdentity({ orderItemId, itemId: line.item_id, modelId: line.model_id });
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    items.push({
      providerLineKey: buildShopeeOrderItemIdentity({ orderItemId, itemId: line.item_id, modelId: line.model_id, occurrenceIndex: occurrence }),
      externalOrderItemId: orderItemId,
      externalItemId: line.item_id,
      externalModelId: line.model_id,
      itemName: clean(line.item_name) ?? `#${line.item_id}`,
      modelName: clean(line.model_name),
      itemSku: clean(line.item_sku),
      modelSku: clean(line.model_sku),
      quantity: String(line.model_quantity_purchased),
      originalUnitPrice: toDecimalString(line.model_original_price),
      discountedUnitPrice: toDecimalString(line.model_discounted_price),
      promotionType: clean(line.promotion_type),
      promotionId: idText(line.promotion_id),
    });
  }

  const currency = clean(o.currency) ?? options.fallbackCurrency ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return { issue: { apiName: API.detail, externalId: o.order_sn, reason: "thiếu/sai currency" } };
  }

  return {
    order: {
      externalOrderSn: o.order_sn,
      bookingSn: clean(o.booking_sn),
      orderStatus: clean(o.order_status) ?? "UNKNOWN",
      currency,
      paymentMethod: clean(o.payment_method),
      cod: o.cod ?? null,
      channelTotalAmount: toDecimalString(o.total_amount),
      estimatedShippingFee: toDecimalString(o.estimated_shipping_fee),
      reverseShippingFee: toDecimalString(o.reverse_shipping_fee),
      createdAtChannel: unixToIso(o.create_time),
      paidAtChannel: unixToIso(o.pay_time),
      pickupDoneAtChannel: unixToIso(o.pickup_done_time),
      shipByDate: unixToIso(o.ship_by_date),
      updatedAtChannel: unixToIso(o.update_time),
      shippingCarrier: clean(o.shipping_carrier),
      items,
    },
  };
}

export function parseOrderDetails(raw: unknown, options: { fallbackCurrency?: string | null } = {}): ParsedOrderDetails {
  const parsed = shopeeOrderDetailResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ShopeePayloadError(API.detail, describe(parsed.error));
  if (parsed.data.error) throw new ShopeePayloadError(API.detail, `error=${parsed.data.error} ${parsed.data.message ?? ""}`.trim());

  const orders: MappedOrder[] = [];
  const rawBySn = new Map<string, unknown>();
  const issues: ParseIssue[] = [];
  for (const entry of parsed.data.response?.order_list ?? []) {
    const result = mapShopeeOrderEntry(entry, options);
    if ("issue" in result) {
      issues.push(result.issue);
      continue;
    }
    orders.push(result.order);
    rawBySn.set(result.order.externalOrderSn, entry);
  }
  return { orders, rawBySn, issues };
}

/**
 * Fingerprint of what matters for history: status, provider update time and
 * the line structure (identity, quantity, prices). Package/tracking noise does
 * not create a new snapshot.
 */
export function orderFingerprint(order: MappedOrder): string {
  const lines = order.items
    .map((i) => `${i.providerLineKey}:${i.quantity}:${i.originalUnitPrice ?? ""}:${i.discountedUnitPrice ?? ""}`)
    .sort()
    .join(",");
  return createHash("sha256").update(`${order.orderStatus}|${order.updatedAtChannel ?? ""}|${lines}`).digest("hex");
}
