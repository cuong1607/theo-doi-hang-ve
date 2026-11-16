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

import type { AnalystHistoryTurn, AnalystOutput, ProductAnalyst, ProductAnalystRequest } from "../product-analyst/contracts.ts";
import { formatForZalo } from "../product-analyst/formatter.ts";
import { foldVietnamese, PERIOD_LABELS, routeMessage, type ConversationIntent, type ConversationPeriod } from "./router.ts";

export type ConversationChannel = "zalo" | "web";

/** Early rollout (spec §35): only owner / admin accounts may use the conversation agent. */
export const CONVERSATION_ALLOWED_ROLES: readonly string[] = ["admin"];
export const LINK_CODE_TTL_MINUTES = 10;
export const LINK_CODE_MAX_FAILURES_PER_DAY = 5;
/** An unlinked follower gets the "how to link" notice at most this often. */
export const UNLINKED_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** PA-4: a remembered product is reused by follow-ups for this long (spec §48). */
export const PRODUCT_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;
/** Max candidates listed when a product phrase is ambiguous. */
export const PRODUCT_CHOICES_SHOWN = 5;

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
  /** PA-4: when currentProductId was last set (context expiry) */
  productAt?: string | null;
}

export interface ConversationRecord {
  id: string;
  internalUserId: string | null;
  currentShopId: string | null;
  /** PRODUCT-ANALYTICS-2: canonical product (shopee_products.id) resolved inside currentShopId. */
  currentProductId?: string | null;
  lastIntent: ConversationIntent | null;
  context: ConversationContextData;
}

export interface ShopRef {
  id: string;
  name: string;
}

/** PRODUCT-ANALYTICS-2: canonical product candidate of ONE shop (shopee_products). */
export interface ProductCandidate {
  id: string;
  itemId: string;
  name: string | null;
  sku: string | null;
}

export type InboundStatus = "pending" | "replied" | "ignored" | "failed";
export type StoredIntent = ConversationIntent | "LINK";

export interface ConversationStore {
  findLink(channel: ConversationChannel, externalUserId: string): Promise<UserLink | null>;
  upsertConversation(channel: ConversationChannel, externalUserId: string, internalUserId: string | null): Promise<ConversationRecord>;
  /** Insert-if-absent on (channel, provider_message_id): false = already received. */
  insertInboundMessage(input: { conversationId: string; channel: ConversationChannel; providerMessageId: string; text: string; intent: StoredIntent | null }): Promise<{ inserted: true; id: string } | { inserted: false }>;
  setInboundStatus(messageId: string, status: InboundStatus, errorCode?: string | null): Promise<void>;
  insertOutboundMessage(input: { conversationId: string; channel: ConversationChannel; text: string; status: "sent" | "failed"; providerMessageId: string | null; errorCode: string | null; analysis?: AnalystOutput | null }): Promise<void>;
  updateConversation(id: string, patch: { currentShopId?: string | null; currentProductId?: string | null; lastIntent?: ConversationIntent | null; context?: ConversationContextData; internalUserId?: string | null }): Promise<void>;
  /** PRODUCT-ANALYTICS-2: canonical products of ONE (already authorized) shop, for phrase resolution. */
  findProducts(shopId: string): Promise<ProductCandidate[]>;
  /** Shops the user may ask about (explicit grants only). */
  allowedShops(internalUserId: string): Promise<ShopRef[]>;
  /** Every shop name, only to DETECT a mention (and deny it when not granted). */
  allShops(): Promise<ShopRef[]>;
  /** Atomically marks an unexpired, unused code as used; returns its owner. */
  consumeLinkCode(codeHash: string, externalUserId: string, now: Date): Promise<{ internalUserId: string } | null>;
  createLink(channel: ConversationChannel, externalUserId: string, internalUserId: string): Promise<void>;
  /** Profile state for the link-time role check. */
  profile(internalUserId: string): Promise<{ active: boolean; role: string | null } | null>;
  /** PA-4: recent turns of the thread BEFORE a message (plain text, oldest first). Optional: no history without it. */
  recentTurns?(conversationId: string, limit: number, beforeMessageId: string): Promise<AnalystHistoryTurn[]>;
}

export interface OutboundSender {
  sendText(externalUserId: string, text: string): Promise<{ ok: true; providerMessageId: string | null } | { ok: false; errorCode: string }>;
}

