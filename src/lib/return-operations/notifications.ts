// ============================================================
// PHASE SHOPEE-6B: scheduled return-operation notifications.
//
// runReturnNotificationTick runs inside the per-minute scheduler tick
// (pg_cron → /api/internal/shopee/sync-scheduler):
//   1. pre-sync   slot − presync_minutes ≤ now < slot and the return data was
//                 not refreshed since that moment → enqueue manual return /
//                 return_logistics / failed_delivery jobs (idempotent enqueue)
//   2. generate   slot ≤ now < slot + grace → claim the run (DB unique key:
//                 one run per setting + business date + slot) → snapshot the
//                 exact operation membership + delta in SQL → summary from
//                 the same read service as the page → message → send
// Never throws to the caller: one setting's failure is recorded on its run.
// The sender is injected (production: notifications/service.ts → Zalo) so
// the architecture can add other channels later and tests never send.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ReturnOperationType } from "./classify.ts";
import { formatReturnNotificationMessage, type MessageBucket, type MessageCarrier, type MessageDelta } from "./notification-message.ts";
import { getDailyReturnOperationsSummary, getReturnSyncFreshness, loadDeliveryWindows } from "./queries.ts";
import { dueSlots, presyncSlots, type ScheduleSlot } from "./schedule.ts";
import type { Breakdown, DailySummary } from "./summary.ts";
import { businessDateOf, localTimeOf, toMinutes } from "./time.ts";

export const RETURN_NOTIFICATION_EVENT = "RETURN_OPERATIONS_SUMMARY";
export const PRESYNC_SYNC_TYPES = ["return", "return_logistics", "failed_delivery"] as const;

export interface NotificationSetting {
  id: string;
  shopId: string | null;
  name: string;
  enabled: boolean;
  timezone: string;
  carrierFilter: string | null;
  operationTypeFilter: ReturnOperationType | null;
  includeDelta: boolean;
  includeDetail: boolean;
  presyncMinutes: number;
  schedules: Array<ScheduleSlot & { sortOrder: number }>;
}

export type NotificationSender = (input: { message: string; dedupeKey: string; runId: string }) => Promise<{ totalRecipients: number; sentCount: number; failedCount: number }>;
export type PresyncEnqueuer = (input: { shopIds: string[]; focusDate: string }) => Promise<number>;

export async function loadNotificationSettings(db: SupabaseClient, options: { enabledOnly?: boolean } = {}): Promise<NotificationSetting[]> {
  let q = db.from("return_notification_settings").select("*, return_notification_schedules(id, time_of_day, enabled, sort_order)").order("created_at");
  if (options.enabledOnly) q = q.eq("enabled", true);
  const { data, error } = await q;
  if (error) throw new Error(`Không đọc được cấu hình thông báo hàng hoàn: ${error.message}`);
  return (data ?? []).map((s) => ({
    id: s.id,
    shopId: s.shop_id,
    name: s.name,
    enabled: s.enabled,
    timezone: s.timezone,
    carrierFilter: s.carrier_filter,
    operationTypeFilter: s.operation_type_filter,
    includeDelta: s.include_delta,
    includeDetail: s.include_detail,
    presyncMinutes: s.presync_minutes,
    schedules: ((s.return_notification_schedules ?? []) as Array<{ id: string; time_of_day: string; enabled: boolean; sort_order: number }>)
      .map((x) => ({ id: x.id, timeOfDay: String(x.time_of_day).slice(0, 5), enabled: x.enabled, sortOrder: x.sort_order }))
      .sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay)),
  }));
}

async function scopeShopIds(db: SupabaseClient, setting: NotificationSetting): Promise<string[]> {
  if (setting.shopId) return [setting.shopId];
  const { data, error } = await db.from("shops").select("id").eq("channel", "shopee").eq("is_active", true);
  if (error) throw new Error(error.message);
  return (data ?? []).map((s) => s.id as string);
}

const toBucket = (b: Breakdown): MessageBucket => ({
  customerReturn: { orders: b.customerReturn.orderCount, items: b.customerReturn.itemQuantity },
  failedDelivery: { orders: b.failedDeliveryReturn.orderCount, items: b.failedDeliveryReturn.itemQuantity },
  total: { orders: b.total.orderCount, items: b.total.itemQuantity },
});

