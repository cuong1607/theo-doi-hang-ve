// ============================================================
// PRODUCT-ANALYTICS-2: raw get_order_detail order → product sales fact rows.
//
// WHITELIST projection: every output field is named here, so buyer data in
// the provider response (message_to_seller, any recipient / buyer field) can
// never reach the database. No raw order payload is stored anywhere.
//
// Identity: one row per order line = (order_sn, line_item_id). Verified on
// real production payloads: line_item_id is unique inside an order, while
// (item_id, model_id) repeats (gift / add-on lines) and order_item_id is
// shared by bundle lines.
//
// Money: unit prices are passed on as decimal STRINGS (Decimal-safe; the
// database does every multiplication / sum in NUMERIC — never JS floats).
// Pure: no I/O.
// ============================================================
import { toDecimalString } from "../channels/core/decimal.ts";

import { classifyProductSalesOrderStatus, type ProductSalesStatusClass } from "./sales-status.ts";

export const PRODUCT_SALES_TIME_ZONE = "Asia/Ho_Chi_Minh";

export interface ProductSalesFactRow {
  provider_order_id: string;
  provider_line_item_id: string;
  provider_order_item_id: string | null;
  provider_item_id: string;
  provider_model_id: string | null;
  order_status: string;
  status_class: ProductSalesStatusClass;
  is_cancelled: boolean;
  is_completed: boolean;
  is_valid_for_sales: boolean;
  order_created_at: string;
  order_updated_at: string | null;
  paid_at: string | null;
  quantity: number;
  cancelled_qty: number;
  returned_qty: number;
  unit_original_price: string | null;
  unit_discounted_price: string | null;
  currency: string | null;
  promotion_type: string | null;
  is_free_gift: boolean;
  source_updated_at: string;
  /** Identity metadata only (shopee_products), never a fact column. */
  item_name: string | null;
  item_sku: string | null;
  image_url: string | null;
}

export interface ProductSalesMapIssue {
  orderSn: string | null;
  reason: string;
}

/** Exact keys a fact row may carry (privacy test pins this list). */
export const PRODUCT_SALES_FACT_KEYS: readonly (keyof ProductSalesFactRow)[] = [
  "provider_order_id", "provider_line_item_id", "provider_order_item_id", "provider_item_id", "provider_model_id",
  "order_status", "status_class", "is_cancelled", "is_completed", "is_valid_for_sales",
  "order_created_at", "order_updated_at", "paid_at", "quantity", "cancelled_qty", "returned_qty",
  "unit_original_price", "unit_discounted_price", "currency", "promotion_type", "is_free_gift", "source_updated_at",
  "item_name", "item_sku", "image_url",
];

const IMAGE_URL = /^https:\/\/[a-z0-9.-]+\/file\/[A-Za-z0-9_-]+$/;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Provider 64-bit id → decimal text; numbers beyond 2^53 are refused (precision already lost). */
export function providerId(v: unknown, { zeroIsNull = false } = {}): string | null {
  let s: string | null = null;
  if (typeof v === "number") s = Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  else if (typeof v === "string" && /^[0-9]{1,20}$/.test(v.trim())) s = v.trim().replace(/^0+(?=\d)/, "");
  if (s === null) return null;
  if (zeroIsNull && s === "0") return null;
  return s;
}

function unixIso(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null;
}

function text(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function price(v: unknown): string | null {
  const d = toDecimalString(v);
  return d !== null && !d.startsWith("-") ? d : null;
}

/** One raw order (an element of get_order_detail response.order_list) → its fact rows, or an issue. */
export function mapOrderToSalesFacts(entry: unknown, options: { fallbackCurrency?: string | null } = {}): { rows: ProductSalesFactRow[] } | { issue: ProductSalesMapIssue } {
  const o = obj(entry);
  const orderSn = text(o?.order_sn, 64);
  if (!o || !orderSn) return { issue: { orderSn: null, reason: "thiếu order_sn" } };
  const createdAt = unixIso(o.create_time);
  if (!createdAt) return { issue: { orderSn, reason: "thiếu create_time" } };
  const updatedAt = unixIso(o.update_time);
  const status = text(o.order_status, 40) ?? "UNKNOWN";
  const decision = classifyProductSalesOrderStatus(status);
  const currencyRaw = text(o.currency, 3) ?? options.fallbackCurrency ?? null;
  const currency = currencyRaw && /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : null;
  const lines = Array.isArray(o.item_list) ? o.item_list : null;
  if (!lines || lines.length === 0) return { issue: { orderSn, reason: "đơn không có item_list" } };

  const rows: ProductSalesFactRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const li = obj(lines[i]);
    const lineId = providerId(li?.line_item_id, { zeroIsNull: true });
    const itemId = providerId(li?.item_id, { zeroIsNull: true });
    const quantity = nonNegInt(li?.model_quantity_purchased);
    // an order with ONE unusable line is refused whole: storing the rest would make its totals silently wrong
    if (!li || !lineId) return { issue: { orderSn, reason: `item_list[${i}]: thiếu line_item_id` } };
    if (!itemId) return { issue: { orderSn, reason: `item_list[${i}]: item_id không hợp lệ` } };
    if (!quantity) return { issue: { orderSn, reason: `item_list[${i}]: số lượng không hợp lệ` } };
    if (seen.has(lineId)) return { issue: { orderSn, reason: `item_list[${i}]: line_item_id trùng` } };
    seen.add(lineId);
    const promotionType = text(li.promotion_type, 60);
    const image = text(obj(li.image_info)?.image_url, 300);
    rows.push({
      provider_order_id: orderSn,
      provider_line_item_id: lineId,
      provider_order_item_id: providerId(li.order_item_id, { zeroIsNull: true }),
      provider_item_id: itemId,
      provider_model_id: providerId(li.model_id, { zeroIsNull: true }),
      order_status: status,
      status_class: decision.statusClass,
      is_cancelled: decision.isCancelled,
      is_completed: decision.isCompleted,
      is_valid_for_sales: decision.isValidForSales,
      order_created_at: createdAt,
      order_updated_at: updatedAt,
      paid_at: unixIso(o.pay_time),
      quantity,
      cancelled_qty: Math.min(nonNegInt(li.cancelled_qty) ?? 0, quantity),
      returned_qty: Math.min(nonNegInt(li.returned_qty) ?? 0, quantity),
      unit_original_price: price(li.model_original_price),
      unit_discounted_price: price(li.model_discounted_price),
      currency,
      promotion_type: promotionType,
      is_free_gift: promotionType === "add_on_free_gift_sub",
      source_updated_at: updatedAt ?? createdAt,
      item_name: text(li.item_name, 300),
      item_sku: text(li.item_sku, 100),
      image_url: image && IMAGE_URL.test(image) ? image : null,
    });
  }
  return { rows };
}

/** VN business date of an instant (the database derives report_date the same way). */
export function productSalesReportDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PRODUCT_SALES_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
