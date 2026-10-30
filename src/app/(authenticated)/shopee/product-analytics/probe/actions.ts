"use server";

// SHOPEE-PRODUCT-ANALYTICS-1: trigger of the READ-ONLY production product
// analytics probe. Admin only (channel:manage), explicit typed confirmation,
// one validated internal shop, ≤ 10 explicit item ids.
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { ShopeeConfigError } from "@/lib/channels/shopee/config";
import { ProductAnalyticsProbeInputError, runProductAnalyticsProbeForShop, type ProductAnalyticsProbeResult } from "@/lib/channels/shopee/product-analytics/probe-server";

const CONFIRM = "READ-ONLY";

export type ProductAnalyticsProbeActionResult = { ok: true; result: ProductAnalyticsProbeResult } | { ok: false; message: string };

export async function runProductAnalyticsProbeAction(input: { shopId: string; itemIds: string; confirm: string }): Promise<ProductAnalyticsProbeActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = z.object({ shopId: z.string().uuid(), itemIds: z.string().min(1).max(400), confirm: z.literal(CONFIRM) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: `Chọn shop, nhập item id và gõ đúng "${CONFIRM}" để xác nhận.` };
  console.info(JSON.stringify({ source: "shopee-product-analytics-probe", event: "probe_requested", shopId: parsed.data.shopId, by: authz.auth.user.id }));
  try {
    return { ok: true, result: await runProductAnalyticsProbeForShop(parsed.data.shopId, parsed.data.itemIds) };
  } catch (e) {
    if (e instanceof ProductAnalyticsProbeInputError) return { ok: false, message: e.message };
    if (e instanceof ShopeeConfigError) return { ok: false, message: "Cấu hình Shopee của máy chủ chưa đầy đủ." };
    console.error(JSON.stringify({ source: "shopee-product-analytics-probe", event: "probe_failed", shopId: parsed.data.shopId, error: e instanceof Error ? e.name : "unknown" }));
    return { ok: false, message: "Probe thất bại do lỗi máy chủ." };
  }
}
