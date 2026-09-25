import { createAdminClient } from "@/lib/supabase/admin";

export type NotificationLogStatus = "pending" | "sent" | "failed" | "skipped";

export type NotificationLogRow = {
  id: string;
  eventType: string;
  recipientId: string | null;
  recipientZaloUid: string;
  recipientName: string | null; // null if the recipient row was later deleted
  messageText: string;
  status: NotificationLogStatus;
  providerErrorCode: string | null;
  providerErrorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
};

// Known event types so far (ZL2's manual test-all, ZL3/ZL5's daily
// summaries, ZL4's low-stock alert) — hardcoded rather than a DISTINCT
// query, same convention as other fixed dropdowns in this codebase (e.g.
// SHIFT_OPTIONS). Add a new value here whenever a new business event ships.
export const NOTIFICATION_EVENT_TYPES = [
  "TEST_ALL_RECIPIENTS",
  "TEST_SINGLE_RECIPIENT",
  "DAILY_RECEIPT_SUMMARY",
  "DAILY_PAYMENT_SUMMARY",
  "LOW_STOCK_ALERT",
] as const;

export type NotificationLogFilters = {
  date?: string; // YYYY-MM-DD, interpreted as a full day in Asia/Ho_Chi_Minh
  eventType?: string;
  recipientId?: string;
  status?: NotificationLogStatus;
};

// VN has no DST (UTC+7 year-round, same fact ZL6 documents for the cron
// schedule) so this offset is always exactly 7h, no seasonal table needed.
function vnDateToUtcRange(date: string): { startIso: string; endIso: string } {
  const start = new Date(`${date}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// "Lịch sử gửi gần đây" (Phần 7 của ZL2, mở rộng filter ở Phần 1 của ZL7) —
// latest N only, no full reporting/paging per the original ZL2 spec.
// recipient name comes from a left join so a row still reads fine even
// after its recipient was deleted (recipient_id -> NULL).
export async function getNotificationLogs(
  filters: NotificationLogFilters,
  limit: number
): Promise<{ rows: NotificationLogRow[]; error: boolean }> {
  const supabase = createAdminClient();

  let query = supabase
    .from("notification_logs")
    .select(
      "id, event_type, recipient_id, recipient_zalo_uid, message_text, status, provider_error_code, provider_error_message, sent_at, created_at, notification_recipients(name)"
    );

  if (filters.eventType) query = query.eq("event_type", filters.eventType);
  if (filters.recipientId) query = query.eq("recipient_id", filters.recipientId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.date) {
    const { startIso, endIso } = vnDateToUtcRange(filters.date);
    query = query.gte("created_at", startIso).lt("created_at", endIso);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);

  if (error) {
    return { rows: [], error: true };
  }

  const rows = (data ?? []) as unknown as {
    id: string;
    event_type: string;
    recipient_id: string | null;
    recipient_zalo_uid: string;
    message_text: string;
    status: NotificationLogStatus;
    provider_error_code: string | null;
    provider_error_message: string | null;
    sent_at: string | null;
    created_at: string;
    notification_recipients: { name: string } | null;
  }[];

  return {
    rows: rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      recipientId: r.recipient_id,
      recipientZaloUid: r.recipient_zalo_uid,
      recipientName: r.notification_recipients?.name ?? null,
      messageText: r.message_text,
      status: r.status,
      providerErrorCode: r.provider_error_code,
      providerErrorMessage: r.provider_error_message,
      sentAt: r.sent_at,
      createdAt: r.created_at,
    })),
    error: false,
  };
}

// Back-compat wrapper — some call sites just want the latest N with no
// filters.
export async function getRecentNotificationLogs(limit: number) {
  return getNotificationLogs({}, limit);
}