/** Summary → message carriers: windows already started by the slot (current one marked), outside bucket only when non-empty. */
export function toMessageCarriers(summary: DailySummary, slot: string): MessageCarrier[] {
  const slotMin = toMinutes(slot) ?? 24 * 60;
  return summary.carrierGroups.map((g) => {
    const windows = g.deliveryWindows
      .filter((w) => !w.isOutside && (toMinutes(w.startTime ?? "") ?? 0) <= slotMin)
      .map((w) => ({ ...toBucket(w), name: w.name, startTime: w.startTime ?? "", endTime: w.endTime ?? "", current: slotMin <= (toMinutes(w.endTime ?? "") ?? 0) }));
    const outside = g.deliveryWindows.find((w) => w.isOutside && w.total.orderCount > 0);
    return { carrier: g.label, windows, outside: outside ? toBucket(outside) : null, total: toBucket(g) };
  });
}

export interface GeneratedRun {
  runId: string;
  settingId: string;
  slot: string;
  status: "sent" | "partial" | "failed" | "no_recipients";
  totalOrders: number;
  newOrders: number | null;
  error?: string;
}

/** Builds + sends one claimed run. Throws only on DB errors (the caller records them). */
export async function generateNotificationRun(
  db: SupabaseClient,
  input: { runId: string; setting: NotificationSetting; date: string; slot: string; send: NotificationSender; staleMinutes: number; now: Date },
): Promise<GeneratedRun> {
  const { runId, setting, date, slot } = input;
  const { data: snap, error } = await db.rpc("snapshot_return_notification_run", { p_run_id: runId, p_sample_limit: 10 });
  if (error) throw new Error(`snapshot: ${error.message}`);
  const s = snap as { total_orders: number; previous_run_id: string | null; previous_time: string | null; new_orders: number | null; new_items: string | null; sample_order_sns: string[] };
  const shopIds = await scopeShopIds(db, setting);
  const [summary, freshness] = await Promise.all([
    getDailyReturnOperationsSummary(db, { date, shopId: setting.shopId, carrier: setting.carrierFilter, operationType: setting.operationTypeFilter }, { scopeShopIds: shopIds, windows: await loadDeliveryWindows(db) }),
    getReturnSyncFreshness(db, shopIds, input.staleMinutes, input.now),
  ]);
  const delta: MessageDelta | null = !setting.includeDelta
    ? null
    : s.previous_run_id
      ? { kind: "since_previous", previousTime: s.previous_time ?? "", newOrders: s.new_orders ?? 0, newItems: s.new_items ?? "0", sampleOrderSns: s.sample_order_sns ?? [] }
      : { kind: "first_of_day" };
  const relevant = freshness.filter((f) => setting.operationTypeFilter !== "customer_return" || f.syncType !== "failed_delivery").filter((f) => setting.operationTypeFilter !== "failed_delivery_return" || f.syncType !== "return_logistics");
  const oldest = relevant.reduce<string | null>((acc, f) => (f.lastSyncedAt && (!acc || f.lastSyncedAt < acc) ? f.lastSyncedAt : acc), null);
  const staleAge = relevant.some((f) => f.stale) ? Math.max(...relevant.map((f) => f.ageMinutes ?? 0)) : null;
  const message = formatReturnNotificationMessage({
    date,
    slot,
    carriers: toMessageCarriers(summary, slot),
    total: toBucket(summary),
    delta,
    includeDetail: setting.includeDetail,
    typeFilter: setting.operationTypeFilter,
    dataAsOf: oldest,
    staleMinutes: staleAge,
  });

  const result = await input.send({ message, dedupeKey: `${RETURN_NOTIFICATION_EVENT}:${runId}`, runId });
  const status: GeneratedRun["status"] = result.totalRecipients === 0 ? "no_recipients" : result.sentCount === 0 ? "failed" : result.failedCount > 0 ? "partial" : "sent";
  const { error: upErr } = await db
    .from("return_notification_runs")
    .update({ message_text: message, recipients_total: result.totalRecipients, recipients_sent: result.sentCount, status, error: status === "failed" ? "Không gửi được cho người nhận nào." : null })
    .eq("id", runId);
  if (upErr) throw new Error(`finish run: ${upErr.message}`);
  return { runId, settingId: setting.id, slot, status, totalOrders: s.total_orders, newOrders: s.new_orders };
}

