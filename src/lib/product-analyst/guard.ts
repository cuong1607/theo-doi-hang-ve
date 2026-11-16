// ============================================================
// PRODUCT-ANALYTICS-4: post-model guards (spec §16–19, §41, §72–73, §91–93).
// Pure — run on the VALIDATED output before anything is rendered.
//
//   policyViolations()  wording the analyst must never use: organic sales by
//                       subtraction, "Ads made X% of revenue", profit / loss,
//                       market / competitor claims, certain causation, mutation
//                       promises, leaked internals (tool / table names, SQL).
//   ungroundedNumbers() every number in the answer must match a number the
//                       tools returned (or the user wrote), within the
//                       precision it is displayed with.
// A violation sends the model ONE repair turn; a second failure is a safe error.
// ============================================================
import type { AnalystOutput } from "./contracts.ts";

const L = "\\p{L}";
/** A statement of absence ("chưa có dữ liệu lợi nhuận") is not a claim. */
const NEGATED_BEFORE = /(chưa|không|ko|khong|thiếu|không thể|chưa thể|chưa đủ|không có|chưa có)[^.!?\n]{0,40}$/iu;

interface Rule {
  code: string;
  re: RegExp;
  /** a claim preceded by a negation is allowed ("chưa có dữ liệu thị trường") */
  allowNegated?: boolean;
}

const RULES: Rule[] = [
  { code: "organic_subtraction", re: /(organic|tự nhiên)\s*(=|là|đạt|khoảng|chiếm|còn|âm)|(doanh (số|thu)|sales)\s+(organic|tự nhiên)|(doanh (số|thu)|sales)\s*[-−]\s*(broad|direct|ads|quảng cáo)/iu },
  { code: "ads_revenue_share", re: /(ads|quảng cáo)\s+(tạo ra|đóng góp|chiếm|mang lại|accounts? for)\s+[~≈]?\s*\d[\d.,]*\s*%|\d[\d.,]*\s*%\s+(của\s+)?(doanh (số|thu)|sales)\s+(đến từ|là do|nhờ|from)\s+(ads|quảng cáo)/iu },
  { code: "profit_claim", re: new RegExp(`(?<!${L})(lãi|lỗ|lợi nhuận|biên lợi nhuận|profit|margin)(?!${L})`, "iu"), allowNegated: true },
  { code: "market_claim", re: /thị trường\s+(đang\s+|chung\s+)?(giảm|tăng|chững|bão hòa|đi xuống|đi lên)|đối thủ\s+(đang\s+)?(giảm|tăng|hạ|bán|chạy)/iu, allowNegated: true },
  { code: "certain_causation", re: /chắc chắn\s+(là\s+)?(do|vì|bởi)|nguyên nhân (chính xác|duy nhất|chắc chắn) (là|nằm ở)|đã được chứng minh (là\s+)?do/iu, allowNegated: true },
  { code: "mutation_promise", re: /(đã|sẽ|mình sẽ|tôi sẽ|em sẽ|đang)\s+(tăng|giảm|tắt|bật|dừng|tạm dừng|điều chỉnh|thay đổi|cập nhật|sửa)\s+(ngân sách|budget|giá thầu|bid|chiến dịch|campaign|giá bán|tồn kho|trạng thái)/iu },
  { code: "internal_leak", re: /get_(product|shop)_\w+|shopee_products|ai_user_shop_access|product_sales_facts|\bselect\s+[\w*,\s]+\s+from\b|system prompt|ANTHROPIC|tool_use/iu },
];

/** Every user-facing text of the output (missing_data is a list of absences → checked separately). */
export function outputTexts(o: AnalystOutput, opts: { includeMissing?: boolean } = {}): string[] {
  const t: string[] = [o.summary, o.data_quality_note ?? "", ...o.suggested_checks];
  for (const e of o.evidence) t.push(e.text);
  for (const f of o.findings) t.push(f.title, f.description);
  for (const h of o.hypotheses) t.push(h.statement, ...h.supporting_evidence, ...h.counter_evidence, ...(opts.includeMissing ? h.missing_data : []));
  if (opts.includeMissing) t.push(...o.missing_data, o.follow_up_context.topic ?? "");
  return t.filter(Boolean);
}

