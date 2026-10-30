// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part B): conversation service — the boundary
// between a transport (Zalo webhook) and the future Product Analyst.
//
//   acceptIncomingMessage     store + dedupe (fast; runs inside the webhook)
//   processAcceptedMessage    link / authorize / context / agent / reply
//                             (runs after the webhook answered)
//   handleIncomingConversationMessage = both, for callers without a split
//
// Channel-agnostic: storage, outbound sending and the analyst are injected
// interfaces. The webhook never calls a model; the analyst never calls Zalo.
//
// Access: a Zalo user must be LINKED (one-time code) to an ACTIVE internal
// profile whose role is allowed in this rollout (admin only), and every
// analytical request is re-authorized against ai_user_shop_access. The
// conversation context only remembers WHICH shop / product was discussed —
// it never grants access.
// ============================================================
import { createHash, randomInt } from "node:crypto";

import type { ProductAnalystProvider, ProductAnalystRequest } from "../product-analyst/contracts.ts";
import { foldVietnamese, PERIOD_LABELS, routeMessage, type ConversationIntent, type ConversationPeriod } from "./router.ts";

export type ConversationChannel = "zalo";

/** Early rollout (spec §35): only owner / admin accounts may use the conversation agent. */
export const CONVERSATION_ALLOWED_ROLES: readonly string[] = ["admin"];
export const LINK_CODE_TTL_MINUTES = 10;
export const LINK_CODE_MAX_FAILURES_PER_DAY = 5;
/** An unlinked follower gets the "how to link" notice at most this often. */
export const UNLINKED_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface IncomingMessage {
  channel: ConversationChannel;
  externalUserId: string;
  providerMessageId: string;
  text: string;
  receivedAt: Date;
}

export interface UserLink {
  internalUserId: string;
  status: "active" | "revoked";
  profileActive: boolean;
  role: string | null;
}

export interface ConversationContextData {
  productQuery?: string | null;
  period?: ConversationPeriod | null;
  unlinkedNoticeAt?: string | null;
  linkFailures?: { day: string; count: number } | null;
}

export interface ConversationRecord {
  id: string;
  internalUserId: string | null;
  currentShopId: string | null;
  lastIntent: ConversationIntent | null;
  context: ConversationContextData;
}

export interface ShopRef {
  id: string;
  name: string;
}

export type InboundStatus = "pending" | "replied" | "ignored" | "failed";
export type StoredIntent = ConversationIntent | "LINK";

export interface ConversationStore {
  findLink(channel: ConversationChannel, externalUserId: string): Promise<UserLink | null>;
  upsertConversation(channel: ConversationChannel, externalUserId: string, internalUserId: string | null): Promise<ConversationRecord>;
  /** Insert-if-absent on (channel, provider_message_id): false = already received. */
  insertInboundMessage(input: { conversationId: string; channel: ConversationChannel; providerMessageId: string; text: string; intent: StoredIntent | null }): Promise<{ inserted: true; id: string } | { inserted: false }>;
  setInboundStatus(messageId: string, status: InboundStatus, errorCode?: string | null): Promise<void>;
  insertOutboundMessage(input: { conversationId: string; channel: ConversationChannel; text: string; status: "sent" | "failed"; providerMessageId: string | null; errorCode: string | null }): Promise<void>;
  updateConversation(id: string, patch: { currentShopId?: string | null; lastIntent?: ConversationIntent | null; context?: ConversationContextData; internalUserId?: string | null }): Promise<void>;
  /** Shops the user may ask about (explicit grants only). */
  allowedShops(internalUserId: string): Promise<ShopRef[]>;
  /** Every shop name, only to DETECT a mention (and deny it when not granted). */
  allShops(): Promise<ShopRef[]>;
  /** Atomically marks an unexpired, unused code as used; returns its owner. */
  consumeLinkCode(codeHash: string, externalUserId: string, now: Date): Promise<{ internalUserId: string } | null>;
  createLink(channel: ConversationChannel, externalUserId: string, internalUserId: string): Promise<void>;
  /** Profile state for the link-time role check. */
  profile(internalUserId: string): Promise<{ active: boolean; role: string | null } | null>;
}

export interface OutboundSender {
  sendText(externalUserId: string, text: string): Promise<{ ok: true; providerMessageId: string | null } | { ok: false; errorCode: string }>;
}

export interface ConversationDeps {
  store: ConversationStore;
  sender: OutboundSender;
  analyst: ProductAnalystProvider;
  now?: () => Date;
}

export type ConversationOutcome =
  | "duplicate"
  | "linked"
  | "link_failed"
  | "unlinked"
  | "unlinked_silent"
  | "not_allowed"
  | "help"
  | "unknown"
  | "shop_denied"
  | "shop_required"
  | "analysis_placeholder";

