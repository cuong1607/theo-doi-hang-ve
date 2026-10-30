// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part B): deterministic message router.
//
// No LLM: keyword rules on accent-folded text. Classifies HELP /
// PRODUCT_ANALYSIS / SHOP_ANALYSIS / ADS_ANALYSIS / UNKNOWN, extracts a
// period and a free-text product phrase, and resolves follow-ups ("còn hôm
// qua?") from the conversation context. It decides NOTHING about access —
// the service re-checks shop permission on every request.
// ============================================================

export type ConversationIntent = "HELP" | "PRODUCT_ANALYSIS" | "SHOP_ANALYSIS" | "ADS_ANALYSIS" | "UNKNOWN";

export type ConversationPeriod = "today" | "yesterday" | "this_week" | "last_week" | "last_7_days" | "last_30_days" | "this_month" | "last_month";

export const PERIOD_LABELS: Record<ConversationPeriod, string> = {
  today: "hôm nay",
  yesterday: "hôm qua",
  this_week: "tuần này",
  last_week: "tuần trước",
  last_7_days: "7 ngày qua",
  last_30_days: "30 ngày qua",
  this_month: "tháng này",
  last_month: "tháng trước",
};

/** Light context carried between messages (stored in ai_conversations.context / last_intent). */
export interface RouterContext {
  lastIntent?: ConversationIntent | null;
  productQuery?: string | null;
  period?: ConversationPeriod | null;
}

export interface RoutedMessage {
  intent: ConversationIntent;
  period: ConversationPeriod | null;
  productQuery: string | null;
  /** The message only changed the period / asked "and …?" — intent + product came from context. */
  followUp: boolean;
  /** "LINK ABC123" — account linking, handled before any routing. */
  linkCode: string | null;
}

export function foldVietnamese(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/\s+/g, " ").trim();
}

const PERIOD_RULES: Array<[RegExp, ConversationPeriod]> = [
  [/\bhom nay\b|\btoday\b/, "today"],
  [/\bhom qua\b|\byesterday\b/, "yesterday"],
  [/\btuan nay\b/, "this_week"],
  [/\btuan truoc\b|\btuan roi\b/, "last_week"],
  [/\b7 ngay\b|\bmot tuan\b/, "last_7_days"],
  [/\b30 ngay\b/, "last_30_days"],
  [/\bthang nay\b/, "this_month"],
  [/\bthang truoc\b|\bthang roi\b/, "last_month"],
];

const HELP = /^(\/?help|\/?start|menu|huong dan|tro giup|giup|\?)$|\bhuong dan\b|\btro giup\b/;
const ADS = /\bquang cao\b|\bads\b|\broas\b|\bacos\b|\bcpc\b|\bchien dich\b|\bcampaign\b/;
const PRODUCT = /\bsan pham\b|\bsp\b|\bsku\b|\bma hang\b|\bmat hang\b|\bitem\b/;
const SHOP = /\bshop\b|\bcua hang\b|\bgian hang\b|\btoan shop\b|\bdoanh so\b|\bdoanh thu\b/;
/** Short follow-ups: "còn hôm qua?", "thế tuần trước thì sao", "so với tháng trước?" */
const FOLLOW_UP = /^(con|the|vay|so voi|con thi|the con)\b|\bthi sao\b|^(hom qua|hom nay|tuan (nay|truoc)|thang (nay|truoc))\??$/;
const LINK = /^(?:link|lien ket)\s+([a-z0-9]{6,12})$/i;

function extractPeriod(folded: string): ConversationPeriod | null {
  for (const [re, p] of PERIOD_RULES) if (re.test(folded)) return p;
  return null;
}

/** Text after "sản phẩm" / "sp" / "sku", minus period words and trailing punctuation (original casing, accents kept). */
function extractProductQuery(original: string): string | null {
  const m = /(?:sản phẩm|san pham|\bsp\b|\bsku\b|mã hàng|ma hang|mặt hàng|mat hang)\s+(.+)$/i.exec(original);
  if (!m) return null;
  let q = m[1];
  q = q.replace(/\s*(tuần này|tuần trước|tuần rồi|hôm nay|hôm qua|tháng này|tháng trước|7 ngày|30 ngày|sao|thế nào|ra sao|giảm|tăng|vậy|thì sao)[\s\S]*$/i, "");
  q = q.replace(/[?.!,;:]+$/g, "").trim();
  return q.length >= 2 ? q.slice(0, 120) : null;
}

export function routeMessage(text: string, context: RouterContext = {}): RoutedMessage {
  const original = text.trim();
  const link = LINK.exec(original);
  if (link) return { intent: "UNKNOWN", period: null, productQuery: null, followUp: false, linkCode: link[1].toUpperCase() };

  const folded = foldVietnamese(original);
  const period = extractPeriod(folded);
  if (HELP.test(folded)) return { intent: "HELP", period: null, productQuery: null, followUp: false, linkCode: null };

  let intent: ConversationIntent = "UNKNOWN";
  if (ADS.test(folded)) intent = "ADS_ANALYSIS";
  else if (PRODUCT.test(folded)) intent = "PRODUCT_ANALYSIS";
  else if (SHOP.test(folded)) intent = "SHOP_ANALYSIS";

  const productQuery = extractProductQuery(original);

  const analytical = context.lastIntent === "PRODUCT_ANALYSIS" || context.lastIntent === "SHOP_ANALYSIS" || context.lastIntent === "ADS_ANALYSIS";
  if (intent === "UNKNOWN" && analytical && (FOLLOW_UP.test(folded) || (period && folded.split(" ").length <= 5))) {
    return { intent: context.lastIntent as ConversationIntent, period: period ?? context.period ?? null, productQuery: context.productQuery ?? null, followUp: true, linkCode: null };
  }
  // ADS question about "this product" with no new product named keeps the product in context
  const keepProduct = intent === "ADS_ANALYSIS" && !productQuery && context.lastIntent === "PRODUCT_ANALYSIS" ? context.productQuery ?? null : null;
  return { intent, period, productQuery: productQuery ?? keepProduct, followUp: false, linkCode: null };
}
