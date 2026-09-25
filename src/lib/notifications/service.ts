// ============================================================
// PHASE ZL2: The single place that actually fans a notification out to
// every active recipient. No business event (daily receipt summary, low
// stock, payment summary — all future phases) should ever call
// sendZaloTextMessage() directly; they call sendNotification() here so
// dedup, logging, and per-recipient error isolation are never duplicated.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendZaloTextMessage } from "@/lib/zalo/messages";
import { hasNotificationBeenSent } from "./dedupe";
import { getActiveNotificationRecipients, type NotificationRecipient } from "./recipients";
import type { NotificationLogStatus } from "./logs";

export type SendNotificationInput = {
  eventType: string;
  message: string;
  entityType?: string;
  entityId?: string;
  // See dedupe.ts / migration 00029 for the exact semantics. Omit entirely
  // for a one-off/manual send (e.g. the "gửi test cho tất cả" button) that
  // should always go through.
  dedupeKey?: string;
  // PHẦN 7 (ZL7) — "test 1 recipient": when set, only these (still must be
  // active) recipients are notified instead of every active recipient.
  // Omit entirely for the normal "everyone active" fan-out.
  recipientIds?: string[];
};

export type NotificationRecipientResult = {
  recipientId: string;
  recipientName: string;
  status: Extract<NotificationLogStatus, "sent" | "failed" | "skipped">;
  errorCode?: string;
};

export type SendNotificationResult = {
  // `success` describes whether the SEND FLOW ran to completion for every
  // recipient without an unexpected system-level failure (e.g. it never
  // throws just because Zalo rejected a message for one or all recipients
  // — those are captured per-recipient in `results`/`failedCount` instead).
  // A caller that wants to know "did anyone actually receive it" should
  // look at `sentCount`, not `success`.
  success: boolean;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  results: NotificationRecipientResult[];
};

async function insertLog(
  supabase: ReturnType<typeof createAdminClient>,
  params: {
    eventType: string;
    recipient: NotificationRecipient;
    entityType?: string;
    entityId?: string;
    dedupeKey?: string;
    message: string;
    status: NotificationLogStatus;
  }
) {
  return supabase
    .from("notification_logs")
    .insert({
      event_type: params.eventType,
      recipient_id: params.recipient.id,
      recipient_zalo_uid: params.recipient.zaloUid,
      entity_type: params.entityType ?? null,
      entity_id: params.entityId ?? null,
      dedupe_key: params.dedupeKey ?? null,
      message_text: params.message,
      status: params.status,
    })
    .select("id")
    .single();
}

