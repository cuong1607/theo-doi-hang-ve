// ============================================================
// SHOPEE-ADS-1B: provider DTO → canonical write model (pure, no I/O).
//
// The ONLY place that knows Shopee Ads field names. Built from VERIFIED
// production payloads (docs/shopee-ads-api.md §3 / §3.5 and the sanitized
// fixtures in __fixtures__/provider/). Forward compatible: unknown fields
// are ignored, unknown status / type values are kept raw, a missing optional
// field never fails a batch.
//
// Facts this mapper encodes:
//   * dates are "DD-MM-YYYY" (shop-local report date) → canonical YYYY-MM-DD
//   * campaign_duration times are epoch SECONDS; end_time 0 = no end date
//   * money is integer VND (đồng) → exact decimal strings (NUMERIC in DB)
//   * campaign *_order_amount ≈ units sold → *_item_sold columns
//   * provider ratios are NOT mapped. In particular the campaign-level
//     "cpc" equals expense / broad_order (cost per conversion), NOT
//     expense / clicks — UI CPC is always derived from primitives.
// ============================================================
import type { Decimal } from "../../core/types.ts";

export class AdsPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsPayloadError";
  }
}

// ------------------------------------------------------------------ canonical write models

export interface AdsCampaignWrite {
  providerCampaignId: string;
  campaignName: string | null;
  providerStatus: string;
  providerAdType: string | null;
  providerBiddingMethod: string | null;
  providerPlacement: string | null;
  /** Daily spend cap (verified daily semantics). */
  dailyBudget: Decimal | null;
  roasTarget: Decimal | null;
  providerStartAt: string | null;
  providerEndAt: string | null;
  itemIds: string[];
}

export interface AdsPerformancePrimitives {
  /** YYYY-MM-DD (shop-local report date as returned). */
  reportDate: string;
  expense: Decimal;
  impression: number;
  clicks: number;
  directOrder: number;
  broadOrder: number;
  directGmv: Decimal;
  broadGmv: Decimal;
  directItemSold: number;
  broadItemSold: number;
}

export interface AdsCampaignPerformanceWrite extends AdsPerformancePrimitives {
  providerCampaignId: string;
}

export interface AdsCampaignIdPage {
  campaignIds: string[];
  hasNextPage: boolean;
  /** Raw page length (offset advance). */
  count: number;
}

// ------------------------------------------------------------------ primitives

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Provider ids are 64-bit integers: number or numeric string → text. */
export function providerId(v: unknown, what: string): string {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) return v;
  throw new AdsPayloadError(`${what} không hợp lệ.`);
}

/** "DD-MM-YYYY" → "YYYY-MM-DD" (validated calendar date; no locale parser). */
export function parseAdsDate(v: unknown): string {
  if (typeof v !== "string") throw new AdsPayloadError("Ngày báo cáo không hợp lệ.");
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v.trim());
  if (!m) throw new AdsPayloadError(`Ngày báo cáo không đúng định dạng DD-MM-YYYY: ${v.slice(0, 20)}`);
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (d.getUTCFullYear() !== Number(yyyy) || d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) {
    throw new AdsPayloadError(`Ngày báo cáo không tồn tại: ${v}`);
  }
  return `${yyyy}-${mm}-${dd}`;
}

