// ============================================================
// PHASE 05 — AIChannelAdapter (SYS-11): one interface for Dashboard, Zalo OA
// and Zalo Personal. Each adapter supplies, from TRUSTED server-side input:
//   channel identity → internal user (identity.ts), conversation scope,
//   output audience (private / group), response constraints.
// The assistant then decides allowed tools from role + audience.
//
// No adapter sends anything in Phase 05:
//   web            returns the response to the page
//   zalo_oa        returns text parts a caller COULD send — not wired into the
//                  OA webhook (OAuth / webhook / token refresh / sending rules
//                  untouched); usable only with AI_SYSTEM_OA_ENABLED
//   zalo_personal  returns a DRAFT (canSend: false) for review / tests; usable
//                  only with AI_SYSTEM_PERSONAL_DRAFTS_ENABLED. Auto-sending
//                  belongs to Phase 04.5 / 07.
// Histories are never merged: each adapter passes only its own question.
// Pure + injected.
// ============================================================
import { askSystemAssistant, type AssistantDeps } from "./assistant.ts";
import { resolveOaIdentity, resolvePersonalIdentity, resolveWebIdentity, type IdentityStore } from "./identity.ts";
import type { AssistantResponse, ChannelContext, IdentityResolution, SystemChannel } from "./types.ts";

export interface AIChannelAdapter<I, O> {
  readonly channel: SystemChannel;
  /** false = the channel is switched off (feature flag): nothing is answered */
  enabled(deps: AssistantDeps): boolean;
  resolve(store: IdentityStore, input: I): Promise<{ identity: IdentityResolution; context: ChannelContext }>;
  render(response: AssistantResponse, context: ChannelContext): O;
}

// ------------------------------------------------------------------ rendering helpers

/** Plain text of a response: answer, points, sources + freshness, caveats. */
export function responseToText(r: AssistantResponse, maxChars: number): string {
  const lines: string[] = [];
  if (r.answer) lines.push(r.answer);
  for (const p of r.points) lines.push(`• ${p.text}${p.sourceIds.length ? ` [${p.sourceIds.join(", ")}]` : ""}`);
  if (r.sources.length) {
    lines.push("Nguồn:");
    for (const s of r.sources) lines.push(`[${s.id}] ${s.label} — ${s.coverage}${s.dataUpdatedAt ? `; dữ liệu cập nhật ${s.dataUpdatedAt}` : ""}`);
  }
  for (const c of r.caveats) lines.push(`Lưu ý: ${c}`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Splits text into ≤ maxPart chunks on line boundaries (Zalo message size). */
export function splitParts(text: string, maxPart: number, maxParts: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const piece = line.length > maxPart ? `${line.slice(0, maxPart - 1)}…` : line;
    if (cur && cur.length + 1 + piece.length > maxPart) {
      parts.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) parts.push(cur);
  return parts.length > maxParts ? [...parts.slice(0, maxParts - 1), `${parts[maxParts - 1]!.slice(0, maxPart - 40)}\n… (xem đầy đủ trên web)`] : parts;
}

// ------------------------------------------------------------------ web

export interface WebInput {
  /** auth.getUser() id from the server session — never a client value */
  sessionUserId: string;
}

export const webAdapter: AIChannelAdapter<WebInput, AssistantResponse> = {
  channel: "web",
  enabled: (deps) => deps.config.webEnabled,
  async resolve(store, input) {
    return { identity: await resolveWebIdentity(store, input.sessionUserId), context: { channel: "web", audience: "private", conversationRef: null, constraints: { maxChars: 12_000, canSend: false } } };
  },
  render: (r) => r,
};

// ------------------------------------------------------------------ Zalo OA (prepared, not wired)

export interface OaInput {
  /** follower id from the SIGNED OA webhook event */
  zaloUserId: string;
}

export const oaAdapter: AIChannelAdapter<OaInput, { kind: "text_parts"; parts: string[]; send: false }> = {
  channel: "zalo_oa",
  enabled: (deps) => deps.config.oaEnabled,
  async resolve(store, input) {
    // an OA chat is always 1-1 with the follower
    return { identity: await resolveOaIdentity(store, input.zaloUserId), context: { channel: "zalo_oa", audience: "private", conversationRef: null, constraints: { maxChars: 6_000, canSend: false } } };
  },
  render: (r, c) => ({ kind: "text_parts", parts: splitParts(responseToText(r, c.constraints.maxChars), 1_900, 3), send: false }),
};

// ------------------------------------------------------------------ Zalo Personal (drafts only)

export interface PersonalInput {
  connectionId: string;
  /** Zalo id of the message SENDER, from the signed worker ingest (never from the text) */
  senderId: string;
  conversationType: "user" | "group";
  /** internal zalo_personal_conversations id (logs only) */
  conversationRef: string | null;
}

export const personalAdapter: AIChannelAdapter<PersonalInput, { kind: "draft"; text: string; send: false }> = {
  channel: "zalo_personal",
  enabled: (deps) => deps.config.personalDraftsEnabled,
  async resolve(store, input) {
    return {
      identity: await resolvePersonalIdentity(store, input.connectionId, input.senderId),
      // a group is read by every member: the policy then allows knowledge tools only
      context: { channel: "zalo_personal", audience: input.conversationType === "group" ? "group" : "private", conversationRef: input.conversationRef, constraints: { maxChars: 3_000, canSend: false } },
    };
  },
  render: (r, c) => ({ kind: "draft", text: responseToText(r, c.constraints.maxChars), send: false }),
};

// ------------------------------------------------------------------ one call for any channel

export type ChannelAnswer<O> = { ok: true; output: O; response: AssistantResponse } | { ok: false; reason: "channel_disabled" };

export async function answerThroughChannel<I, O>(adapter: AIChannelAdapter<I, O>, deps: AssistantDeps & { identityStore: IdentityStore }, input: I, question: string): Promise<ChannelAnswer<O>> {
  if (!adapter.enabled(deps)) return { ok: false, reason: "channel_disabled" };
  const { identity, context } = await adapter.resolve(deps.identityStore, input);
  const response = await askSystemAssistant(deps, { identity, channel: context, question });
  return { ok: true, output: adapter.render(response, context), response };
}
