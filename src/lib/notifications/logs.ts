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

// "Lịch sử gửi gần đây" (Phần 7) — latest N only, no full reporting/paging
// per the phase spec. recipient name comes from a left join so a row still
// reads fine even after its recipient was deleted (recipient_id -> NULL).
export async function getRecentNotificationLogs(limit: number): Promise<{
  rows: NotificationLogRow[];
  error: boolean;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("notification_logs")
    .select(
      "id, event_type, recipient_id, recipient_zalo_uid, message_text, status, provider_error_code, provider_error_message, sent_at, created_at, notification_recipients(name)"
    )
    .order("created_at", { ascending: false })
    .limit(limit);

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
