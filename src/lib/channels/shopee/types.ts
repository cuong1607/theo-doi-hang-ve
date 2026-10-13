// ============================================================
// PHASE SHOPEE-0: Shopee Open Platform v2 — provider-specific shapes.
//
// Deliberately PARTIAL: only the fields the mappers are expected to read,
// typed loosely enough to accept the real payloads. The full DTOs are
// written in the sync phases against real sample responses — every field
// here must be re-checked then. Nothing outside src/lib/channels/shopee/
// may import from this file: the rest of the app uses the canonical types
// in src/lib/channels/core/ and src/lib/financial/.
//
// Shopee timestamps are Unix SECONDS; ids may exceed 2^53, so the sync
// layer must parse responses without losing precision before they reach
// these types (ids are typed as string | number for that reason).
// ============================================================

// ---------- SHOPEE-1: common envelope + auth/test DTOs ----------

/**
 * Every v2 response: `error` is "" on success, otherwise a string code.
 * Auth endpoints put their fields at the top level; most others nest them
 * in `response`. Fields are optional because real payloads must be
 * validated (docs "Real payload validation") — never trusted blindly.
 */
export interface ShopeeEnvelope {
  error?: string;
  message?: string;
  request_id?: string;
  warning?: string;
}

export interface ShopeeApiResponse<T> extends ShopeeEnvelope {
  response?: T;
}

/** POST /api/v2/auth/token/get and /api/v2/auth/access_token/get (top-level fields). */
export interface ShopeeTokenResponse extends ShopeeEnvelope {
  access_token?: string;
  refresh_token?: string;
  /** Seconds until the access token expires (~14400). */
  expire_in?: number;
  shop_id?: number;
  partner_id?: number;
  shop_id_list?: number[];
  merchant_id_list?: number[];
}

/** GET /api/v2/shop/get_shop_info (top-level fields) — the SHOPEE-1 test call. */
export interface ShopeeShopInfoResponse extends ShopeeEnvelope {
  shop_name?: string;
  region?: string;
  status?: string;
  /** Authorization expiry, Unix seconds. */
  expire_time?: number;
  auth_time?: number;
}

export type ShopeeId = string | number;
export type ShopeeUnixSeconds = number;

/** API endpoints the Financial Core will use, and what each one is for. */
export const SHOPEE_APIS = {
  // Order
  "v2.order.get_order_list": "Liệt kê order_sn theo cửa sổ thời gian (create/update time) — dùng cho sync tăng dần.",
  "v2.order.get_order_detail": "Chi tiết order: trạng thái, item_list, giá, phí ship ước tính.",
  // Product
  "v2.product.get_item_list": "Liệt kê item_id theo trạng thái/cửa sổ update_time.",
  "v2.product.get_item_base_info": "Thông tin item: tên, SKU, category, has_model, giá, tồn.",
  "v2.product.get_model_list": "Danh sách model (biến thể) của item: model_id, model_sku, giá, tồn.",
  // Payment
  "v2.payment.get_escrow_detail": "Breakdown tài chính của MỘT order (phí, voucher, ship, thuế, escrow_amount).",
  "v2.payment.get_income_detail": "Danh sách thu nhập theo kỳ (đã/đang release).",
  "v2.payment.get_income_overview": "Tổng quan thu nhập theo kỳ để đối soát.",
  "v2.payment.get_payout_detail": "Các lần payout và order/adjustment nằm trong từng payout.",
  // Returns
  "v2.returns.get_return_list": "Liệt kê return_sn theo cửa sổ thời gian.",
  "v2.returns.get_return_detail": "Chi tiết return: lý do, số tiền hoàn, item, trạng thái vận chuyển ngược.",
} as const;

export type ShopeeApiName = keyof typeof SHOPEE_APIS;

export interface ShopeeOrderItemRaw {
  item_id: ShopeeId;
  item_name: string;
  item_sku?: string;
  model_id?: ShopeeId;
  model_name?: string;
  model_sku?: string;
  model_quantity_purchased: number;
  model_original_price?: number;
  model_discounted_price?: number;
  /** Shared by every item of one bundle deal — not a line identifier. */
  order_item_id?: ShopeeId;
  promotion_type?: string;
  promotion_id?: ShopeeId;
}

export interface ShopeeOrderDetailRaw {
  order_sn: string;
  booking_sn?: string;
  order_status: string;
  currency: string;
  cod?: boolean;
  payment_method?: string;
  total_amount?: number;
  estimated_shipping_fee?: number;
  reverse_shipping_fee?: number;
  create_time?: ShopeeUnixSeconds;
  update_time?: ShopeeUnixSeconds;
  pay_time?: ShopeeUnixSeconds;
  pickup_done_time?: ShopeeUnixSeconds;
  ship_by_date?: ShopeeUnixSeconds;
  item_list?: ShopeeOrderItemRaw[];
}

/** get_escrow_detail response.order_income — kept open: Shopee adds fee fields. */
export interface ShopeeEscrowDetailRaw {
  order_sn: string;
  order_income: Record<string, unknown>;
}

export interface ShopeeReturnDetailRaw {
  return_sn: ShopeeId;
  order_sn: string;
  status?: string;
  reason?: string;
  text_reason?: string;
  refund_amount?: number;
  currency?: string;
  needs_logistics?: boolean;
  tracking_number?: string;
  create_time?: ShopeeUnixSeconds;
  update_time?: ShopeeUnixSeconds;
  item?: Array<{
    item_id: ShopeeId;
    model_id?: ShopeeId;
    item_sku?: string;
    variation_sku?: string;
    amount: number;
    refund_amount?: number;
  }>;
}

export interface ShopeePayoutDetailRaw {
  payout_info: Record<string, unknown>;
  escrow_list?: Array<Record<string, unknown>>;
  offline_adjustment_list?: Array<Record<string, unknown>>;
}
