// ============================================================
// PHASE SHOPEE-3: Shopee order API DTOs + runtime schemas.
//
// From DOCUMENTED examples only — NOT validated against real Go-Live payloads
// (docs "Order real-payload validation"). Tolerant: every non-identity field
// is optional/nullable and unknown fields are ignored.
//   order: order_sn REQUIRED (non-empty string)
//   line:  item_id REQUIRED (positive safe integer), model_quantity_purchased
//          REQUIRED (positive integer). model_id may be 0 / null / missing
//          (variation-less item) and order_item_id may be missing.
// Only src/lib/channels/shopee/ may import this module.
// ============================================================
import { z } from "zod";

import { shopeeIdSchema } from "./product.ts";

const numberish = z.union([z.number(), z.string()]).nullish();
const optionalString = z.string().nullish();
const unixSeconds = z.number().nullish();

const envelope = {
  error: z.string().nullish(),
  message: z.string().nullish(),
  warning: z.union([z.string(), z.array(z.unknown())]).nullish(),
  request_id: z.string().nullish(),
};

export const SHOPEE_ORDER_STATUSES = [
  "UNPAID",
  "READY_TO_SHIP",
  "PROCESSED",
  "RETRY_SHIP",
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "IN_CANCEL",
  "CANCELLED",
  "TO_RETURN",
  "COMPLETED",
] as const;

// ---------- v2.order.get_order_list ----------

export const shopeeOrderListItemSchema = z.object({
  order_sn: z.string().trim().min(1),
  order_status: optionalString,
  booking_sn: optionalString,
});

export const shopeeOrderListResponseSchema = z.object({
  ...envelope,
  response: z
    .object({
      more: z.boolean().nullish(),
      next_cursor: z.union([z.string(), z.number()]).nullish(),
      order_list: z.array(z.unknown()).nullish(),
    })
    .nullish(),
});

// ---------- v2.order.get_order_detail ----------

/** 0 / "0" / null / missing all mean "no variation". */
export const shopeeOptionalModelIdSchema = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value === 0 || value === "0" || value === "") return null;
    const parsed = shopeeIdSchema.safeParse(value);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "model_id không hợp lệ" });
      return z.NEVER;
    }
    return parsed.data;
  });

export const shopeeOrderItemSchema = z.object({
  order_item_id: z.union([z.number(), z.string()]).nullish(),
  item_id: shopeeIdSchema,
  item_name: optionalString,
  item_sku: optionalString,
  model_id: shopeeOptionalModelIdSchema,
  model_name: optionalString,
  model_sku: optionalString,
  model_original_price: numberish,
  model_discounted_price: numberish,
  model_quantity_purchased: z.number().int().positive(),
  promotion_id: z.union([z.number(), z.string()]).nullish(),
  promotion_type: optionalString,
  add_on_deal: z.boolean().nullish(),
  add_on_deal_id: z.union([z.number(), z.string()]).nullish(),
  main_item: z.boolean().nullish(),
  weight: numberish,
});

export const shopeePackageSchema = z.object({
  package_number: optionalString,
  logistics_status: optionalString,
  shipping_carrier: optionalString,
  item_list: z.array(z.unknown()).nullish(),
});

export const shopeeOrderSchema = z.object({
  order_sn: z.string().trim().min(1),
  booking_sn: optionalString,
  order_status: optionalString,
  create_time: unixSeconds,
  update_time: unixSeconds,
  pay_time: unixSeconds,
  pickup_done_time: unixSeconds,
  ship_by_date: unixSeconds,
  currency: optionalString,
  payment_method: optionalString,
  cod: z.boolean().nullish(),
  total_amount: numberish,
  estimated_shipping_fee: numberish,
  reverse_shipping_fee: numberish,
  shipping_carrier: optionalString,
  fulfillment_flag: optionalString,
  cancel_by: optionalString,
  cancel_reason: optionalString,
  // Validated per line by the adapter (one bad line must not hide which line failed).
  item_list: z.array(z.unknown()).nullish(),
  package_list: z.array(z.unknown()).nullish(),
});

export const shopeeOrderDetailResponseSchema = z.object({
  ...envelope,
  response: z.object({ order_list: z.array(z.unknown()).nullish() }).nullish(),
});

export type ShopeeOrderListItem = z.infer<typeof shopeeOrderListItemSchema>;
export type ShopeeOrderListResponse = z.infer<typeof shopeeOrderListResponseSchema>;
export type ShopeeOrderItem = z.infer<typeof shopeeOrderItemSchema>;
export type ShopeePackage = z.infer<typeof shopeePackageSchema>;
export type ShopeeOrder = z.infer<typeof shopeeOrderSchema>;
export type ShopeeOrderDetailResponse = z.infer<typeof shopeeOrderDetailResponseSchema>;
