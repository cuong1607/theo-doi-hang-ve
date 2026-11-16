// ============================================================
// PRODUCT-ANALYTICS-4: FakeProductAnalystProvider — deterministic, no network.
// Used by unit / integration / E2E tests and local demos
// (AI_PRODUCT_ANALYST_PROVIDER=fake). It plays the model's part honestly: picks
// tools from the question, calls them through the SAME executeTool (allowlist +
// authorization), and writes an AnalystOutput ONLY from numbers the tools
// returned — so the orchestrator's schema / policy / grounding checks apply.
// Pure (no "@/" imports).
// ============================================================
import { foldVietnamese } from "../conversation/router.ts";
import type { AnalystOutput, Confidence } from "./contracts.ts";
import { emptyUsage, type AnalystRunInput, type AnalystRunResult, type ProductAnalystProvider } from "./provider.ts";

type Json = Record<string, unknown>;

const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 10) / 10).toLocaleString("vi-VN")}%` : null);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("vi-VN", { maximumFractionDigits: d }) : null);
const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Json)[k] : undefined), o);

const MUTATION = /\b(tang|giam|tat|bat|dung|chinh|doi|sua)\b.{0,20}\b(budget|ngan sach|bid|gia thau|chien dich|campaign|gia ban|ton kho)\b/;
const INJECTION = /ignore previous|bo qua (moi |tat ca )?(huong dan|chi dan)|\bsql\b|system prompt|drop table|select \*/;

export class FakeProductAnalystProvider implements ProductAnalystProvider {
  readonly name = "fake";
  readonly model = "fake-analyst";

  async run(input: AnalystRunInput): Promise<AnalystRunResult> {
    const usage = emptyUsage();
    const toolTrace: string[] = [];
    let toolMs = 0;
    const last = input.turns[input.turns.length - 1]?.text ?? "";
    const question = foldVietnamese(/<cau_hoi_nguoi_dung>([\s\S]*?)<\/cau_hoi_nguoi_dung>/.exec(last)?.[1] ?? last);
    const hasProduct = /"san_pham":\{/.test(last);
    usage.inputTokens = Math.round(1200 + input.turns.reduce((n, t) => n + t.text.length, 0) / 4);

    const finish = (raw: AnalystOutput): AnalystRunResult => {
      usage.outputTokens = Math.round(JSON.stringify(raw).length / 4);
      const verdict = input.check(raw);
      return { status: verdict.ok ? "completed" : "invalid_output", raw, usage, modelTurns: 1 + (toolTrace.length ? 1 : 0), toolCalls: toolTrace.length, toolTrace, modelMs: 5, toolMs, repaired: false };
    };

    if (MUTATION.test(question)) return finish(plain("Trợ lý chỉ phân tích dữ liệu, không thay đổi chiến dịch, ngân sách, giá thầu hay sản phẩm. Bạn có thể hỏi về hiệu quả Ads hiện tại để cân nhắc trước khi tự điều chỉnh trên Shopee."));
    if (INJECTION.test(question)) return finish(plain("Mình chỉ hỗ trợ phân tích sản phẩm và quảng cáo Shopee bằng dữ liệu của hệ thống, và không thực hiện yêu cầu này."));

    const call = async (name: string, args: Json) => {
      if (toolTrace.length >= input.limits.maxToolCalls) return null;
      toolTrace.push(name);
      const r = await input.executeTool(name, args);
      toolMs += r.ms;
      return r.ok ? r.data : { error: r.code };
    };

    if (!hasProduct) {
      const shop = await call("get_shop_product_attention_summary", { period: "context" });
      return finish(shopAnswer(shop));
    }

    const ads = /\bads\b|quang cao|roas|cpc|ctr|click/.test(question);
    const why = /tai sao|vi sao|sao lai|giam|tang|so voi|nguyen nhan|co phai/.test(question);
    const overview = await call("get_product_overview", { period: "context" });
    if ((overview as Json | null)?.error) return finish(plain("Không tìm thấy sản phẩm này trong shop bạn đang chọn hoặc bạn không có quyền xem."));
    const compare = why || !ads ? await call("compare_product_periods", { period: "context" }) : null;
    const adsData = ads || why ? await call("get_product_ads_performance", { period: "context" }) : null;
    if (why) await call("get_product_signals", { period: "context" });
    return finish(productAnswer(overview, compare, adsData));
  }
}

function plain(summary: string): AnalystOutput {
  return { summary, data_quality_note: null, findings: [], hypotheses: [], evidence: [], confidence: "LOW", missing_data: [], suggested_checks: [], follow_up_context: { topic: null } };
}

function shopAnswer(shop: unknown): AnalystOutput {
  const top = (get(shop, "top_attention") as Json[] | undefined) ?? [];
  const attention = get(shop, "needs_attention");
  if (!shop || (shop as Json).error) return plain("Chưa đọc được dữ liệu shop lúc này.");
  const evidence = [{ id: "e1", text: `${num(attention) ?? "—"} sản phẩm cần chú ý trong kỳ` }];
  top.slice(0, 3).forEach((r, i) => {
    const g = pct(r.sales_gmv_pct);
    evidence.push({ id: `e${i + 2}`, text: `${String(r.name ?? "").slice(0, 60)}: ${r.health}${g ? `, doanh số ${g}` : ""}` });
  });
  return {
    summary: top.length ? `Shop có ${num(attention) ?? "—"} sản phẩm cần chú ý; ưu tiên cao nhất là “${String(top[0].name ?? "").slice(0, 60)}”.` : "Hiện chưa có sản phẩm nào cần chú ý trong kỳ này.",
    data_quality_note: get(shop, "data_quality", "sales_previous_complete") === false ? "Dữ liệu kỳ trước chưa đủ để so sánh đáng tin cậy." : null,
    findings: top.length ? [{ title: "Sản phẩm cần chú ý", description: "Danh sách theo mức ưu tiên của hệ thống tín hiệu.", severity: "NOTICE", evidence_refs: evidence.map((e) => e.id) }] : [],
    hypotheses: [],
    evidence,
    confidence: "MEDIUM",
    missing_data: [],
    suggested_checks: top.length ? ["Mở chi tiết sản phẩm ưu tiên cao nhất để xem tín hiệu"] : [],
    follow_up_context: { topic: "shop_attention" },
  };
}

function productAnswer(overview: unknown, compare: unknown, ads: unknown): AnalystOutput {
  const evidence: AnalystOutput["evidence"] = [];
  const add = (text: string | null) => {
    if (!text) return null;
    const id = `e${evidence.length + 1}`;
    evidence.push({ id, text });
    return id;
  };
  const c = (k: string) => get(compare, "comparisons", k);
  const salesPct = pct(get(c("sales_gmv"), "pct"));
  const ordersPct = pct(get(c("orders"), "pct"));
  const clicksPct = pct(get(c("ads_clicks"), "pct"));
  const roasPct = pct(get(c("ads_broad_roas"), "pct"));
  const comparable = get(c("sales_gmv"), "pct") !== null && get(c("sales_gmv"), "pct") !== undefined;
  const refs = [salesPct && add(`Doanh số ${salesPct} so với kỳ trước`), ordersPct && add(`Số đơn ${ordersPct}`), clicksPct && add(`Click Ads ${clicksPct}`), roasPct && add(`Broad ROAS ${roasPct}`)].filter(Boolean) as string[];
  const spend = num(get(ads, "ads", "spend", "current"));
  if (spend) refs.push(add(`Chi Ads ${spend} đ trong kỳ`)!);
  const health = get(overview, "health", "label");
  const partial = get(overview, "period", "partial_today") === true;
  const availability = get(overview, "sales", "availability");
  const dq = !comparable ? "Dữ liệu kỳ trước chưa đủ để so sánh đáng tin cậy." : partial ? "Hôm nay chưa hết ngày, số liệu hôm nay chưa đầy đủ." : availability === "lower_bound" ? "Doanh số kỳ này chỉ là mức tối thiểu (dữ liệu chưa phủ đủ)." : null;
  const confidence: Confidence = !comparable || partial ? "LOW" : refs.length >= 3 ? "MEDIUM" : "LOW";
  const salesDown = typeof get(c("sales_gmv"), "pct") === "number" && (get(c("sales_gmv"), "pct") as number) < 0;
  return {
    summary: comparable ? `Doanh số kỳ này ${salesPct} so với kỳ trước${health ? `; sức khỏe sản phẩm: ${health}` : ""}.` : `Chưa so sánh được với kỳ trước${health ? `; sức khỏe sản phẩm: ${health}` : ""}.`,
    data_quality_note: dq,
    findings: refs.length ? [{ title: salesDown ? "Doanh số giảm" : "Diễn biến doanh số và Ads", description: "Các chỉ số chính của kỳ so với kỳ trước.", severity: salesDown ? "WARNING" : "INFO", evidence_refs: refs.slice(0, 4) }] : [],
    hypotheses:
      salesDown && refs.length >= 2
        ? [{ statement: "Có khả năng hiệu suất sau click đáng kiểm tra; chưa đủ dữ liệu để kết luận nguyên nhân.", confidence: "LOW", supporting_evidence: evidence.slice(0, 2).map((e) => e.text), counter_evidence: [], missing_data: ["Visitors và add-to-cart toàn sản phẩm"] }]
        : [],
    evidence,
    confidence,
    missing_data: ["Visitors / add-to-cart / nguồn traffic toàn sản phẩm"],
    suggested_checks: salesDown ? ["Kiểm tra giá/voucher hiện tại", "Kiểm tra biến thể hết hàng"] : [],
    follow_up_context: { topic: "product_performance" },
  };
}
