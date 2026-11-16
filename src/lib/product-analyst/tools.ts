// ============================================================
// PRODUCT-ANALYTICS-4: the tools the model may call — an explicit allowlist.
//
//   * names + typed, enum-only inputs (strict schemas): the model can choose a
//     period, never an id, a date string, SQL or a URL;
//   * scope (user, shop, product) comes from the TRUSTED request, and every
//     call is re-authorized in src/lib/product-analytics/agent-tools.ts;
//   * results are compact aggregated JSON (≤ 6 KB each), checked for raw data.
// Pure except for the injected DB client (no "@/" imports): testable with node --test.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, vnToday } from "../analytics/periods.ts";
import type { ConversationPeriod } from "../conversation/router.ts";
import {
  compare_product_periods,
  get_product_ads_performance,
  get_product_baseline,
  get_product_overview,
  get_product_sales_summary,
  get_product_signals,
  get_shop_product_attention_summary,
  ProductToolAccessError,
  type ProductToolPeriodInput,
} from "../product-analytics/agent-tools.ts";
import { ProductAnalyticsReadError } from "../product-analytics/errors.ts";

export const TOOL_PERIODS = ["context", "today", "yesterday", "7d", "30d"] as const;
export type ToolPeriod = (typeof TOOL_PERIODS)[number];
export const BASELINE_DAYS = [7, 14, 28, 30, 60, 90] as const;

export interface AnalystToolSpec {
  name: string;
  scope: "product" | "shop";
  description: string;
  input_schema: {
    type: "object";
    additionalProperties: false;
    required: string[];
    properties: Record<string, { type: "string" | "integer"; enum: readonly (string | number)[]; description: string }>;
  };
}

const periodParam = {
  type: "string" as const,
  enum: TOOL_PERIODS,
  description: "Kỳ phân tích. 'context' = kỳ người dùng đang hỏi (mặc định nên dùng). 'today' chưa hết ngày (partial).",
};

const productTool = (name: string, description: string): AnalystToolSpec => ({
  name,
  scope: "product",
  description,
  input_schema: { type: "object", additionalProperties: false, required: ["period"], properties: { period: periodParam } },
});

/** The ONLY tools exposed to the model (spec §1, §24–29, §52). */
export const ANALYST_TOOLS: readonly AnalystToolSpec[] = [
  productTool("get_product_overview", "Tổng quan một sản phẩm trong kỳ: định danh, sức khỏe (health), doanh số tóm tắt, Ads tóm tắt, tín hiệu chính, ảnh chụp Shopee hiện tại, chất lượng dữ liệu. Thường gọi đầu tiên cho câu hỏi về sản phẩm."),
  productTool("compare_product_periods", "So sánh kỳ hiện tại với kỳ trước cùng độ dài: doanh số, đơn, số lượng, chi Ads, click, impressions, Broad GMV, Broad ROAS — đã tính sẵn chênh lệch tuyệt đối và %. Dùng thay cho việc tự tính delta."),
  productTool("get_product_sales_summary", "Doanh số từ đơn hàng của sản phẩm: GMV, số đơn, số lượng, đơn hủy, kèm định nghĩa và độ phủ dữ liệu (availability: complete / lower_bound / no_data)."),
  productTool("get_product_ads_performance", "Hiệu quả Ads của sản phẩm (chiến dịch 1 sản phẩm): chi tiêu, impressions, click, CTR, CPC, đơn và GMV Direct/Broad, ROAS, CVR, chỉ báo Ads attribution / tổng doanh số (có thể > 100%, không phải tỉ trọng doanh số do Ads)."),
  {
    name: "get_product_baseline",
    scope: "product",
    description: "Nền lịch sử của chính sản phẩm (chỉ ngày đã hoàn tất): trung vị / trung bình / độ biến động theo ngày của doanh số, đơn, Ads. Dùng để biết mức hiện tại có bất thường so với chính nó không.",
    input_schema: { type: "object", additionalProperties: false, required: ["days"], properties: { days: { type: "integer", enum: BASELINE_DAYS, description: "Số ngày lịch sử (kết thúc hôm qua)." } } },
  },
  productTool("get_product_signals", "Tín hiệu xác định của sản phẩm (tăng/giảm có bằng chứng, mức độ, độ tin cậy), lý do health, mức ưu tiên chú ý, tín hiệu chất lượng dữ liệu, và so sánh với trung vị trong cùng shop (không phải thị trường)."),
  {
    name: "get_shop_product_attention_summary",
    scope: "shop",
    description: "Tổng quan cấp shop: phân bố sức khỏe sản phẩm, 10 sản phẩm cần chú ý nhất (theo mức ưu tiên), tổng doanh số / Ads của shop và chất lượng dữ liệu. Dùng cho câu hỏi không nhắm một sản phẩm cụ thể.",
    input_schema: { type: "object", additionalProperties: false, required: ["period"], properties: { period: periodParam } },
  },
];

