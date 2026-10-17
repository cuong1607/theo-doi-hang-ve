"use server";

// LOCAL-LIVE-1 §9: developer-only sync controls. Every action refuses
// unless devToolsEnabled() (next dev, or APP_ENV=local) AND the caller is an
// admin (channel:manage). They run IN the request and return what happened,
// so a developer can step the pipeline by hand: enqueue → scheduler tick →
// worker slice → diagnose, without the after() kick of the normal buttons.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { diagnosePendingQueue } from "@/lib/channels/core/sync-diagnostics";
import type { RunnableSyncType } from "@/lib/channels/core/sync-jobs";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { getShopeeSyncWorker, runShopeeWorkerBursts } from "@/lib/channels/shopee/server";
import { requestShopeeSync, runShopeeSchedulerTick } from "@/lib/channels/shopee/sync-service";
import { devToolsEnabled } from "@/lib/dev-tools";
import { createAdminClient } from "@/lib/supabase/admin";

export type DevActionResult = { ok: boolean; message: string; detail?: unknown };

const uuid = z.string().uuid();
const SYNC_TYPE = z.enum(["order", "product", "escrow", "return", "income", "payout"]);

async function guard(): Promise<DevActionResult | null> {
  if (!devToolsEnabled()) return { ok: false, message: "Công cụ dev chỉ dùng được trên môi trường local." };
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  return null;
}

function failed(err: unknown): DevActionResult {
  return { ok: false, message: err instanceof Error ? err.message.slice(0, 300) : String(err) };
}

/** Scheduler tick only (heartbeat, stale recovery, enqueue due jobs, prune) — no worker. */
export async function devRunSchedulerTickAction(): Promise<DevActionResult> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const { mode, problem } = getShopeeProviderMode();
    if (problem) return { ok: false, message: problem };
    const db = createAdminClient();
    const config = getSyncConfig();
    const tick = await runShopeeSchedulerTick(db, { config, providerMode: mode });
    const pending = await diagnosePendingQueue(db, config);
    revalidatePath("/shopee", "layout");
    return {
      ok: true,
      message: `Tick xong: tạo ${tick.enqueued.length} job, ${tick.alreadyQueued.length} đã có, thu hồi ${tick.recovered} job treo.`,
      detail: { tick, pending: pending.map(({ syncType, status, reason, detail }) => ({ syncType, status, reason, detail })) },
    };
  } catch (err) {
    return failed(err);
  }
}

/** Claims ONE job and runs ONE slice of it. */
export async function devRunWorkerOnceAction(): Promise<DevActionResult> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const report = await getShopeeSyncWorker().runOne();
    revalidatePath("/shopee", "layout");
    if (!report) {
      const pending = await diagnosePendingQueue(createAdminClient(), getSyncConfig());
      return { ok: true, message: "Không có job nào nhận được.", detail: { pending: pending.map(({ syncType, status, reason, detail }) => ({ syncType, status, reason, detail })) } };
    }
    return { ok: true, message: `${report.syncType}: ${report.status}${report.continuationReason ? ` (${report.continuationReason})` : ""} · ${report.apiCalls} lệnh API · ${report.durationMs} ms`, detail: report };
  } catch (err) {
    return failed(err);
  }
}

/** One full cron cycle as production runs it: tick, then worker bursts within the budget. */
export async function devRunCycleAction(): Promise<DevActionResult> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const { mode, problem } = getShopeeProviderMode();
    if (problem) return { ok: false, message: problem };
    const db = createAdminClient();
    const config = getSyncConfig();
    const tick = await runShopeeSchedulerTick(db, { config, providerMode: mode });
    const reports = tick.workDue ? await runShopeeWorkerBursts({ bursts: config.schedulerWorkerTriggers, timeBudgetMs: config.workerTimeBudgetMs, source: "dev" }) : [];
    const slices = reports.flatMap((r) => r.slices);
    revalidatePath("/shopee", "layout");
    return {
      ok: true,
      message: `Chu kỳ xong: tạo ${tick.enqueued.length} job, chạy ${slices.length} lượt (${slices.map((s) => `${s.syncType}:${s.status}`).join(", ") || "không có"}).`,
      detail: { tick, slices },
    };
  } catch (err) {
    return failed(err);
  }
}

/** Enqueue a manual job WITHOUT kicking the worker (to test scheduler / worker pickup). */
export async function devEnqueueAction(shopId: string, syncType: RunnableSyncType): Promise<DevActionResult> {
  const denied = await guard();
  if (denied) return denied;
  if (!uuid.safeParse(shopId).success || !SYNC_TYPE.safeParse(syncType).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const job = await requestShopeeSync(createAdminClient(), { shopId, syncType, mode: "manual" });
    revalidatePath("/shopee", "layout");
    return { ok: true, message: job.created ? `Đã tạo job ${syncType} (chưa chạy).` : `Đã có job ${syncType} đang ${job.status}.`, detail: job };
  } catch (err) {
    return failed(err);
  }
}

export async function devDiagnoseQueueAction(): Promise<DevActionResult> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const pending = await diagnosePendingQueue(createAdminClient(), getSyncConfig());
    return { ok: true, message: pending.length === 0 ? "Hàng đợi trống." : `${pending.length} job đang chờ.`, detail: pending.map(({ syncType, status, reason, label, detail }) => ({ syncType, status, reason, label, detail })) };
  } catch (err) {
    return failed(err);
  }
}
