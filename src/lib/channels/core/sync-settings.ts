// ============================================================
// PATCH orders-sync cutoff (migration 00055): channel_sync_settings, one
// row. orders_from = only channel orders created at/after it are synced
// (order job here, escrow job inside its candidate RPCs). NULL = all.
//
// Takes the DB client as a parameter (service-role on the server, injected
// in tests).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export async function getOrdersSyncFrom(db: SupabaseClient): Promise<Date | null> {
  const { data, error } = await db.from("channel_sync_settings").select("orders_from").eq("id", true).maybeSingle<{ orders_from: string | null }>();
  if (error) throw new Error(`Không đọc được cấu hình đồng bộ: ${error.message}`);
  return data?.orders_from ? new Date(data.orders_from) : null;
}