// Sends `message` to every active recipient (Phần 2's
// getActiveNotificationRecipients). One recipient's failure never aborts the
// others — each is wrapped independently (Phần 3, point 8): 3 recipients
// where the 2nd fails still yields sentCount=2, failedCount=1, not a
// rolled-back all-or-nothing result.
export async function sendNotification(input: SendNotificationInput): Promise<SendNotificationResult> {
  const allActiveRecipients = await getActiveNotificationRecipients();
  const recipients = input.recipientIds
    ? allActiveRecipients.filter((r) => input.recipientIds!.includes(r.id))
    : allActiveRecipients;

  // PHẦN 6 (ZL7) — OBSERVABILITY: event generated + recipients found, on
  // every call site (not just the cron routes' own start/completed logs
  // from ZL6). Never logs the message text or any token.
  console.log(`[notify] event=${input.eventType} recipientsFound=${recipients.length}`);

  if (recipients.length === 0) {
    // Not an error — there's simply nothing configured to notify yet.
    return { success: true, totalRecipients: 0, sentCount: 0, failedCount: 0, skippedCount: 0, results: [] };
  }

  const supabase = createAdminClient();
  const results: NotificationRecipientResult[] = [];
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  // PHẦN 5 (ZL7) — RATE LIMIT / SEND CONTROL: deliberately sequential (one
  // `await` per recipient, never Promise.all/allSettled). With only 2-3
  // recipients a queue is overkill, but firing every send in parallel would
  // still be N uncontrolled concurrent requests to Zalo's API per
  // notification — this keeps it to at most 1 in flight at a time.
  for (const recipient of recipients) {
    if (input.dedupeKey) {
      const alreadySent = await hasNotificationBeenSent({
        eventType: input.eventType,
        recipientId: recipient.id,
        dedupeKey: input.dedupeKey,
      });
      if (alreadySent) {
        // A skipped log is still written (Phần 5: "Ưu tiên có log skipped
        // nếu hữu ích cho debug") — visible in "Lịch sử gửi gần đây" so an
        // admin can tell a dedupe suppressed a send, not that it silently
        // never ran.
        await insertLog(supabase, {
          eventType: input.eventType,
          recipient,
          entityType: input.entityType,
          entityId: input.entityId,
          dedupeKey: input.dedupeKey,
          message: input.message,
          status: "skipped",
        });
        results.push({ recipientId: recipient.id, recipientName: recipient.name, status: "skipped" });
        skippedCount++;
        continue;
      }
    }

    const { data: pendingLog, error: insertError } = await insertLog(supabase, {
      eventType: input.eventType,
      recipient,
      entityType: input.entityType,
      entityId: input.entityId,
      dedupeKey: input.dedupeKey,
      message: input.message,
      status: "pending",
    });

    if (insertError || !pendingLog) {
      // Couldn't even record the attempt — surface it as a failure for this
      // recipient rather than skipping them silently or aborting everyone.
      results.push({
        recipientId: recipient.id,
        recipientName: recipient.name,
        status: "failed",
        errorCode: "log_insert_failed",
      });
      failedCount++;
      continue;
    }

    // sendZaloTextMessage() is designed to never throw (it returns a
    // structured { success: false, ... } on every failure path) — the
    // try/catch here is a defensive backstop only, so a truly unexpected
    // exception still counts as this recipient's failure instead of
    // aborting the remaining recipients in the loop.
    let sendResult;
    try {
      sendResult = await sendZaloTextMessage({ recipientId: recipient.zaloUid, text: input.message });
    } catch (err) {
      sendResult = {
        success: false as const,
        errorCode: "unexpected_error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (sendResult.success) {
      await supabase
        .from("notification_logs")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          provider_message_id: sendResult.providerMessageId ?? null,
        })
        .eq("id", pendingLog.id);
      results.push({ recipientId: recipient.id, recipientName: recipient.name, status: "sent" });
      sentCount++;
    } else {
      await supabase
        .from("notification_logs")
        .update({
          status: "failed",
          provider_error_code: sendResult.errorCode ?? null,
          provider_error_message: sendResult.errorMessage ?? null,
        })
        .eq("id", pendingLog.id);
      results.push({
        recipientId: recipient.id,
        recipientName: recipient.name,
        status: "failed",
        errorCode: sendResult.errorCode,
      });
      failedCount++;
    }
  }

  console.log(
    `[notify] event=${input.eventType} completed sent=${sentCount} failed=${failedCount} skipped=${skippedCount}`
  );

  return { success: true, totalRecipients: recipients.length, sentCount, failedCount, skippedCount, results };
}

export type RetryNotificationResult =
  | { success: true; status: "sent"; providerMessageId?: string }
  | { success: false; status: "failed"; errorCode?: string; errorMessage?: string }
  | { success: false; status: "not_found" | "not_retryable"; errorMessage: string };

// PHẦN 6 — retry foundation: single manual retry, no auto-retry loop, no
// background worker. Re-sends to the log's own recipient_zalo_uid (already
// denormalized on the row — see migration 00029), so this still works even
// if the recipient was deleted afterward.
export async function retryFailedNotification(logId: string): Promise<RetryNotificationResult> {
  const supabase = createAdminClient();

  // PHẦN 6 (ZL7) — OBSERVABILITY, same convention as sendNotification():
  // logId only, never the message text.
  console.log(`[notify] retry logId=${logId}`);

  const { data: log, error: fetchError } = await supabase
    .from("notification_logs")
    .select("id, status, recipient_zalo_uid, message_text")
    .eq("id", logId)
    .maybeSingle();

  if (fetchError || !log) {
    return { success: false, status: "not_found", errorMessage: "Không tìm thấy log thông báo." };
  }

  if (log.status !== "failed") {
    return {
      success: false,
      status: "not_retryable",
      errorMessage: "Chỉ có thể gửi lại thông báo đang ở trạng thái thất bại.",
    };
  }

  let sendResult;
  try {
    sendResult = await sendZaloTextMessage({ recipientId: log.recipient_zalo_uid, text: log.message_text });
  } catch (err) {
    sendResult = {
      success: false as const,
      errorCode: "unexpected_error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  if (sendResult.success) {
    await supabase
      .from("notification_logs")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: sendResult.providerMessageId ?? null,
        provider_error_code: null,
        provider_error_message: null,
      })
      .eq("id", logId);
    console.log(`[notify] retry logId=${logId} completed status=sent`);
    return { success: true, status: "sent", providerMessageId: sendResult.providerMessageId };
  }

  await supabase
    .from("notification_logs")
    .update({
      status: "failed",
      provider_error_code: sendResult.errorCode ?? null,
      provider_error_message: sendResult.errorMessage ?? null,
    })
    .eq("id", logId);
  console.log(`[notify] retry logId=${logId} completed status=failed errorCode=${sendResult.errorCode}`);
  return { success: false, status: "failed", errorCode: sendResult.errorCode, errorMessage: sendResult.errorMessage };
}
