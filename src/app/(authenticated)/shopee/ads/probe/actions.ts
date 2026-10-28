"use server";

// SHOPEE-ADS-1A: trigger of the READ-ONLY production Ads probe. Admin only
// (channel:manage), explicit typed confirmation, one validated internal shop.
// Nothing is persisted: the sanitized report goes back to the admin's browser.
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { ADS_PROBE_CONFIRM_TEXT, type AdsProbeReport } from "@/lib/channels/shopee/ads/probe";
import { AdsProbeInputError, runAdsProbeForShop } from "@/lib/channels/shopee/ads/probe-server";
import { ShopeeConfigError } from "@/lib/channels/shopee/config";
import { getShopeeFlags } from "@/lib/feature-flags";


export type AdsProbeActionResult = { ok: true; report: AdsProbeReport } | { ok: false; message: string };

export async function runAdsProbeAction(input: { shopId: string; confirm: string; kind?: "baseline" | "expansion" }): Promise<AdsProbeActionResult> {
  if (!getShopeeFlags().adsEnabled) return { ok: false, message: "Quảng cáo Shopee đang tắt." };
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = z.object({ shopId: z.string().uuid(), confirm: z.literal(ADS_PROBE_CONFIRM_TEXT), kind: z.enum(["baseline", "expansion"]).default("baseline") }).safeParse(input);
  if (!parsed.success) return { ok: false, message: `Chọn shop và gõ đúng "${ADS_PROBE_CONFIRM_TEXT}" để xác nhận.` };
  console.info(JSON.stringify({ source: "shopee-ads-probe", event: "probe_requested", kind: parsed.data.kind, shopId: parsed.data.shopId, by: authz.auth.user.id }));
  try {
    return { ok: true, report: await runAdsProbeForShop(parsed.data.shopId, parsed.data.kind) };
  } catch (e) {
    if (e instanceof AdsProbeInputError) return { ok: false, message: e.message };
    if (e instanceof ShopeeConfigError) return { ok: false, message: "Cấu hình Shopee của máy chủ chưa đầy đủ." };
    console.error(JSON.stringify({ source: "shopee-ads-probe", event: "probe_failed", shopId: parsed.data.shopId, error: e instanceof Error ? e.name : "unknown" }));
    return { ok: false, message: "Probe thất bại do lỗi máy chủ." };
  }
}
