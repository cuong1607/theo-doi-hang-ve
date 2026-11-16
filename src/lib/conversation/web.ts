// ============================================================
// PRODUCT-ANALYTICS-4: web channel of the conversation service
// (/apps/shopee/ai). The shop / product / period are chosen in the UI — no
// phrase resolution — but they are still only a REQUEST: shop grants are
// re-read here, and the orchestrator re-authorizes user + shop + product and
// every tool call. One thread per user ("web", internal user id); Zalo
// history is never merged in (spec §81). Pure + injected.
// ============================================================
import type { AnalystOutput, ProductAnalyst, ProductAnalystRequest, ProductAnalystResponse } from "../product-analyst/contracts.ts";
import { formatAsText } from "../product-analyst/formatter.ts";
import { foldVietnamese, type ConversationPeriod } from "./router.ts";
import { MESSAGES, MUTATION_REQUEST, type ConversationStore } from "./service.ts";

export const WEB_PERIODS = { today: "today", yesterday: "yesterday", "7d": "last_7_days", "30d": "last_30_days" } as const satisfies Record<string, ConversationPeriod>;
export type WebPeriod = keyof typeof WEB_PERIODS;

export interface WebQuestion {
  internalUserId: string;
  shopId: string;
  productId: string | null;
  period: WebPeriod;
  question: string;
  /** client-generated id: a double submit stores / analyses once */
  clientMessageId: string;
  analysisType: "user_question" | "ui_request";
}

export type WebAnswer =
  | { kind: "duplicate" }
  | { kind: "denied"; message: string }
  | { kind: "text"; message: string }
  | { kind: "analysis"; output: AnalystOutput; cached: boolean; durationMs: number }
  | { kind: "error"; category: string; message: string };

const ADS_WORDS = /\bads\b|quang cao|roas|cpc|ctr|chien dich|campaign/;

export async function askWeb(deps: { store: ConversationStore; analyst: ProductAnalyst }, q: WebQuestion): Promise<WebAnswer> {
  const { store, analyst } = deps;
  const text = q.question.trim().slice(0, 2000);
  if (!text) return { kind: "text", message: "Bạn nhập câu hỏi nhé." };

  // shop grant re-read on every question (the UI selection is not a permission)
  const allowed = await store.allowedShops(q.internalUserId);
  if (!allowed.some((s) => s.id === q.shopId)) return { kind: "denied", message: MESSAGES.shopDenied };

  const conversation = await store.upsertConversation("web", q.internalUserId, q.internalUserId);
  const ins = await store.insertInboundMessage({ conversationId: conversation.id, channel: "web", providerMessageId: q.clientMessageId, text, intent: null });
  if (!ins.inserted) return { kind: "duplicate" };

  const answer = async (message: string, analysis: AnalystOutput | null, status: "replied" | "failed" = "replied") => {
    await store.insertOutboundMessage({ conversationId: conversation.id, channel: "web", text: message, status: "sent", providerMessageId: null, errorCode: status === "failed" ? "analysis_failed" : null, analysis });
    await store.setInboundStatus(ins.id, status, status === "failed" ? "analysis_failed" : null);
  };

  const folded = foldVietnamese(text);
  if (MUTATION_REQUEST.test(folded)) {
    await answer(MESSAGES.mutationRefused, null);
    return { kind: "text", message: MESSAGES.mutationRefused };
  }

  const history = store.recentTurns ? await store.recentTurns(conversation.id, 8, ins.id) : [];
  const intent: ProductAnalystRequest["intent"] = !q.productId ? "SHOP_ANALYSIS" : ADS_WORDS.test(folded) ? "ADS_ANALYSIS" : "PRODUCT_ANALYSIS";
  const period = WEB_PERIODS[q.period];
  await store.updateConversation(conversation.id, { currentShopId: q.shopId, currentProductId: q.productId, lastIntent: intent, context: { ...conversation.context, period, productQuery: null, productAt: q.productId ? new Date().toISOString() : null } });

  let result: ProductAnalystResponse;
  try {
    result = await analyst.analyze({ channel: "web", conversationId: conversation.id, internalUserId: q.internalUserId, shopId: q.shopId, productId: q.productId, productQuery: null, intent, period, question: text, history, analysisType: q.analysisType });
  } catch {
    const message = "Mình chưa phân tích được dữ liệu lúc này. Bạn thử lại sau hoặc xem trực tiếp trong Phân tích Shopee.";
    await answer(message, null, "failed");
    return { kind: "error", category: "AI_PROVIDER_ERROR", message };
  }
  if (result.kind === "placeholder") {
    await answer(result.text, null);
    return { kind: "text", message: result.text };
  }
  if (result.kind === "error") {
    await answer(result.message, null, "failed");
    return { kind: "error", category: result.category, message: result.message };
  }
  await answer(formatAsText(result.output), result.output);
  return { kind: "analysis", output: result.output, cached: result.meta.cached, durationMs: result.meta.durationMs };
}
