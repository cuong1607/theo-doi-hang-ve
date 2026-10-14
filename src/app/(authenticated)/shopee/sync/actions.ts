"use server";

// SHOPEE-PERF-1 sync actions. Every action ONLY writes to the job queue and
// answers immediately; the actual Shopee calls run in a background worker
// (kicked after the response with after(), plus the scheduler / cron).
//   requestSyncNowAction  staff + admin (channel:sync): manual incremental
//   requestBackfillAction admin (channel:manage)
//   retrySyncJobAction / cancelSyncJobAction  admin (channel:manage)
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { cancelSyncJob, retrySyncJob, SyncJobError, type RunnableSyncType } from "@/lib/channels/core/sync-jobs";
import { kickShopeeSyncWorker } from "@/lib/channels/shopee/server";
import { requestShopeeSync } from "@/lib/channels/shopee/sync-service";
import { createAdminClient } from "@/lib/supabase/admin";

export type SyncActionResult = { ok: boolean; message: string };

const uuid = z.string().uuid();
const SYNC_TYPE = z.enum(["order", "product", "escrow"]);

async function requestOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}`;
}

/** Background kick after the response — the user never waits for Shopee. */
async function kickAfterResponse() {
  const origin = await requestOrigin();
  after(() => kickShopeeSyncWorker({ origin }).then(() => undefined));
}

function failMessage(err: unknown, fallback: string): string {
  if (err instanceof SyncJobError) return err.message;
  console.error(JSON.stringify({ source: "sync-action", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
  return fallback;
}

export async function requestSyncNowAction(shopId: string, syncType: RunnableSyncType): Promise<SyncActionResult> {
  const authz = await authorizeAction("channel:sync");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(shopId).success || !SYNC_TYPE.safeParse(syncType).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const job = await requestShopeeSync(createAdminClient(), { shopId, syncType, mode: "manual", createdBy: authz.auth.user.id });
    await kickAfterResponse();
    revalidatePath("/shopee", "layout");
    return job.created
      ? { ok: true, message: "Đã thêm yêu cầu đồng bộ." }
      : { ok: true, message: job.status === "running" ? "Shop này đang được đồng bộ." : "Shop này đã có yêu cầu đồng bộ đang chờ — đã ưu tiên chạy trước." };
  } catch (err) {
    return { ok: false, message: failMessage(err, "Không tạo được yêu cầu đồng bộ.") };
  }
}

export async function requestBackfillAction(shopId: string, syncType: RunnableSyncType, days: number): Promise<SyncActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(shopId).success || !SYNC_TYPE.safeParse(syncType).success || !Number.isInteger(days)) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const job = await requestShopeeSync(createAdminClient(), { shopId, syncType, mode: "backfill", backfillDays: days, createdBy: authz.auth.user.id });
    await kickAfterResponse();
    revalidatePath("/shopee", "layout");
    if (!job.created) return { ok: true, message: "Shop này đang có một job backfill — không tạo thêm." };
    return { ok: true, message: syncType === "order" ? `Đã thêm job backfill ${days} ngày (ưu tiên thấp, chạy dần theo từng cửa sổ 15 ngày).` : "Đã thêm job quét toàn bộ sản phẩm (ưu tiên thấp)." };
  } catch (err) {
    return { ok: false, message: failMessage(err, "Không tạo được job backfill.") };
  }
}

export async function retrySyncJobAction(jobId: string): Promise<SyncActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(jobId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const result = await retrySyncJob(createAdminClient(), jobId);
    if (result === "queued") await kickAfterResponse();
    revalidatePath("/shopee", "layout");
    if (result === "queued") return { ok: true, message: "Đã đưa job vào hàng đợi lại (tiếp tục từ điểm dừng)." };
    if (result === "lane_busy") return { ok: false, message: "Shop này đang có job cùng loại đang chờ/chạy — không thể thử lại lúc này." };
    return { ok: false, message: "Chỉ thử lại được job thất bại hoặc đã hủy." };
  } catch (err) {
    return { ok: false, message: failMessage(err, "Không thử lại được job.") };
  }
}

export async function cancelSyncJobAction(jobId: string): Promise<SyncActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(jobId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const result = await cancelSyncJob(createAdminClient(), jobId, authz.auth.user.id);
    revalidatePath("/shopee", "layout");
    if (result === "cancelled") return { ok: true, message: "Đã hủy job." };
    if (result === "requested") return { ok: true, message: "Đã yêu cầu hủy — job sẽ dừng ở điểm lưu tiến độ kế tiếp." };
    return { ok: false, message: "Job không còn hoạt động." };
  } catch (err) {
    return { ok: false, message: failMessage(err, "Không hủy được job.") };
  }
}