export function policyViolations(o: AnalystOutput): string[] {
  const found = new Set<string>();
  // claims: every text except the explicit "missing data" lists
  for (const text of outputTexts(o)) {
    for (const rule of RULES) {
      const m = rule.re.exec(text);
      if (!m) continue;
      if (rule.allowNegated && NEGATED_BEFORE.test(text.slice(0, m.index))) continue;
      found.add(rule.code);
    }
  }
  // missing-data lists may NAME profit / market data as absent, but never leak internals or promise changes
  for (const text of outputTexts(o, { includeMissing: true })) {
    for (const rule of RULES.filter((r) => r.code === "internal_leak" || r.code === "mutation_promise")) if (rule.re.test(text)) found.add(rule.code);
  }
  return [...found];
}

// ------------------------------------------------------------------ data-aware guards (spec §109, §110)

const ZERO_SALES_CLAIM = /(doanh (số|thu)|số đơn|đơn hàng|sales|gmv)[^.!?\n]{0,25}(bằng|là|=|đạt|chỉ)\s*(0|không)(?!\d|[.,]\d)(\s*(đ|đồng|đơn|vnd))?|không (có|bán được) (đơn|doanh số) nào/iu;

function anyDeep(v: unknown, pred: (key: string, value: unknown) => boolean): boolean {
  if (Array.isArray(v)) return v.some((x) => anyDeep(x, pred));
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => pred(k, x) || anyDeep(x, pred));
  return false;
}

/**
 * Wording that contradicts the data the tools returned:
 *   null_as_zero              "doanh số bằng 0" while sales are null / lower bound / no data
 *   partial_today_confidence  HIGH confidence on a period that includes an unfinished today
 */
export function dataViolations(o: AnalystOutput, toolResults: readonly unknown[]): string[] {
  const out: string[] = [];
  const salesUnknown = toolResults.some((r) => anyDeep(r, (k, v) => (k === "availability" || k === "sales_availability") && (v === "no_data" || v === "lower_bound")));
  if (salesUnknown && outputTexts(o).some((t) => ZERO_SALES_CLAIM.test(t))) out.push("null_as_zero");
  const partial = toolResults.some((r) => anyDeep(r, (k, v) => k === "partial_today" && v === true));
  if (partial && o.confidence === "HIGH") out.push("partial_today_confidence");
  return out;
}

export const POLICY_FEEDBACK: Record<string, string> = {
  null_as_zero: "Dữ liệu doanh số đang thiếu hoặc chỉ là mức tối thiểu: không được nói doanh số/số đơn bằng 0; hãy nói dữ liệu chưa đủ.",
  partial_today_confidence: "Kỳ có hôm nay chưa hết ngày: không dùng độ tin cậy HIGH, nói rõ số liệu hôm nay chưa đầy đủ.",
  organic_subtraction: "Không được tính hay nêu doanh số organic/tự nhiên (doanh số và Ads GMV không tách rời).",
  ads_revenue_share: "Không được nói Ads tạo ra/chiếm X% doanh thu; chỉ dùng 'chỉ báo Ads attribution / tổng doanh số' và nói rõ nó không phải tỉ trọng.",
  profit_claim: "Không có dữ liệu giá vốn/lợi nhuận: không nói lãi, lỗ, lợi nhuận, biên lợi nhuận.",
  market_claim: "Không có dữ liệu thị trường/đối thủ: không nhận định thị trường hay đối thủ (chỉ so sánh trong shop).",
  certain_causation: "Không khẳng định nguyên nhân chắc chắn; dùng ngôn ngữ khả năng và nêu bằng chứng.",
  mutation_promise: "Trợ lý chỉ đọc: không hứa hay mô tả việc thay đổi chiến dịch, ngân sách, giá thầu, giá, tồn kho.",
  internal_leak: "Không nêu tên công cụ, tên bảng, SQL hay chi tiết hệ thống.",
};

