"use server";

// SHOPEE-ADS-1B: "Làm mới dữ liệu" in REAL mode — queue only.
//   refreshAdsDataAction   enqueue the Ads READ jobs of the selected shop(s),
//                          then kick the worker after the response
//   adsRefreshStatusAction poll those jobs (the dashboard keeps showing the old
//                          data meanwhile); kicks the worker again if nothing runs
// Never calls Shopee inside the request and never writes to Shopee: the jobs
// are read-only syncs (read-only policy) executed by the existing worker.
import { headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { requestAdsRefresh } from "@/lib/channels/shopee/ads/sync";
import { kickShopeeSyncWorker } from "@/lib/channels/shopee/server";
import { getShopeeFlags } from "@/lib/feature-flags";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdsRefreshActionResult = { ok: true; jobIds: string[]; shops: number; failedShops: number; message: string } | { ok: false; message: string };
export type AdsRefreshStatus = { ok: true; active: number; failed: number; done: number; lastError: string | null } | { ok: false; message: string };

async function kickAfterResponse() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const origin = host ? `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}` : null;
  after(() => kickShopeeSyncWorker({ origin }).then(() => undefined));
}

export async function refreshAdsDataAction(input: { shop: string }): Promise<AdsRefreshActionResult> {
  const flags = getShopeeFlags();
  if (!flags.adsEnabled || flags.adsDataSource !== "real") return { ok: false, message: "Đồng bộ Ads chưa được bật (đang hiển thị dữ liệu mẫu)." };
  const authz = await authorizeAction("channel:sync");
  if (!authz.ok) return { ok: false, message: authz.message };
  const shop = z.union([z.literal("all"), z.string().uuid()]).safeParse(input.shop);
  if (!shop.success) return { ok: false, message: "Shop không hợp lệ." };

  const db = createAdminClient();
  let query = db.from("shops").select("id").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true);
  if (shop.data !== "all") query = query.eq("id", shop.data);
  const { data: shops, error } = await query;
  if (error) return { ok: false, message: "Không đọc được danh sách shop." };
  if (!shops?.length) return { ok: false, message: "Không có shop Shopee đang hoạt động." };

  const jobIds: string[] = [];
  let failedShops = 0;
  // each shop independently — one failing shop never blocks the others
  for (const s of shops as Array<{ id: string }>) {
    try {
      const r = await requestAdsRefresh(db, { shopId: s.id, createdBy: authz.auth.user.id });
      jobIds.push(...r.jobs.map((j) => j.jobId));
    } catch (err) {
      failedShops++;
      console.error(JSON.stringify({ source: "ads-refresh", event: "enqueue_failed", shopId: s.id, message: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
    }
  }
  if (!jobIds.length) return { ok: false, message: "Không tạo được yêu cầu đồng bộ Ads." };
  await kickAfterResponse();
  console.info(JSON.stringify({ source: "ads-refresh", event: "refresh_requested", shops: shops.length, jobs: jobIds.length, failedShops, by: authz.auth.user.id }));
  return { ok: true, jobIds, shops: shops.length, failedShops, message: failedShops ? `${failedShops} shop không tạo được yêu cầu.` : "Đã gửi yêu cầu đồng bộ." };
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
