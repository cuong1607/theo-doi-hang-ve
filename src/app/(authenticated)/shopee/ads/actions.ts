"use server";

// SHOPEE-ADS-1B / ADS-2: Ads data actions in REAL mode — queue / DB only.
//   refreshAdsDataAction    "Làm mới dữ liệu": enqueue HIGH-priority Ads READ
//                           jobs (same queue as the scheduler); skipped when
//                           the HOT sync landed < ADS_MANUAL_DEDUPE_MINUTES ago
//                           unless an admin forces it
//   adsRefreshStatusAction  poll those jobs (the dashboard keeps showing the old
//                           data meanwhile); kicks the worker again if nothing runs
//   adsFreshnessAction      DB freshness stamp for the page's background polling
//                           (never enqueues, never calls Shopee)
//   toggleAdsAutoSyncAction    per-shop rollout switch for the background sync
// Never calls Shopee inside the request and never writes to Shopee: the jobs
// are read-only syncs (read-only policy) executed by the existing worker.
import { headers } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { adsFreshnessStamp, loadAdsFreshness } from "@/lib/channels/shopee/ads/real-source";
import { setAdsShopSyncEnabled } from "@/lib/channels/shopee/ads/schedule";
import { requestAdsRefresh } from "@/lib/channels/shopee/ads/sync";
import { kickShopeeSyncWorker } from "@/lib/channels/shopee/server";
import { getShopeeFlags } from "@/lib/feature-flags";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdsRefreshActionResult = { ok: true; jobIds: string[]; shops: number; failedShops: number; freshShops: number; message: string } | { ok: false; message: string };
export type AdsRefreshStatus = { ok: true; active: number; failed: number; done: number; lastError: string | null } | { ok: false; message: string };
export type AdsFreshnessResult = { ok: true; stamp: string | null } | { ok: false; message: string };

async function kickAfterResponse() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const origin = host ? `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}` : null;
  after(() => kickShopeeSyncWorker({ origin }).then(() => undefined));
}

const shopInput = z.union([z.literal("all"), z.string().uuid()]);

async function liveShopIds(shop: string): Promise<string[] | null> {
  let query = createAdminClient().from("shops").select("id").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true);
  if (shop !== "all") query = query.eq("id", shop);
  const { data, error } = await query;
  if (error) return null;
  return ((data ?? []) as Array<{ id: string }>).map((s) => s.id);
}

