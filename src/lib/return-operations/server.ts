// ============================================================
// PHASE SHOPEE-6B: production wiring of the return-operation notification
// tick — Zalo through the shared notification service (dedupe, per-recipient
// logs, error isolation) and pre-sync through the Shopee job queue.
// ============================================================
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { requestShopeeSync } from "@/lib/channels/shopee/sync-service";
import { sendNotification } from "@/lib/notifications/service";

import { PRESYNC_SYNC_TYPES, RETURN_NOTIFICATION_EVENT, runReturnNotificationTick, type NotificationSender, type NotificationTickResult, type PresyncEnqueuer } from "./notifications";
import { loadReturnOperationSettings } from "./queries";

export const zaloReturnNotificationSender: NotificationSender = async ({ message, dedupeKey, runId }) => {
  const r = await sendNotification({ eventType: RETURN_NOTIFICATION_EVENT, message, entityType: "return_notification_run", entityId: runId, dedupeKey });
  return { totalRecipients: r.totalRecipients, sentCount: r.sentCount, failedCount: r.failedCount };
};

export function queuePresync(db: SupabaseClient): PresyncEnqueuer {
  return async ({ shopIds, focusDate }) => {
    const allow = getSyncConfig().shopAllowlist;
    let created = 0;
    for (const shopId of shopIds) {
      if (allow && !allow.includes(shopId)) continue;
      for (const syncType of PRESYNC_SYNC_TYPES) {
        try {
          const job = await requestShopeeSync(db, { shopId, syncType, mode: "manual", focusDate });
          if (job.created) created++;
        } catch (err) {
          console.error(JSON.stringify({ source: "return-notifications", event: "presync_enqueue_failed", shopId, syncType, message: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
        }
      }
    }
    return created;
  };
}

/** Never throws (runs inside the scheduler tick). */
export async function runReturnNotificationTickSafe(db: SupabaseClient, now: Date = new Date()): Promise<NotificationTickResult | null> {
  try {
    const settings = await loadReturnOperationSettings(db);
    const result = await runReturnNotificationTick(db, { send: zaloReturnNotificationSender, enqueuePresync: queuePresync(db), now, staleMinutes: settings.syncStaleWarnMinutes });
    if (result.presyncEnqueued > 0 || result.generated.length > 0 || result.failures.length > 0) {
      console.info(JSON.stringify({ source: "return-notifications", event: "notification_tick", presyncEnqueued: result.presyncEnqueued, generated: result.generated.map((g) => `${g.slot}:${g.status}:${g.totalOrders}`), failures: result.failures }));
    }
    return result;
  } catch (err) {
    console.error(JSON.stringify({ source: "return-notifications", event: "notification_tick_failed", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return null;
  }
}
