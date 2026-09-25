import { createAdminClient } from "@/lib/supabase/admin";

export type NotificationRecipient = {
  id: string;
  name: string;
  zaloUid: string;
};

export type NotificationRecipientRow = NotificationRecipient & {
  isActive: boolean;
  createdAt: string;
};

// The only recipient source sendNotification() reads from — no env var, no
// hardcoded UID. Ordered by created_at so the small (2-3 row) admin table
// and every send loop iterate in a stable, predictable order.
export async function getActiveNotificationRecipients(): Promise<NotificationRecipient[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("notification_recipients")
    .select("id, name, zalo_uid")
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Không thể tải danh sách người nhận thông báo: ${error.message}`);
  }

  return (data ?? []).map((r) => ({ id: r.id, name: r.name, zaloUid: r.zalo_uid }));
}

// Includes inactive rows too — for the admin management table (Phần 7),
// which needs to show and toggle every recipient, not just active ones.
export async function getAllNotificationRecipients(): Promise<{
  rows: NotificationRecipientRow[];
  error: boolean;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("notification_recipients")
    .select("id, name, zalo_uid, is_active, created_at")
    .order("created_at", { ascending: true });

  if (error) {
    return { rows: [], error: true };
  }

  return {
    rows: (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      zaloUid: r.zalo_uid,
      isActive: r.is_active,
      createdAt: r.created_at,
    })),
    error: false,
  };
}