export async function refreshAdsDataAction(input: { shop: string; force?: boolean }): Promise<AdsRefreshActionResult> {
  const flags = getShopeeFlags();
  if (!flags.adsEnabled || flags.adsDataSource !== "real") return { ok: false, message: "Đồng bộ Ads chưa được bật (đang hiển thị dữ liệu mẫu)." };
  const authz = await authorizeAction("channel:sync");
  if (!authz.ok) return { ok: false, message: authz.message };
  const shop = shopInput.safeParse(input.shop);
  if (!shop.success) return { ok: false, message: "Shop không hợp lệ." };
  // diagnostic refresh past the dedupe window: admins only
  const force = input.force === true && (await authorizeAction("channel:manage")).ok;

  const db = createAdminClient();
  const shops = await liveShopIds(shop.data);
  if (!shops) return { ok: false, message: "Không đọc được danh sách shop." };
  if (!shops.length) return { ok: false, message: "Không có shop Shopee đang hoạt động." };

  const jobIds: string[] = [];
  let failedShops = 0;
  let freshShops = 0;
  // each shop independently — one failing shop never blocks the others
  for (const shopId of shops) {
    try {
      const r = await requestAdsRefresh(db, { shopId, createdBy: authz.auth.user.id, force });
      if (r.fresh) freshShops++;
      jobIds.push(...r.jobs.filter((j) => j.poll).map((j) => j.jobId));
    } catch (err) {
      failedShops++;
      console.error(JSON.stringify({ source: "ads-refresh", event: "enqueue_failed", shopId, message: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
    }
  }
  if (!jobIds.length && freshShops === 0) return { ok: false, message: "Không tạo được yêu cầu đồng bộ Ads." };
  if (jobIds.length) await kickAfterResponse();
  console.info(JSON.stringify({ source: "ads-refresh", event: "refresh_requested", shops: shops.length, jobs: jobIds.length, freshShops, failedShops, force, by: authz.auth.user.id }));
  const message = !jobIds.length
    ? "Số liệu hôm nay vừa được đồng bộ nền vài phút trước — không cần gọi lại Shopee."
    : failedShops
      ? `${failedShops} shop không tạo được yêu cầu.`
      : "Đã gửi yêu cầu đồng bộ.";
  return { ok: true, jobIds: [...new Set(jobIds)], shops: shops.length, failedShops, freshShops, message };
}

export async function adsRefreshStatusAction(input: { jobIds: string[] }): Promise<AdsRefreshStatus> {
  const authz = await authorizeAction("channel:view");
  if (!authz.ok) return { ok: false, message: authz.message };
  const ids = z.array(z.string().uuid()).min(1).max(60).safeParse(input.jobIds);
  if (!ids.success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const { data, error } = await createAdminClient().from("channel_sync_jobs").select("status, error_message, sync_type").in("id", ids.data);
  if (error) return { ok: false, message: "Không đọc được trạng thái đồng bộ." };
  const rows = (data ?? []) as Array<{ status: string; error_message: string | null; sync_type: string }>;
  if (rows.some((r) => !r.sync_type.startsWith("ads_"))) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const active = rows.filter((r) => ["pending", "running", "retry"].includes(r.status)).length;
  const failed = rows.filter((r) => r.status === "failed" || r.status === "cancelled").length;
  // no scheduler running locally: keep the worker going while work is waiting
  if (active > 0 && !rows.some((r) => r.status === "running")) await kickAfterResponse();
  return { ok: true, active, failed, done: rows.length - active - failed, lastError: rows.find((r) => r.error_message)?.error_message ?? null };
}

/** DB only: the newest Ads read of the selected shop(s). */
export async function adsFreshnessAction(input: { shop: string }): Promise<AdsFreshnessResult> {
  const flags = getShopeeFlags();
  if (!flags.adsEnabled || flags.adsDataSource !== "real") return { ok: true, stamp: null };
  const authz = await authorizeAction("channel:view");
  if (!authz.ok) return { ok: false, message: authz.message };
  const shop = shopInput.safeParse(input.shop);
  if (!shop.success) return { ok: false, message: "Shop không hợp lệ." };
  const shops = await liveShopIds(shop.data);
  if (!shops) return { ok: false, message: "Không đọc được danh sách shop." };
  try {
    return { ok: true, stamp: adsFreshnessStamp(await loadAdsFreshness(createAdminClient(), shops)) };
  } catch {
    return { ok: false, message: "Không đọc được độ mới dữ liệu." };
  }
}

/** Rollout switch (admin): the scheduler only enqueues for enabled shops — and only while ADS_AUTO_SYNC_ENABLED=true. */
export async function toggleAdsAutoSyncAction(input: { shopId: string; enabled: boolean }): Promise<{ ok: boolean; message: string }> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = z.object({ shopId: z.string().uuid(), enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const shops = await liveShopIds(parsed.data.shopId);
  if (!shops?.length) return { ok: false, message: "Không tìm thấy shop Shopee đang hoạt động." };
  try {
    await setAdsShopSyncEnabled(createAdminClient(), { shopId: parsed.data.shopId, enabled: parsed.data.enabled, updatedBy: authz.auth.user.id });
  } catch {
    return { ok: false, message: "Không lưu được cấu hình đồng bộ." };
  }
  console.info(JSON.stringify({ source: "ads-auto-sync", event: parsed.data.enabled ? "shop_enabled" : "shop_disabled", shopId: parsed.data.shopId, by: authz.auth.user.id }));
  revalidatePath("/shopee/ads");
  return { ok: true, message: parsed.data.enabled ? "Đã bật đồng bộ nền cho shop." : "Đã tắt đồng bộ nền cho shop." };
}