export interface ConversationDeps {
  store: ConversationStore;
  sender: OutboundSender;
  analyst: ProductAnalyst;
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
  | "analysis_placeholder"
  | "analysis"
  | "analysis_failed"
  | "clarify_product"
  | "product_not_found"
  | "mutation_refused";

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
  linked: "Hệ thống đã kết nối thành công. Tài khoản Zalo này đã được liên kết.",
  linkFailed: "Mã liên kết không hợp lệ hoặc đã hết hạn.",
  linkLocked: "Bạn đã nhập sai mã quá nhiều lần hôm nay. Thử lại vào ngày mai.",
  shopDenied: "Bạn không có quyền xem shop này.",
  shopRequired: (names: string[]) => (names.length ? `Bạn muốn hỏi shop nào? (${names.join(", ")})` : "Tài khoản của bạn chưa được cấp quyền xem shop nào."),
  mutationRefused: "Trợ lý chỉ phân tích dữ liệu, không thay đổi chiến dịch, ngân sách, giá thầu, giá hay tồn kho. Bạn có thể hỏi về hiệu quả hiện tại để tự quyết định trên Shopee.",
  productNotFound: (q: string, shop: string) => `Không tìm thấy sản phẩm “${q}” trong shop ${shop}. Bạn thử gõ SKU hoặc item ID nhé.`,
  productChoices: (items: ProductCandidate[], more: number) =>
    `Có nhiều sản phẩm khớp, bạn muốn hỏi sản phẩm nào? Gõ lại kèm SKU hoặc item ID:\n${items.map((p, i) => `${i + 1}) ${(p.name ?? "(không tên)").slice(0, 70)}${p.sku ? ` · SKU ${p.sku}` : ""} · ID ${p.itemId}`).join("\n")}${more > 0 ? `\n… và ${more} sản phẩm khác` : ""}`,
} as const;