export const ANALYST_TOOL_NAMES = ANALYST_TOOLS.map((t) => t.name);

// ------------------------------------------------------------------ periods

const fmt = (d: Date) => d.toISOString().slice(0, 10);

/** The user's conversational period → the tools' period (VN calendar). */
export function conversationPeriodToToolInput(p: ConversationPeriod | null, now: Date = new Date()): ProductToolPeriodInput {
  const today = vnToday(now);
  switch (p) {
    case "today":
      return { preset: "today" };
    case "yesterday":
      return { preset: "yesterday" };
    case "last_30_days":
      return { preset: "30d" };
    case "this_month": {
      const start = `${today.slice(0, 8)}01`;
      return start === today ? { preset: "today" } : { from: start, to: today };
    }
    case "last_month": {
      const first = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
      const lastPrev = new Date(first.getTime() - 86_400_000);
      return { from: `${fmt(lastPrev).slice(0, 8)}01`, to: fmt(lastPrev) };
    }
    case "last_week": {
      // previous Monday → Sunday
      const d = new Date(`${today}T00:00:00Z`);
      const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
      const thisMonday = addDays(today, -dow);
      return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
    }
    case "this_week":
    case "last_7_days":
    default:
      return { preset: "7d" };
  }
}

export function toolPeriodInput(p: ToolPeriod, contextPeriod: ProductToolPeriodInput): ProductToolPeriodInput {
  return p === "context" ? contextPeriod : { preset: p };
}

// ------------------------------------------------------------------ raw-data guard (spec §9, §107)

/** Keys / values that must never reach the model: PII, raw order / snapshot payloads, SQL, credentials. */
const FORBIDDEN_KEY = /^(buyer|buyer_\w+|recipient\w*|phone\w*|address\w*|full_address|email|order_sn|order_sns|payload|raw\w*|access_token|refresh_token|token|secret\w*|api_key|sql|query_text|message_text)$/i;
const FORBIDDEN_VALUE = /\bselect\s+[\w*,\s]+\s+from\b|\binsert\s+into\b|\bdelete\s+from\b|sk-ant-/i;

