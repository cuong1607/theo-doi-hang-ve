"use server";

// SHOPEE-9A admin repair actions (channel:manage). Every one goes through the
// same queue / scheduler / worker code the cron runs — nothing calls Shopee
// inside the request; the worker runs after the response (after()).
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { recoverStaleSyncJobs, RUNNABLE_SYNC_TYPES } from "@/lib/channels/core/sync-jobs";
import { setShopSyncEnabled } from "@/lib/channels/core/system-health";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { runShopeeWorkerBursts } from "@/lib/channels/shopee/server";
import { requestShopeeSync, runShopeeSchedulerTick } from "@/lib/channels/shopee/sync-service";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: boolean; message: string; warning?: boolean };
const PATH = "/shopee/system-health";
const uuid = z.string().uuid();
/** A click runs inside a user-facing function — one bounded burst. */
const CLICK_BURST_MS = 30_000;

function fail(err: unknown, fallback: string): ActionResult {
  console.error(JSON.stringify({ source: "system-health-action", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
  return { ok: false, message: fallback };
}

export async function runSchedulerOnceAction(): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const { mode, problem } = getShopeeProviderMode();
  if (problem) return { ok: false, message: problem };
  try {
    const config = getSyncConfig();
    const tick = await runShopeeSchedulerTick(createAdminClient(), { config, providerMode: mode });
    if (tick.workDue) after(() => runShopeeWorkerBursts({ bursts: config.schedulerWorkerTriggers, timeBudgetMs: CLICK_BURST_MS, source: "admin_scheduler" }).then(() => undefined));
    revalidatePath(PATH);
    return { ok: true, message: `Scheduler đã chạy: thêm ${tick.enqueued.length} job, thu hồi ${tick.recovered} job treo${tick.workDue ? ", worker đang chạy" : ""}.` };
  } catch (err) {
    return fail(err, "Scheduler chạy lỗi — xem log sync-scheduler.");
  }
}

export async function runWorkerOnceAction(): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  after(() => runShopeeWorkerBursts({ bursts: 1, timeBudgetMs: CLICK_BURST_MS, source: "admin_worker" }).then(() => undefined));
  revalidatePath(PATH);
  return { ok: true, message: "Đã chạy worker 1 lượt (tối đa 30 giây) — trang tự cập nhật." };
}

export async function recoverStaleJobsAction(): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  try {
    const recovered = await recoverStaleSyncJobs(createAdminClient(), getSyncConfig().staleJobMinutes);
    revalidatePath(PATH);
    return { ok: true, message: recovered.length === 0 ? "Không có job treo." : `Đã đưa ${recovered.length} job treo về hàng đợi (giữ điểm dừng).` };
  } catch (err) {
    return fail(err, "Không thu hồi được job treo.");
  }
}

export async function syncShopNowAction(shopId: string): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(shopId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const db = createAdminClient();
  try {
    let created = 0;
    for (const syncType of RUNNABLE_SYNC_TYPES) {
      const job = await requestShopeeSync(db, { shopId, syncType, mode: "manual", createdBy: authz.auth.user.id });
      if (job.created) created++;
    }
    after(() => runShopeeWorkerBursts({ bursts: 1, timeBudgetMs: CLICK_BURST_MS, source: "admin_shop_sync" }).then(() => undefined));
    revalidatePath(PATH);
    return { ok: true, message: created > 0 ? `Đã thêm ${created} yêu cầu đồng bộ cho shop (chạy dần qua hàng đợi).` : "Shop đã có yêu cầu đồng bộ đang chờ — đã ưu tiên." };
  } catch (err) {
    return fail(err, "Không tạo được yêu cầu đồng bộ.");
  }
}

export async function setShopSyncEnabledAction(shopId: string, enabled: boolean): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(shopId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    await setShopSyncEnabled(createAdminClient(), shopId, enabled, authz.auth.user.id);
    revalidatePath(PATH);
    revalidatePath("/shopee/sync");
    return { ok: true, message: enabled ? "Đã bật lại đồng bộ tự động cho shop (xoá thời gian chờ nếu có)." : "Đã tạm dừng đồng bộ tự động cho shop. Các shop khác không bị ảnh hưởng; bấm tay vẫn chạy được." };
  } catch (err) {
    return fail(err, "Không đổi được trạng thái đồng bộ shop.");
  }
}