// ------------------------------------------------------------------ numeric grounding

interface ParsedNumber {
  raw: string;
  value: number;
  /** half of the last displayed digit's step, in the value's unit (rounding tolerance) */
  tolerance: number;
  percent: boolean;
}

const DATE_LIKE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b\d{1,2}:\d{2}\b/g;
// units end at a non-letter (JS \b is ASCII-only: it never fires after "đ")
const NUMBER = /[-−+]?\d[\d.,]*(\s*(%|x(?!\p{L})|lần|triệu|tr(?!\p{L})|nghìn|ngàn|k(?!\p{L})|đồng|đ(?!\p{L})|vnđ|vnd))?/giu;

function parseLocalized(body: string): { value: number; decimals: number } | null {
  let s = body;
  let decimals = 0;
  if (s.includes(".") && s.includes(",")) {
    // VN: 1.234.567,5
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(".")) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  } else if (s.includes(",")) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  const dot = s.indexOf(".");
  if (dot >= 0) decimals = s.length - dot - 1;
  const value = Number(s);
  return Number.isFinite(value) ? { value, decimals } : null;
}

export function extractNumbers(text: string): ParsedNumber[] {
  const out: ParsedNumber[] = [];
  const cleaned = text.replace(DATE_LIKE, " ");
  for (const m of cleaned.matchAll(NUMBER)) {
    const raw = m[0].trim();
    const unit = (m[2] ?? "").toLowerCase();
    const body = raw.replace(/^[-−+]/, "").replace(/\s*(%|x|lần|triệu|tr|nghìn|ngàn|k|đ|đồng|vnđ|vnd)$/iu, "").replace(/[.,]+$/, "");
    const p = parseLocalized(body);
    if (!p) continue;
    const scale = unit === "triệu" || unit === "tr" ? 1e6 : unit === "nghìn" || unit === "ngàn" || unit === "k" ? 1e3 : 1;
    const value = p.value * scale;
    // small bare integers are counts / day spans ("7 ngày", "3 sản phẩm") — not metric claims
    if (!unit && p.decimals === 0 && Math.abs(value) <= 31) continue;
    if (!unit && p.decimals === 0 && value >= 1900 && value <= 2100) continue;
    const step = Math.pow(10, -p.decimals) * scale;
    out.push({ raw, value: Math.abs(value), tolerance: step / 2, percent: unit === "%" });
  }
  return out;
}

/**
 * Numeric leaves of tool results (abs), plus ×100 / ÷100 forms for ratios shown
 * as % or vice versa — and the numbers inside tool STRINGS (product names such
 * as "Thảm 160x200", SKUs), which the answer may legitimately quote.
 */
export function collectToolNumbers(results: readonly unknown[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      const a = Math.abs(v);
      out.push(a, a * 100, a / 100);
    } else if (typeof v === "string") {
      for (const m of v.matchAll(/\d+(?:[.,]\d+)*/g)) {
        const p = parseLocalized(m[0]);
        if (p) out.push(Math.abs(p.value));
        out.push(Number(m[0].replace(/[.,]/g, "")));
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  results.forEach(walk);
  return out;
}

/** Numbers in the answer with no matching tool (or user-provided) number. */
export function ungroundedNumbers(o: AnalystOutput, toolResults: readonly unknown[], userText = ""): string[] {
  const known = collectToolNumbers(toolResults);
  for (const n of extractNumbers(userText)) known.push(n.value);
  // the mandatory attribution caveat ("có thể vượt 100%") is a concept, not a metric
  known.push(100);
  const misses: string[] = [];
  for (const text of outputTexts(o)) {
    for (const n of extractNumbers(text)) {
      // display rounding + a 0.5% leniency for rounded money ("1,2 triệu")
      const tol = n.tolerance * 1.05 + n.value * 0.005 + 1e-9;
      if (!known.some((k) => Math.abs(k - n.value) <= tol)) misses.push(n.raw);
    }
  }
  return [...new Set(misses)];
}