export interface AcceptedMessage {
  messageId: string;
  conversation: ConversationRecord;
  link: UserLink | null;
  message: IncomingMessage;
}

// ------------------------------------------------------------ link codes
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase(), "utf8").digest("hex");
}

/** A fresh one-time code: the plaintext goes to the admin ONCE; only the hash is stored. */
export function generateLinkCode(now: Date, random: (max: number) => number = (max) => randomInt(max)): { code: string; codeHash: string; expiresAt: Date } {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return { code, codeHash: hashLinkCode(code), expiresAt: new Date(now.getTime() + LINK_CODE_TTL_MINUTES * 60_000) };
}

// ------------------------------------------------------------ texts (generic; the transport only carries them)
export const MESSAGES = {
  help:
    "Trợ lý phân tích (thử nghiệm). Bạn có thể hỏi:\n• Sản phẩm <tên> tuần này sao?\n• Shop <tên> hôm qua thế nào?\n• Quảng cáo sản phẩm <tên> 7 ngày qua?\nSau đó hỏi tiếp \"còn hôm qua?\" để đổi kỳ.",
  unknown: "Mình chưa hiểu câu hỏi. Gõ \"hướng dẫn\" để xem các câu hỏi được hỗ trợ.",
  unlinked: "Tài khoản Zalo này chưa được liên kết với hệ thống. Nếu bạn là quản trị viên, hãy tạo mã liên kết trong ứng dụng rồi gửi: LINK <mã>.",
  notAllowed: "Tài khoản liên kết hiện không có quyền dùng trợ lý phân tích.",
  linked: "Đã liên kết tài khoản Zalo với hệ thống.",
  linkFailed: "Mã liên kết không hợp lệ hoặc đã hết hạn.",
  linkLocked: "Bạn đã nhập sai mã quá nhiều lần hôm nay. Thử lại vào ngày mai.",
  shopDenied: "Bạn không có quyền xem shop này.",
  shopRequired: (names: string[]) => (names.length ? `Bạn muốn hỏi shop nào? (${names.join(", ")})` : "Tài khoản của bạn chưa được cấp quyền xem shop nào."),
} as const;

// ------------------------------------------------------------ service
export async function acceptIncomingMessage(deps: ConversationDeps, message: IncomingMessage): Promise<AcceptedMessage | null> {
  const routed = routeMessage(message.text);
  const link = await deps.store.findLink(message.channel, message.externalUserId);
  const usable = link?.status === "active" ? link : null;
  const conversation = await deps.store.upsertConversation(message.channel, message.externalUserId, usable?.internalUserId ?? null);
  // store only what the conversation needs: link codes redacted, unlinked followers' text not kept
  const text = routed.linkCode ? "[mã liên kết]" : usable ? message.text.slice(0, 4000) : "[người dùng chưa liên kết]";
  const ins = await deps.store.insertInboundMessage({ conversationId: conversation.id, channel: message.channel, providerMessageId: message.providerMessageId, text, intent: routed.linkCode ? "LINK" : null });
  if (!ins.inserted) return null;
  return { messageId: ins.id, conversation, link: usable, message };
}