/** Change requests are answered without any analysis / model call (spec §113). */
export const MUTATION_REQUEST = /\b(tang|giam|tat|bat|dung|tam dung|chinh|dieu chinh|doi|sua|set|cap nhat)\b.{0,25}\b(budget|ngan sach|bid|gia thau|chien dich|campaign|gia ban|ton kho|trang thai)\b/;
/** "Sản phẩm nào yếu nhất?" — a product word, but a SHOP-level question. */
const SHOP_LEVEL_PRODUCT_QUESTION = /\b(san pham|sp) nao\b|\b(nhung|cac) (san pham|sp)\b|\bcan chu y\b|\b(yeu|te|kem|tot|manh) nhat\b/;

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
  // one or more parts (≤ 3 for an analysis); the inbound status reflects the last send
  const reply = async (text: string | string[], status: InboundStatus = "replied") => {
    let last: Awaited<ReturnType<OutboundSender["sendText"]>> = { ok: true, providerMessageId: null };
    for (const part of Array.isArray(text) ? text : [text]) {
      last = await deps.sender.sendText(message.externalUserId, part);
      await store.insertOutboundMessage({ conversationId: conversation.id, channel: message.channel, text: part, status: last.ok ? "sent" : "failed", providerMessageId: last.ok ? last.providerMessageId : null, errorCode: last.ok ? null : last.errorCode });
      if (!last.ok) break;
    }
    await store.setInboundStatus(accepted.messageId, last.ok ? status : "failed", last.ok ? null : last.errorCode);
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
  const live = deps.analyst.name !== "disabled";
  const folded = foldVietnamese(message.text);
  const routed = routeMessage(message.text, { lastIntent: conversation.lastIntent, productQuery: conversation.context.productQuery, period: conversation.context.period });
  if (routed.intent === "HELP") {
    await store.updateConversation(conversation.id, { lastIntent: "HELP" });
    await reply(MESSAGES.help);
    return "help";
  }
  // change requests never reach the analyst (read only, and no model cost)
  if (live && MUTATION_REQUEST.test(folded)) {
    await reply(MESSAGES.mutationRefused);
    return "mutation_refused";
  }
  const productAt = conversation.context.productAt ? Date.parse(conversation.context.productAt) : 0;
  const productFresh = !!conversation.currentProductId && now.getTime() - productAt < PRODUCT_CONTEXT_TTL_MS;
  let intent = routed.intent;
  let productQuery = routed.productQuery;
  let period = routed.period;
  if (intent === "UNKNOWN") {
    // a free-form follow-up ("ROAS giảm do CPC hay conversion?") about the remembered shop / product
    const last = conversation.lastIntent;
    if (live && conversation.currentShopId && (last === "PRODUCT_ANALYSIS" || last === "SHOP_ANALYSIS" || last === "ADS_ANALYSIS")) {
      intent = last;
      productQuery = productFresh ? null : (conversation.context.productQuery ?? null);
      period = period ?? conversation.context.period ?? null;
    } else {
      await reply(MESSAGES.unknown);
      return "unknown";
    }
  }
  if (live && !routed.followUp && SHOP_LEVEL_PRODUCT_QUESTION.test(folded)) {
    intent = "SHOP_ANALYSIS";
    productQuery = null;
  }
  const analyticIntent = intent as ProductAnalystRequest["intent"];

  // 4. shop resolution — re-authorized on EVERY message; context never grants access
  const allowed = await store.allowedShops(link.internalUserId);
  const allowedIds = new Set(allowed.map((s) => s.id));
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
    await store.updateConversation(conversation.id, { currentShopId: null, currentProductId: null, lastIntent: analyticIntent, context: { ...conversation.context, productQuery, period } });
    await reply(MESSAGES.shopRequired(allowed.map((s) => s.name)));
    return "shop_required";
  }
  const shopName = allowed.find((s) => s.id === shopId)?.name ?? "";

  // 5. product: resolved against the canonical identity of THIS shop only (the same item id in
  //    another shop is another product). Never a guess: none → say so, several → ask.
  let productId: string | null = null;
  if (intent !== "SHOP_ANALYSIS") {
    const sameShop = shopId === conversation.currentShopId;
    if (productQuery) {
      if (productFresh && sameShop && productQuery === conversation.context.productQuery) productId = conversation.currentProductId ?? null;
      else {
        const matches = matchProducts(productQuery, await store.findProducts(shopId));
        if (matches.length === 1) productId = matches[0].id;
        else if (live) {
          await store.updateConversation(conversation.id, { currentShopId: shopId, currentProductId: null, lastIntent: analyticIntent, context: { ...conversation.context, productQuery: null, period, productAt: null } });
          if (!matches.length) {
            await reply(MESSAGES.productNotFound(productQuery, shopName));
            return "product_not_found";
          }
          await reply(MESSAGES.productChoices(matches.slice(0, PRODUCT_CHOICES_SHOWN), matches.length - PRODUCT_CHOICES_SHOWN));
          return "clarify_product";
        }
      }
    } else if (productFresh && sameShop) productId = conversation.currentProductId ?? null;
  }

  const history = live && store.recentTurns ? await store.recentTurns(conversation.id, 8, accepted.messageId) : [];
  const request: ProductAnalystRequest = {
    channel: message.channel,
    conversationId: conversation.id,
    internalUserId: link.internalUserId,
    shopId,
    productId,
    productQuery,
    intent: analyticIntent,
    period,
    question: message.text.slice(0, 2000),
    history,
    analysisType: "user_question",
  };
  // defense in depth: the request about to leave the service must still be authorized
  if (!allowedIds.has(request.shopId)) {
    await reply(MESSAGES.shopDenied);
    return "shop_denied";
  }
  await store.updateConversation(conversation.id, {
    currentShopId: shopId,
    currentProductId: productId,
    lastIntent: analyticIntent,
    context: { ...conversation.context, productQuery, period, productAt: productId ? (productId === conversation.currentProductId && productFresh ? conversation.context.productAt : now.toISOString()) : null },
  });

  const result = await deps.analyst.analyze(request);
  if (result.kind === "placeholder") {
    await reply(formatAnalystReply(result.text, request, shopName));
    return "analysis_placeholder";
  }
  if (result.kind === "error") {
    await reply(result.message);
    return "analysis_failed";
  }
  await reply(formatForZalo(result.output, `${shopName}${period ? ` · ${PERIOD_LABELS[period]}` : ""}`));
  return "analysis";
}

/**
 * Deterministic product matching (no LLM): exact item id, then exact SKU,
 * then names containing every word of the phrase (accent-insensitive).
 */
export function matchProducts(phrase: string, candidates: readonly ProductCandidate[]): ProductCandidate[] {
  const q = foldVietnamese(phrase);
  if (!q) return [];
  const digits = q.replace(/\s+/g, "");
  if (/^[0-9]{5,20}$/.test(digits)) return candidates.filter((c) => c.itemId === digits);
  const bySku = candidates.filter((c) => c.sku && foldVietnamese(c.sku) === q);
  if (bySku.length) return bySku;
  const terms = q.split(" ").filter((t) => t.length >= 2);
  if (!terms.length) return [];
  return candidates.filter((c) => {
    const hay = foldVietnamese(`${c.name ?? ""} ${c.sku ?? ""}`);
    return terms.every((t) => hay.includes(t));
  });
}

/** Exactly one match → its id; zero or several → null (never a guess). */
export function resolveProductPhrase(phrase: string, candidates: readonly ProductCandidate[]): string | null {
  const m = matchProducts(phrase, candidates);
  return m.length === 1 ? m[0].id : null;
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