export interface NotificationTickResult {
  presyncEnqueued: number;
  generated: GeneratedRun[];
  failures: Array<{ settingId: string; slot?: string; message: string }>;
}

export async function runReturnNotificationTick(
  db: SupabaseClient,
  deps: { send: NotificationSender; enqueuePresync: PresyncEnqueuer; now?: Date; staleMinutes?: number },
): Promise<NotificationTickResult> {
  const now = deps.now ?? new Date();
  const result: NotificationTickResult = { presyncEnqueued: 0, generated: [], failures: [] };
  let settings: NotificationSetting[];
  try {
    settings = await loadNotificationSettings(db, { enabledOnly: true });
  } catch (err) {
    result.failures.push({ settingId: "*", message: err instanceof Error ? err.message : String(err) });
    return result;
  }
  for (const setting of settings) {
    const date = businessDateOf(now, setting.timezone);
    const local = localTimeOf(now, setting.timezone);
    try {
      const pre = presyncSlots(setting.schedules, local, setting.presyncMinutes);
      if (pre.length > 0) {
        const shopIds = await scopeShopIds(db, setting);
        const slotMin = Math.min(...pre.map((p) => toMinutes(p.timeOfDay)!));
        const windowStartMs = now.getTime() - ((toMinutes(local.slice(0, 5))! - (slotMin - setting.presyncMinutes)) * 60_000 + Number(local.slice(6, 8)) * 1000);
        const fresh = await getReturnSyncFreshness(db, shopIds, deps.staleMinutes ?? 30, now);
        if (fresh.some((f) => !f.lastSyncedAt || new Date(f.lastSyncedAt).getTime() < windowStartMs)) {
          result.presyncEnqueued += await deps.enqueuePresync({ shopIds, focusDate: date });
        }
      }
      for (const slot of dueSlots(setting.schedules, local)) {
        const { data: runId, error } = await db.rpc("claim_return_notification_run", { p_setting_id: setting.id, p_business_date: date, p_scheduled_time: slot.timeOfDay });
        if (error) throw new Error(`claim: ${error.message}`);
        if (!runId) continue;
        try {
          result.generated.push(await generateNotificationRun(db, { runId: runId as string, setting, date, slot: slot.timeOfDay, send: deps.send, staleMinutes: deps.staleMinutes ?? 30, now }));
        } catch (err) {
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          await db.from("return_notification_runs").update({ status: "failed", error: message }).eq("id", runId as string);
          result.failures.push({ settingId: setting.id, slot: slot.timeOfDay, message });
        }
      }
    } catch (err) {
      result.failures.push({ settingId: setting.id, message: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    }
  }
  return result;
}

/** Settings-page preview: the message as it would read now (no run persisted, no delta). */
export async function previewNotificationMessage(db: SupabaseClient, setting: NotificationSetting, now: Date = new Date(), staleMinutes = 30): Promise<string> {
  const date = businessDateOf(now, setting.timezone);
  const slot = localTimeOf(now, setting.timezone).slice(0, 5);
  const shopIds = await scopeShopIds(db, setting);
  const [summary, freshness] = await Promise.all([
    getDailyReturnOperationsSummary(db, { date, shopId: setting.shopId, carrier: setting.carrierFilter, operationType: setting.operationTypeFilter }, { scopeShopIds: shopIds }),
    getReturnSyncFreshness(db, shopIds, staleMinutes, now),
  ]);
  const oldest = freshness.reduce<string | null>((acc, f) => (f.lastSyncedAt && (!acc || f.lastSyncedAt < acc) ? f.lastSyncedAt : acc), null);
  return formatReturnNotificationMessage({
    date,
    slot,
    carriers: toMessageCarriers(summary, slot),
    total: toBucket(summary),
    delta: null,
    includeDetail: false,
    typeFilter: setting.operationTypeFilter,
    dataAsOf: oldest,
    staleMinutes: freshness.some((f) => f.stale) ? Math.max(...freshness.map((f) => f.ageMinutes ?? 0)) : null,
  });
}
