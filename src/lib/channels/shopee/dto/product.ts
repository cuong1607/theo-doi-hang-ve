// ============================================================
// PHASE SHOPEE-2: Shopee product API DTOs + runtime schemas.
//
// Written from DOCUMENTED response examples — NOT validated against real
// Go-Live payloads yet (docs "Product real-payload validation"). Hence:
//   * every non-identity field is optional/nullable (real payloads may omit it);
//   * unknown extra fields are ignored, never rejected;
//   * identity fields (item_id, model_id) are REQUIRED and must be positive
//     safe integers (number or digit string) — a payload without a valid
//     identity is a parse error, never inserted.
// Only src/lib/channels/shopee/ may import this module.
// ============================================================
import { z } from "zod";

/** Positive integer id that survives JS number precision; normalized to a decimal string. */
export const shopeeIdSchema = z
  .union([z.number(), z.string().regex(/^\d{1,19}$/)])
  .transform((value, ctx) => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) {
      ctx.addIssue({ code: "custom", message: "id must be a positive safe integer" });
      return z.NEVER;
    }
    return typeof value === "string" ? value.replace(/^0+(?=\d)/, "") : String(n);
  });

const optionalNumberish = z.union([z.number(), z.string()]).nullish();
const optionalString = z.string().nullish();

export const shopeePriceInfoSchema = z.object({
  currency: optionalString,
  original_price: optionalNumberish,
  current_price: optionalNumberish,
});

const stockSummarySchema = z.object({
  total_reserved_stock: optionalNumberish,
  total_available_stock: optionalNumberish,
});

export const shopeeStockInfoV2Schema = z.object({
  summary_info: stockSummarySchema.nullish(),
  seller_stock: z.array(z.record(z.string(), z.unknown())).nullish(),
  shopee_stock: z.array(z.record(z.string(), z.unknown())).nullish(),
});

const dimensionSchema = z.object({
  package_length: optionalNumberish,
  package_width: optionalNumberish,
  package_height: optionalNumberish,
});

const envelope = {
  error: z.string().nullish(),
  message: z.string().nullish(),
  warning: z.union([z.string(), z.array(z.unknown())]).nullish(),
  request_id: z.string().nullish(),
};

// ---------- v2.product.get_item_list ----------

export const SHOPEE_ITEM_STATUSES = ["NORMAL", "UNLIST", "REVIEWING", "BANNED", "SELLER_DELETE", "SHOPEE_DELETE"] as const;
export type ShopeeItemStatus = (typeof SHOPEE_ITEM_STATUSES)[number];

export const shopeeItemListEntrySchema = z.object({
  item_id: shopeeIdSchema,
  item_status: optionalString,
  update_time: z.number().nullish(),
  tag: z.object({ kit: z.boolean().nullish() }).nullish(),
});

export const shopeeGetItemListResponseSchema = z.object({
  ...envelope,
  response: z
    .object({
      // Raw entries: validated one by one so one bad entry can't drop a page.
      item: z.array(z.unknown()).nullish(),
      total_count: z.number().nullish(),
      has_next_page: z.boolean().nullish(),
      next_offset: z.number().nullish(),
    })
    .nullish(),
});

// ---------- v2.product.get_item_base_info ----------

export const shopeeItemBaseInfoSchema = z.object({
  item_id: shopeeIdSchema,
  category_id: z.union([z.number(), z.string()]).nullish(),
  item_name: optionalString,
  description: optionalString,
  item_sku: optionalString,
  create_time: z.number().nullish(),
  update_time: z.number().nullish(),
  price_info: z.array(shopeePriceInfoSchema).nullish(),
  image: z.record(z.string(), z.unknown()).nullish(),
  weight: optionalNumberish,
  dimension: dimensionSchema.nullish(),
  item_status: optionalString,
  has_model: z.boolean().nullish(),
  promotion_id: z.union([z.number(), z.string()]).nullish(),
  stock_info_v2: shopeeStockInfoV2Schema.nullish(),
});

export const shopeeGetItemBaseInfoResponseSchema = z.object({
  ...envelope,
  response: z.object({ item_list: z.array(z.unknown()).nullish() }).nullish(),
});

// ---------- v2.product.get_model_list ----------

export const shopeeTierVariationSchema = z.object({
  name: optionalString,
  option_list: z.array(z.object({ option: optionalString })).nullish(),
});

export const shopeeModelSchema = z.object({
  model_id: shopeeIdSchema,
  tier_index: z.array(z.number()).nullish(),
  model_sku: optionalString,
  model_status: optionalString,
  price_info: z.array(shopeePriceInfoSchema).nullish(),
  stock_info_v2: shopeeStockInfoV2Schema.nullish(),
  weight: optionalNumberish,
  dimension: dimensionSchema.nullish(),
});

export const shopeeGetModelListResponseSchema = z.object({
  ...envelope,
  response: z
    .object({
      tier_variation: z.array(shopeeTierVariationSchema).nullish(),
      standardise_tier_variation: z.array(z.unknown()).nullish(),
      model: z.array(z.unknown()).nullish(),
    })
    .nullish(),
});

export type ShopeePriceInfo = z.infer<typeof shopeePriceInfoSchema>;
export type ShopeeStockInfo = z.infer<typeof shopeeStockInfoV2Schema>;
export type ShopeeItemListEntry = z.infer<typeof shopeeItemListEntrySchema>;
export type ShopeeGetItemListResponse = z.infer<typeof shopeeGetItemListResponseSchema>;
export type ShopeeItemBaseInfo = z.infer<typeof shopeeItemBaseInfoSchema>;
export type ShopeeGetItemBaseInfoResponse = z.infer<typeof shopeeGetItemBaseInfoResponseSchema>;
export type ShopeeTierVariation = z.infer<typeof shopeeTierVariationSchema>;
export type ShopeeModel = z.infer<typeof shopeeModelSchema>;
export type ShopeeGetModelListResponse = z.infer<typeof shopeeGetModelListResponseSchema>;
