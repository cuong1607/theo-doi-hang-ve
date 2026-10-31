// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part B): ConversationStore on Supabase
// (service-role client; tables of migration 00069). No "server-only" marker
// so integration tests can import it; server wiring is in ./server.ts.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ConversationIntent } from "./router.ts";
import type { ConversationChannel, ConversationContextData, ConversationRecord, ConversationStore, ProductCandidate, ShopRef, UserLink } from "./service.ts";

type ConversationRow = { id: string; internal_user_id: string | null; current_shop_id: string | null; last_intent: string | null; context: ConversationContextData | null };

const toRecord = (r: ConversationRow): ConversationRecord => ({
  id: r.id,
  internalUserId: r.internal_user_id,
  currentShopId: r.current_shop_id,
  lastIntent: (r.last_intent as ConversationIntent | null) ?? null,
  context: r.context ?? {},
});

function check(error: { message: string; code?: string } | null, what: string): void {
  if (error) throw new Error(`conversation store: ${what} failed (${error.code ?? "?"})`);
}

export class SupabaseConversationStore implements ConversationStore {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async findLink(channel: ConversationChannel, externalUserId: string): Promise<UserLink | null> {
    if (channel !== "zalo") return null;
    const { data, error } = await this.db
      .from("zalo_user_links")
      .select("internal_user_id, status, profiles!inner(is_active, role)")
      .eq("zalo_user_id", externalUserId)
      .maybeSingle();
    check(error, "findLink");
    if (!data) return null;
    const p = data.profiles as unknown as { is_active: boolean; role: string | null };
    return { internalUserId: data.internal_user_id as string, status: data.status as UserLink["status"], profileActive: !!p?.is_active, role: p?.role ?? null };
  }

  async upsertConversation(channel: ConversationChannel, externalUserId: string, internalUserId: string | null): Promise<ConversationRecord> {
    const cols = "id, internal_user_id, current_shop_id, last_intent, context";
    const { data: existing, error } = await this.db.from("ai_conversations").select(cols).eq("channel", channel).eq("external_user_id", externalUserId).maybeSingle<ConversationRow>();
    check(error, "readConversation");
    if (existing) {
      if (existing.internal_user_id !== internalUserId) {
        // link changed (linked / revoked): the stored context of another identity is not carried over
        const { error: upd } = await this.db.from("ai_conversations").update({ internal_user_id: internalUserId, current_shop_id: null, current_product_id: null }).eq("id", existing.id);
        check(upd, "relinkConversation");
        return toRecord({ ...existing, internal_user_id: internalUserId, current_shop_id: null });
      }
      return toRecord(existing);
    }
    const { data, error: ins } = await this.db
      .from("ai_conversations")
      .upsert({ channel, external_user_id: externalUserId, internal_user_id: internalUserId }, { onConflict: "channel,external_user_id", ignoreDuplicates: false })
      .select(cols)
      .single<ConversationRow>();
    check(ins, "insertConversation");
    return toRecord(data!);
  }

  async insertInboundMessage(input: { conversationId: string; channel: ConversationChannel; providerMessageId: string; text: string; intent: string | null }) {
    const { data, error } = await this.db
      .from("ai_messages")
      .insert({ conversation_id: input.conversationId, channel: input.channel, direction: "inbound", provider_message_id: input.providerMessageId, text: input.text, intent: input.intent, processing_status: "pending" })
      .select("id")
      .single<{ id: string }>();
    if (error?.code === "23505") return { inserted: false as const }; // redelivered webhook
    check(error, "insertInbound");
    return { inserted: true as const, id: data!.id };
  }

  async setInboundStatus(messageId: string, status: string, errorCode: string | null = null): Promise<void> {
    const { error } = await this.db.from("ai_messages").update({ processing_status: status, error_code: errorCode }).eq("id", messageId);
    check(error, "setInboundStatus");
  }

  async insertOutboundMessage(input: { conversationId: string; channel: ConversationChannel; text: string; status: "sent" | "failed"; providerMessageId: string | null; errorCode: string | null }): Promise<void> {
    const { error } = await this.db.from("ai_messages").insert({
      conversation_id: input.conversationId,
      channel: input.channel,
      direction: "outbound",
      provider_message_id: input.providerMessageId,
      text: input.text.slice(0, 4000),
      processing_status: input.status,
      error_code: input.errorCode,
    });
    check(error, "insertOutbound");
  }

