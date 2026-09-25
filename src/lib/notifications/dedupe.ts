import { createAdminClient } from "@/lib/supabase/admin";

export type DedupeCheckParams = {
  eventType: string;
  recipientId: string;
  dedupeKey: string | null | undefined;
};

// No dedupeKey -> always allowed to send (matches the phase spec: "Nếu
// dedupeKey = null: không dedupe"). With a dedupeKey, checks whether a
// 'sent' log already exists for this exact (event_type, recipient_id,
// dedupe_key) triple — mirrors the partial unique index in migration 00029,
// which is the hard backstop; this is the fast-path check sendNotification()
// uses before even attempting a send.
export async function hasNotificationBeenSent(params: DedupeCheckParams): Promise<boolean> {
  if (!params.dedupeKey) return false;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("notification_logs")
    .select("id")
    .eq("event_type", params.eventType)
    .eq("recipient_id", params.recipientId)
    .eq("dedupe_key", params.dedupeKey)
    .eq("status", "sent")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Không thể kiểm tra trạng thái gửi trùng: ${error.message}`);
  }

  return !!data;
}
