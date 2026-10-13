// ============================================================
// PHASE SHOPEE-0: Shopee → canonical mapper boundary (skeleton).
//
//   Shopee API payload ──► mapShopee*() ──► canonical Mapped* shape
//                                         ──► persistence / Financial Engine
//
// The ONLY place allowed to know Shopee field names (besides ./types.ts).
// Each mapper is pure (no I/O) and is implemented in its sync phase against
// real sample payloads; until then it throws NotImplementedError.
// ============================================================
import { NotImplementedError } from "../core/errors.ts";
import type { MappedOrder, MappedOrderFinancials, MappedPayout, MappedReturn } from "../core/mapped.ts";
import type {
  ShopeeEscrowDetailRaw,
  ShopeeOrderDetailRaw,
  ShopeePayoutDetailRaw,
  ShopeeReturnDetailRaw,
} from "./types.ts";

/** v2.order.get_order_detail → channel_orders + channel_order_items. */
export function mapShopeeOrder(raw: ShopeeOrderDetailRaw): MappedOrder {
  void raw;
  throw new NotImplementedError("mapShopeeOrder");
}

/** v2.payment.get_escrow_detail → order_financials input + order_financial_components. */
export function mapShopeeEscrow(raw: ShopeeEscrowDetailRaw): MappedOrderFinancials {
  void raw;
  throw new NotImplementedError("mapShopeeEscrow");
}

/** v2.returns.get_return_detail → channel_returns + channel_return_items. */
export function mapShopeeReturn(raw: ShopeeReturnDetailRaw): MappedReturn {
  void raw;
  throw new NotImplementedError("mapShopeeReturn");
}

/** v2.payment.get_payout_detail → payout_batches + payout_orders + payout_adjustments. */
export function mapShopeePayout(raw: ShopeePayoutDetailRaw): MappedPayout {
  void raw;
  throw new NotImplementedError("mapShopeePayout");
}