export function rawDataViolations(value: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...rawDataViolations(v, `${path}[${i}]`)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${path}.${k}`);
      out.push(...rawDataViolations(v, `${path}.${k}`));
    }
  } else if (typeof value === "string" && FORBIDDEN_VALUE.test(value)) out.push(path);
  return out;
}

// ------------------------------------------------------------------ size (spec §32)

const DROP_ORDER = ["metric_meta", "semantics", "evidence_note", "attribution_warning", "provider_snapshot", "data_quality_signals"];

/** Serialize ≤ maxBytes: drop explanatory blocks first, then shorten arrays, never invent values. */
export function compactToolResult(data: unknown, maxBytes: number): { json: string; bytes: number; truncated: boolean } {
  let json = JSON.stringify(data);
  let truncated = false;
  if (Buffer.byteLength(json) <= maxBytes || !data || typeof data !== "object") return { json, bytes: Buffer.byteLength(json), truncated };
  const copy = structuredClone(data) as Record<string, unknown>;
  for (const k of DROP_ORDER) {
    if (k in copy) {
      delete copy[k];
      truncated = true;
      json = JSON.stringify({ ...copy, truncated });
      if (Buffer.byteLength(json) <= maxBytes) return { json, bytes: Buffer.byteLength(json), truncated };
    }
  }
  const shorten = (v: unknown): unknown => (Array.isArray(v) ? v.slice(0, Math.max(1, Math.ceil(v.length / 2))).map(shorten) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)])) : v);
  let cur: unknown = copy;
  for (let i = 0; i < 4 && Buffer.byteLength(json) > maxBytes; i++) {
    cur = shorten(cur);
    json = JSON.stringify({ ...(cur as object), truncated: true });
  }
  if (Buffer.byteLength(json) > maxBytes) json = JSON.stringify({ tool: (data as { tool?: string }).tool ?? null, error: "result_too_large" });
  return { json, bytes: Buffer.byteLength(json), truncated: true };
}

// ------------------------------------------------------------------ execution

export interface ToolExecutionContext {
  db: SupabaseClient;
  internalUserId: string;
  shopId: string;
  productId: string | null;
  contextPeriod: ProductToolPeriodInput;
  now: Date;
  maxBytes: number;
}

export type ToolErrorCode = "UNKNOWN_TOOL" | "BAD_INPUT" | "NO_PRODUCT" | "AUTH_DENIED" | "PRODUCT_NOT_FOUND" | "DATA_UNAVAILABLE" | "RAW_DATA_BLOCKED" | "TOOL_ERROR";

export type ToolExecutionResult =
  | { ok: true; name: string; content: string; data: unknown; bytes: number; truncated: boolean; ms: number }
  | { ok: false; name: string; content: string; code: ToolErrorCode; ms: number };

const TOOL_ERROR_TEXT: Record<ToolErrorCode, string> = {
  UNKNOWN_TOOL: "Công cụ không tồn tại.",
  BAD_INPUT: "Tham số không hợp lệ.",
  NO_PRODUCT: "Chưa xác định sản phẩm: hãy đề nghị người dùng nêu tên hoặc SKU sản phẩm, hoặc dùng công cụ cấp shop.",
  AUTH_DENIED: "Không có quyền truy cập dữ liệu này.",
  PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm trong shop này.",
  DATA_UNAVAILABLE: "Chưa đọc được dữ liệu cho kỳ này.",
  RAW_DATA_BLOCKED: "Kết quả bị chặn do chứa dữ liệu không được phép.",
  TOOL_ERROR: "Không đọc được dữ liệu lúc này.",
};

function validateInput(spec: AnalystToolSpec, input: unknown): Record<string, string | number> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!(k in spec.input_schema.properties)) return null;
  for (const k of spec.input_schema.required) if (!(k in v)) return null;
  for (const [k, p] of Object.entries(spec.input_schema.properties)) if (k in v && !p.enum.includes(v[k] as string | number)) return null;
  return v as Record<string, string | number>;
}

/** Runs one allowlisted tool with the TRUSTED scope; every call re-authorizes inside agent-tools. */
export async function executeAnalystTool(name: string, rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const started = Date.now();
  const fail = (code: ToolErrorCode): ToolExecutionResult => ({ ok: false, name, code, content: JSON.stringify({ error: code, message: TOOL_ERROR_TEXT[code] }), ms: Date.now() - started });
  const spec = ANALYST_TOOLS.find((t) => t.name === name);
  if (!spec) return fail("UNKNOWN_TOOL");
  const input = validateInput(spec, rawInput);
  if (!input) return fail("BAD_INPUT");
  if (spec.scope === "product" && !ctx.productId) return fail("NO_PRODUCT");
  const period = toolPeriodInput((input.period as ToolPeriod) ?? "context", ctx.contextPeriod);
  const productScope = { internal_user_id: ctx.internalUserId, shop_id: ctx.shopId, product_id: ctx.productId ?? "" };
  try {
    let data: unknown;
    switch (name) {
      case "get_product_overview":
        data = await get_product_overview(ctx.db, productScope, { period }, ctx.now);
        break;
      case "compare_product_periods":
        data = await compare_product_periods(ctx.db, productScope, { period }, ctx.now);
        break;
      case "get_product_sales_summary":
        data = await get_product_sales_summary(ctx.db, productScope, { period }, ctx.now);
        break;
      case "get_product_ads_performance":
        data = await get_product_ads_performance(ctx.db, productScope, { period }, ctx.now);
        break;
      case "get_product_baseline":
        data = await get_product_baseline(ctx.db, productScope, { days: Number(input.days) }, ctx.now);
        break;
      case "get_product_signals":
        data = await get_product_signals(ctx.db, productScope, { period }, ctx.now);
        break;
      case "get_shop_product_attention_summary":
        data = await get_shop_product_attention_summary(ctx.db, { internal_user_id: ctx.internalUserId, shop_id: ctx.shopId }, { period }, ctx.now);
        break;
      default:
        return fail("UNKNOWN_TOOL");
    }
    if (rawDataViolations(data).length) return fail("RAW_DATA_BLOCKED");
    const { json, bytes, truncated } = compactToolResult(data, ctx.maxBytes);
    return { ok: true, name, content: json, data: JSON.parse(json), bytes, truncated, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof ProductToolAccessError) return fail(err.code === "product_not_found" ? "PRODUCT_NOT_FOUND" : "AUTH_DENIED");
    if (err instanceof ProductAnalyticsReadError) return fail("DATA_UNAVAILABLE");
    return fail("TOOL_ERROR");
  }
}
