"use server";

// SHOPEE-PRODUCT-ANALYTICS-1 (part B): self-service Zalo linking for the
// early rollout (admin only, integration:manage). An admin links THEIR OWN
// Zalo account and chooses which shops the conversation agent may answer
// about for them. The one-time code is returned once and stored as a hash.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { generateLinkCode } from "@/lib/conversation/service";
import { SupabaseConversationStore } from "@/lib/conversation/supabase-store";
import { createAdminClient } from "@/lib/supabase/admin";

const PATH = "/settings/zalo-agent";

export type LinkCodeResult = { ok: true; code: string; expiresAt: string } | { ok: false; message: string };

export async function createMyZaloLinkCode(): Promise<LinkCodeResult> {
  const authz = await authorizeAction("integration:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const now = new Date();
  const { code, codeHash, expiresAt } = generateLinkCode(now);
  await new SupabaseConversationStore(createAdminClient()).createLinkCode({ codeHash, internalUserId: authz.auth.user.id, createdBy: authz.auth.user.id, expiresAt });
  console.info(JSON.stringify({ source: "zalo-agent", event: "link_code_created", by: authz.auth.user.id }));
  return { ok: true, code, expiresAt: expiresAt.toISOString() };
}

export async function revokeMyZaloLink(input: { linkId: string }): Promise<{ ok: boolean; message: string }> {
  const authz = await authorizeAction("integration:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = z.object({ linkId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Liên kết không hợp lệ." };
  const { error } = await createAdminClient()
    .from("zalo_user_links")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", parsed.data.linkId)
    .eq("internal_user_id", authz.auth.user.id);
  if (error) return { ok: false, message: "Không thu hồi được liên kết." };
  revalidatePath(PATH);
  return { ok: true, message: "Đã thu hồi liên kết." };
}

export async function setMyAgentShops(input: { shopIds: string[] }): Promise<{ ok: boolean; message: string }> {
  const authz = await authorizeAction("integration:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = z.object({ shopIds: z.array(z.string().uuid()).max(50) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Danh sách shop không hợp lệ." };
  const db = createAdminClient();
  const userId = authz.auth.user.id;
  const { error: del } = await db.from("ai_user_shop_access").delete().eq("internal_user_id", userId);
  if (del) return { ok: false, message: "Không lưu được quyền shop." };
  if (parsed.data.shopIds.length) {
    const { error } = await db.from("ai_user_shop_access").insert(parsed.data.shopIds.map((shopId) => ({ internal_user_id: userId, shop_id: shopId, granted_by: userId })));
    if (error) return { ok: false, message: "Không lưu được quyền shop." };
  }
  revalidatePath(PATH);
  return { ok: true, message: "Đã lưu quyền shop cho trợ lý." };
}