/** "YYYY-MM-DD" → provider "DD-MM-YYYY" (request parameter). */
export function formatAdsDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new AdsPayloadError(`Ngày không hợp lệ: ${iso}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Epoch SECONDS (verified unit) → ISO; 0 / missing → null. Millisecond-looking values are refused, never guessed. */
export function epochSecondsToIso(v: unknown): string | null {
  if (v === null || v === undefined || v === 0 || v === "0") return null;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new AdsPayloadError("Thời gian chiến dịch không hợp lệ.");
  if (n > 1e11) throw new AdsPayloadError("Thời gian chiến dịch không phải epoch giây (đơn vị không như đã xác minh).");
  return new Date(n * 1000).toISOString();
}

/** Non-negative count; missing → 0 (counted by the caller as a missing field). */
function count(v: unknown, missing: { n: number }): number {
  if (v === null || v === undefined) {
    missing.n++;
    return 0;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new AdsPayloadError("Chỉ số đếm không hợp lệ.");
  return Math.round(v);
}

/** Non-negative money (VND) → exact decimal string, at most 2 decimals; missing → "0". */
export function money(v: unknown, missing: { n: number } = { n: 0 }): Decimal {
  if (v === null || v === undefined) {
    missing.n++;
    return "0";
  }
  const n = typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new AdsPayloadError("Số tiền không hợp lệ.");
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
}

function optionalMoney(v: unknown): Decimal | null {
  return v === null || v === undefined ? null : money(v);
}

function optionalText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function responseOf(envelope: unknown): unknown {
  return isObj(envelope) && "response" in envelope ? envelope.response : envelope;
}

// ------------------------------------------------------------------ endpoint parsers

/** get_product_level_campaign_id_list → ids + paging. */
export function parseCampaignIdPage(envelope: unknown): AdsCampaignIdPage {
  const r = responseOf(envelope);
  if (!isObj(r)) throw new AdsPayloadError("Danh sách chiến dịch không có response.");
  const list = arr(r.campaign_list);
  return {
    campaignIds: list.map((c) => providerId(isObj(c) ? c.campaign_id : undefined, "campaign_id")),
    hasNextPage: r.has_next_page === true,
    count: list.length,
  };
}

/** get_product_level_campaign_setting_info → campaign rows (one bad campaign does not fail the batch). */
export function parseCampaignSettings(envelope: unknown): { campaigns: AdsCampaignWrite[]; failures: Array<{ id: string | null; reason: string }> } {
  const r = responseOf(envelope);
  if (!isObj(r)) throw new AdsPayloadError("Thông tin chiến dịch không có response.");
  const campaigns: AdsCampaignWrite[] = [];
  const failures: Array<{ id: string | null; reason: string }> = [];
  for (const raw of arr(r.campaign_list)) {
    let id: string | null = null;
    try {
      if (!isObj(raw)) throw new AdsPayloadError("Chiến dịch không phải object.");
      id = providerId(raw.campaign_id, "campaign_id");
      const common = isObj(raw.common_info) ? raw.common_info : {};
      const duration = isObj(common.campaign_duration) ? common.campaign_duration : {};
      const auto = isObj(raw.auto_bidding_info) ? raw.auto_bidding_info : null;
      const status = optionalText(common.campaign_status);
      if (!status) throw new AdsPayloadError("Thiếu campaign_status.");
      campaigns.push({
        providerCampaignId: id,
        campaignName: optionalText(common.ad_name),
        providerStatus: status,
        providerAdType: optionalText(common.ad_type),
        providerBiddingMethod: optionalText(common.bidding_method),
        providerPlacement: optionalText(common.campaign_placement),
        dailyBudget: optionalMoney(common.campaign_budget),
        roasTarget: auto && typeof auto.roas_target === "number" && Number.isFinite(auto.roas_target) && auto.roas_target >= 0 ? String(auto.roas_target) : null,
        providerStartAt: epochSecondsToIso(duration.start_time),
        providerEndAt: epochSecondsToIso(duration.end_time),
        itemIds: [...new Set(arr(common.item_id_list).map((i) => providerId(i, "item_id")))],
      });
    } catch (err) {
      failures.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { campaigns, failures };
}

function primitivesOf(m: Obj, kind: "shop" | "campaign", missing: { n: number }): AdsPerformancePrimitives {
  return {
    reportDate: parseAdsDate(m.date),
    expense: money(m.expense, missing),
    impression: count(m.impression, missing),
    clicks: count(m.clicks, missing),
    directOrder: count(m.direct_order, missing),
    broadOrder: count(m.broad_order, missing),
    directGmv: money(m.direct_gmv, missing),
    broadGmv: money(m.broad_gmv, missing),
    // shop rows: *_item_sold; campaign rows: *_order_amount (≈ units sold)
    directItemSold: count(kind === "shop" ? m.direct_item_sold : m.direct_order_amount, missing),
    broadItemSold: count(kind === "shop" ? m.broad_item_sold : m.broad_order_amount, missing),
  };
}

/** get_product_campaign_daily_performance → one row per (campaign, date). Hourly rows are refused. */
export function parseCampaignDailyPerformance(envelope: unknown): { rows: AdsCampaignPerformanceWrite[]; missingFields: number; failures: Array<{ id: string | null; reason: string }> } {
  const r = responseOf(envelope);
  if (!isObj(r)) throw new AdsPayloadError("Hiệu quả chiến dịch không có response.");
  const missing = { n: 0 };
  const rows: AdsCampaignPerformanceWrite[] = [];
  const failures: Array<{ id: string | null; reason: string }> = [];
  for (const c of arr(r.campaign_list)) {
    let id: string | null = null;
    try {
      if (!isObj(c)) throw new AdsPayloadError("Chiến dịch không phải object.");
      id = providerId(c.campaign_id, "campaign_id");
      for (const m of arr(c.metrics_list)) {
        if (!isObj(m)) throw new AdsPayloadError("Dòng chỉ số không phải object.");
        if ("hour" in m) throw new AdsPayloadError("Dòng theo giờ không được lưu ở bảng ngày.");
        rows.push({ providerCampaignId: id, ...primitivesOf(m, "campaign", missing) });
      }
    } catch (err) {
      failures.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rows, missingFields: missing.n, failures };
}

/** get_all_cpc_ads_daily_performance → one row per date (shop-level "all CPC ads" total). */
export function parseShopDailyPerformance(envelope: unknown): { rows: AdsPerformancePrimitives[]; missingFields: number } {
  const r = responseOf(envelope);
  if (!Array.isArray(r)) throw new AdsPayloadError("Hiệu quả cấp shop không phải mảng.");
  const missing = { n: 0 };
  const rows = r.map((m) => {
    if (!isObj(m)) throw new AdsPayloadError("Dòng chỉ số shop không phải object.");
    if ("hour" in m) throw new AdsPayloadError("Dòng theo giờ không được lưu ở bảng ngày.");
    return primitivesOf(m, "shop", missing);
  });
  return { rows, missingFields: missing.n };
}

// ------------------------------------------------------------------ UI mapping of raw provider values

export type AdsUiStatus = "active" | "paused" | "ended" | "closed" | "unknown";

/** Verified raw statuses (docs §3.5). Anything else stays raw and shows as neutral "unknown". */
export function mapAdsCampaignStatus(raw: string | null | undefined): AdsUiStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "ongoing":
      return "active";
    case "paused":
      return "paused";
    case "ended":
      return "ended";
    case "closed":
      return "closed";
    default:
      return "unknown";
  }
}

export type AdsUiType = "auto" | "search" | "discovery" | "all_placements" | "other";

/** auto bidding → "auto"; manual bidding → its placement (search / discovery / all). Unknown → "other". */
export function mapAdsCampaignType(bidding: string | null | undefined, placement: string | null | undefined): AdsUiType {
  if ((bidding ?? "").toLowerCase() === "auto") return "auto";
  switch ((placement ?? "").toLowerCase()) {
    case "search":
      return "search";
    case "discovery":
      return "discovery";
    case "all":
      return "all_placements";
    default:
      return "other";
  }
}