export async function processAcceptedMessage(deps: ConversationDeps, accepted: AcceptedMessage): Promise<ConversationOutcome> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const { conversation, message } = accepted;
  const reply = async (text: string, status: InboundStatus = "replied") => {
    const sent = await deps.sender.sendText(message.externalUserId, text);
    await store.insertOutboundMessage({ conversationId: conversation.id, channel: message.channel, text, status: sent.ok ? "sent" : "failed", providerMessageId: sent.ok ? sent.providerMessageId : null, errorCode: sent.ok ? null : sent.errorCode });
    await store.setInboundStatus(accepted.messageId, sent.ok ? status : "failed", sent.ok ? null : sent.errorCode);
  };

  const routedRaw = routeMessage(message.text);

  // 1. account linking — the only thing an unlinked user can do
  if (routedRaw.linkCode) {
    const day = now.toISOString().slice(0, 10);
    const failures = conversation.context.linkFailures?.day === day ? conversation.context.linkFailures.count : 0;
    if (failures >= LINK_CODE_MAX_FAILURES_PER_DAY) {
      await reply(MESSAGES.linkLocked);
      return "link_failed";
    }
    const owner = await store.consumeLinkCode(hashLinkCode(routedRaw.linkCode), message.externalUserId, now);
    const profile = owner ? await store.profile(owner.internalUserId) : null;
    if (!owner || !profile?.active || !CONVERSATION_ALLOWED_ROLES.includes(profile.role ?? "")) {
      await store.updateConversation(conversation.id, { context: { ...conversation.context, linkFailures: { day, count: failures + 1 } } });
      await reply(MESSAGES.linkFailed);
      return "link_failed";
    }
    await store.createLink(message.channel, message.externalUserId, owner.internalUserId);
    await store.updateConversation(conversation.id, { internalUserId: owner.internalUserId, context: { ...conversation.context, linkFailures: null } });
    await reply(MESSAGES.linked);
    return "linked";
  }

  // 2. unlinked follower: one notice per interval, otherwise silent (not exposed to all OA followers)
  const link = accepted.link;
  if (!link) {
    const last = conversation.context.unlinkedNoticeAt ? Date.parse(conversation.context.unlinkedNoticeAt) : 0;
    if (now.getTime() - last < UNLINKED_NOTICE_INTERVAL_MS) {
      await store.setInboundStatus(accepted.messageId, "ignored");
      return "unlinked_silent";
    }
    await store.updateConversation(conversation.id, { context: { ...conversation.context, unlinkedNoticeAt: now.toISOString() } });
    await reply(MESSAGES.unlinked);
    return "unlinked";
  }
  if (!link.profileActive || !CONVERSATION_ALLOWED_ROLES.includes(link.role ?? "")) {
    await reply(MESSAGES.notAllowed);
    return "not_allowed";
  }

  // 3. route with context
  const routed = routeMessage(message.text, { lastIntent: conversation.lastIntent, productQuery: conversation.context.productQuery, period: conversation.context.period });
  if (routed.intent === "HELP") {
    await store.updateConversation(conversation.id, { lastIntent: "HELP" });
    await reply(MESSAGES.help);
    return "help";
  }
  if (routed.intent === "UNKNOWN") {
    await reply(MESSAGES.unknown);
    return "unknown";
  }

  // 4. shop resolution — re-authorized on EVERY message; context never grants access
  const allowed = await store.allowedShops(link.internalUserId);
  const allowedIds = new Set(allowed.map((s) => s.id));
  const folded = foldVietnamese(message.text);
  const mentioned = (await store.allShops()).filter((s) => {
    const name = foldVietnamese(s.name);
    return name.length >= 3 && folded.includes(name);
  });
  let shopId: string | null = null;
  if (mentioned.length) {
    const ok = mentioned.find((s) => allowedIds.has(s.id));
    if (!ok) {
      await reply(MESSAGES.shopDenied);
      return "shop_denied";
    }
    shopId = ok.id;
  } else if (conversation.currentShopId && allowedIds.has(conversation.currentShopId)) {
    shopId = conversation.currentShopId;
  } else if (allowed.length === 1) {
    shopId = allowed[0].id;
  }
  if (!shopId) {
    await store.updateConversation(conversation.id, { currentShopId: null, lastIntent: routed.intent, context: { ...conversation.context, productQuery: routed.productQuery, period: routed.period } });
    await reply(MESSAGES.shopRequired(allowed.map((s) => s.name)));
    return "shop_required";
  }

  const request: ProductAnalystRequest = {
    conversationId: conversation.id,
    internalUserId: link.internalUserId,
    shopId,
    productId: null,
    productQuery: routed.productQuery,
    intent: routed.intent,
    period: routed.period,
  };
  // defense in depth: the request about to leave the service must still be authorized
  if (!allowedIds.has(request.shopId)) {
    await reply(MESSAGES.shopDenied);
    return "shop_denied";
  }
  await store.updateConversation(conversation.id, { currentShopId: shopId, lastIntent: routed.intent, context: { ...conversation.context, productQuery: routed.productQuery, period: routed.period } });

  const result = await deps.analyst.analyze(request);
  const shopName = allowed.find((s) => s.id === shopId)?.name ?? "";
  await reply(formatAnalystReply(result.kind === "placeholder" ? result.text : result.output.summary, request, shopName));
  return "analysis_placeholder";
}

/** What was understood + the analyst's text. Generic plain text; the transport decides nothing. */
export function formatAnalystReply(text: string, request: ProductAnalystRequest, shopName: string): string {
  const parts = [request.intent === "ADS_ANALYSIS" ? "Quảng cáo" : request.intent === "SHOP_ANALYSIS" ? "Shop" : "Sản phẩm"];
  if (request.productQuery) parts.push(`“${request.productQuery}”`);
  if (shopName) parts.push(`· ${shopName}`);
  if (request.period) parts.push(`· ${PERIOD_LABELS[request.period]}`);
  return `Đã ghi nhận: ${parts.join(" ")}.\n${text}`;
}

export async function handleIncomingConversationMessage(deps: ConversationDeps, message: IncomingMessage): Promise<ConversationOutcome> {
  const accepted = await acceptIncomingMessage(deps, message);
  if (!accepted) return "duplicate";
  return processAcceptedMessage(deps, accepted);
}
