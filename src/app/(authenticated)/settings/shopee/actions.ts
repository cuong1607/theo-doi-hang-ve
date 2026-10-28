"use server";

// SHOPEE-ADS-0: intentional disconnect of a shop (admin). The shop row and
// all its historical data stay; the stored tokens are wiped and the
// connection marked "disconnected" — the scheduler / token keepalive skip it
// until an admin reconnects it through OAuth.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: boolean; message: string };

export async function disconnectShopAction(shopId: string): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!z.string().uuid().safeParse(shopId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const { data, error } = await createAdminClient()
    .from("shop_connections")
    .update({ connection_status: "disconnected", access_token_encrypted: null, refresh_token_encrypted: null, access_token_expires_at: null, last_error_code: null, last_error_message: null })
    .eq("shop_id", shopId)
    .select("shop_id");
  if (error) {
    console.error(JSON.stringify({ source: "shopee-settings", event: "disconnect_failed", message: error.message.slice(0, 200) }));
    return { ok: false, message: "Không ngắt được kết nối." };
  }
  if ((data ?? []).length === 0) return { ok: false, message: "Shop chưa có kết nối." };
  console.info(JSON.stringify({ source: "shopee-settings", event: "shop_disconnected", shopId, by: authz.auth.user.id }));
  revalidatePath("/settings/shopee");
  return { ok: true, message: "Đã ngắt kết nối. Dữ liệu cũ vẫn giữ; bấm “Kết nối lại” để ủy quyền lại." };
}
