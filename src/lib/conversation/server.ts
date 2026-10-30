// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part B): server wiring of the conversation
// service — Supabase store, Zalo outbound sender, analyst provider.
// The Zalo-specific code stays in src/lib/zalo; the service only sees the
// OutboundSender interface.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendZaloTextMessage } from "@/lib/zalo/messages";

import { getProductAnalystProvider } from "../product-analyst/provider.ts";
import type { ConversationDeps, OutboundSender } from "./service.ts";
import { SupabaseConversationStore } from "./supabase-store.ts";

/** Zalo implementation of the generic outbound abstraction (sendTextMessage). */
export const zaloOutboundSender: OutboundSender = {
  async sendText(externalUserId, text) {
    const res = await sendZaloTextMessage({ recipientId: externalUserId, text: text.slice(0, 2000) });
    if (res.success) return { ok: true, providerMessageId: res.providerMessageId ?? null };
    console.warn(JSON.stringify({ source: "conversation", event: "send_failed", channel: "zalo", errorCode: res.errorCode ?? "unknown" }));
    return { ok: false, errorCode: res.errorCode ?? "unknown" };
  },
};

export function getConversationDeps(): ConversationDeps {
  return { store: new SupabaseConversationStore(createAdminClient()), sender: zaloOutboundSender, analyst: getProductAnalystProvider() };
}