  async updateConversation(id: string, patch: { currentShopId?: string | null; currentProductId?: string | null; lastIntent?: ConversationIntent | null; context?: ConversationContextData; internalUserId?: string | null }): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.currentShopId !== undefined) row.current_shop_id = patch.currentShopId;
    if (patch.currentProductId !== undefined) row.current_product_id = patch.currentProductId;
    if (patch.lastIntent !== undefined) row.last_intent = patch.lastIntent;
    if (patch.context !== undefined) row.context = patch.context;
    if (patch.internalUserId !== undefined) row.internal_user_id = patch.internalUserId;
    if (!Object.keys(row).length) return;
    const { error } = await this.db.from("ai_conversations").update(row).eq("id", id);
    check(error, "updateConversation");
  }

  async allowedShops(internalUserId: string): Promise<ShopRef[]> {
    const { data, error } = await this.db.from("ai_user_shop_access").select("shop_id, shops!inner(shop_name, is_active)").eq("internal_user_id", internalUserId);
    check(error, "allowedShops");
    return (data ?? [])
      .map((r) => ({ id: r.shop_id as string, s: r.shops as unknown as { shop_name: string; is_active: boolean } }))
      .filter((r) => r.s?.is_active)
      .map((r) => ({ id: r.id, name: r.s.shop_name }));
  }

  async findProducts(shopId: string): Promise<ProductCandidate[]> {
    const out: ProductCandidate[] = [];
    // ≤ 1000 rows per response (PostgREST cap) → paged
    for (let page = 0; page < 10; page++) {
      const { data, error } = await this.db.from("shopee_products").select("id, provider_item_id, name, sku").eq("shop_id", shopId).order("provider_item_id").range(page * 1000, page * 1000 + 999);
      check(error, "findProducts");
      const rows = (data ?? []) as Array<{ id: string; provider_item_id: string; name: string | null; sku: string | null }>;
      out.push(...rows.map((r) => ({ id: r.id, itemId: r.provider_item_id, name: r.name, sku: r.sku })));
      if (rows.length < 1000) break;
    }
    return out;
  }

  async allShops(): Promise<ShopRef[]> {
    const { data, error } = await this.db.from("shops").select("id, shop_name").eq("is_active", true);
    check(error, "allShops");
    return (data ?? []).map((s) => ({ id: s.id as string, name: s.shop_name as string }));
  }

  async consumeLinkCode(codeHash: string, externalUserId: string, now: Date): Promise<{ internalUserId: string } | null> {
    // single conditional UPDATE: unused + unexpired → used (two deliveries cannot both win)
    const { data, error } = await this.db
      .from("zalo_link_codes")
      .update({ used_at: now.toISOString(), used_by_zalo_user_id: externalUserId })
      .eq("code_hash", codeHash)
      .is("used_at", null)
      .gt("expires_at", now.toISOString())
      .select("internal_user_id")
      .maybeSingle<{ internal_user_id: string }>();
    check(error, "consumeLinkCode");
    return data ? { internalUserId: data.internal_user_id } : null;
  }

  async createLink(channel: ConversationChannel, externalUserId: string, internalUserId: string): Promise<void> {
    if (channel !== "zalo") throw new Error("unsupported channel");
    const { error } = await this.db
      .from("zalo_user_links")
      .upsert({ zalo_user_id: externalUserId, internal_user_id: internalUserId, status: "active", linked_at: new Date().toISOString(), revoked_at: null }, { onConflict: "zalo_user_id" });
    check(error, "createLink");
  }

  async profile(internalUserId: string): Promise<{ active: boolean; role: string | null } | null> {
    const { data, error } = await this.db.from("profiles").select("is_active, role").eq("id", internalUserId).maybeSingle<{ is_active: boolean; role: string | null }>();
    check(error, "profile");
    return data ? { active: data.is_active, role: data.role } : null;
  }

  /** Admin side: issue a one-time code (hash only is stored). */
  async createLinkCode(input: { codeHash: string; internalUserId: string; createdBy: string | null; expiresAt: Date }): Promise<void> {
    const { error } = await this.db.from("zalo_link_codes").insert({ code_hash: input.codeHash, internal_user_id: input.internalUserId, created_by: input.createdBy, expires_at: input.expiresAt.toISOString() });
    check(error, "createLinkCode");
  }
}
