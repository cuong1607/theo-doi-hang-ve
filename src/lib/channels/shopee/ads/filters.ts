// ============================================================
// SHOPEE-ADS-UI-1: Ads dashboard URL state (pure — unit tested).
//
// Global filters live in the query string (?period=7d&shop=…&status=…&type=…)
// so refresh / back / sharing keep the view. Dates reuse the analytics
// period helpers (Vietnam calendar days). The campaign table adds
// ?q=&sort=&dir=&page=&size= and is sorted / paged on the server.
// ============================================================

import { isPeriodPreset, previousPeriod, resolvePeriod, type PeriodPreset } from "../../../analytics/periods.ts";
import { parsePage, parsePageSize, type PageSize } from "../../../ui/list-query.ts";

import type { AdsCampaignRow, AdsCampaignStatus, AdsCampaignType, AdsFilters } from "./view-models.ts";

export const ADS_DEFAULT_PRESET: PeriodPreset = "7d";

/** Preset chip labels (short — they sit in a pill bar). */
export const ADS_PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Hôm nay",
  yesterday: "Hôm qua",
  "7d": "7 ngày",
  "30d": "30 ngày",
  this_month: "Tháng này",
  last_month: "Tháng trước",
  custom: "Tùy chỉnh",
};

export const ADS_STATUS_OPTIONS: Array<{ value: AdsCampaignStatus | "all"; label: string }> = [
  { value: "all", label: "Mọi trạng thái" },
  { value: "active", label: "Đang chạy" },
  { value: "paused", label: "Tạm dừng" },
  { value: "ended", label: "Đã kết thúc" },
  { value: "closed", label: "Đã đóng" },
  { value: "warning", label: "Cần chú ý" },
  { value: "unknown", label: "Trạng thái khác" },
];

export const ADS_TYPE_OPTIONS: Array<{ value: AdsCampaignType | "all"; label: string }> = [
  { value: "all", label: "Mọi loại" },
  { value: "auto", label: "Đặt giá tự động" },
  { value: "search", label: "Tìm kiếm" },
  { value: "discovery", label: "Khám phá" },
  { value: "all_placements", label: "Mọi vị trí (giá thủ công)" },
  { value: "shop", label: "Quảng cáo Shop" },
  { value: "other", label: "Loại khác" },
];

const STATUSES = new Set(ADS_STATUS_OPTIONS.map((o) => o.value));
const TYPES = new Set(ADS_TYPE_OPTIONS.map((o) => o.value));

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Demo switches for QA / tests: fixture-only states of the dashboard. */
export const ADS_DEMO_SCENARIOS = ["empty", "error", "unsynced", "large", "slow"] as const;
export type AdsDemoScenario = (typeof ADS_DEMO_SCENARIOS)[number];

export function parseAdsDemo(q: Query): AdsDemoScenario | null {
  const v = one(q.demo);
  return v && (ADS_DEMO_SCENARIOS as readonly string[]).includes(v) ? (v as AdsDemoScenario) : null;
}

export function parseAdsFilters(q: Query, now: Date = new Date()): AdsFilters {
  const rawPreset = one(q.period);
  const period = resolvePeriod({ preset: isPeriodPreset(rawPreset) ? rawPreset : undefined, from: one(q.from), to: one(q.to) }, now, ADS_DEFAULT_PRESET);
  const status = one(q.status);
  const type = one(q.type);
  const shop = one(q.shop);
  return {
    preset: period.preset,
    from: period.from,
    to: period.to,
    shop: shop && /^[\w-]{1,64}$/.test(shop) ? shop : "all",
    status: status && STATUSES.has(status as AdsCampaignStatus) ? (status as AdsCampaignStatus) : "all",
    type: type && TYPES.has(type as AdsCampaignType) ? (type as AdsCampaignType) : "all",
  };
}

export function adsPreviousRange(f: AdsFilters): { from: string; to: string } {
  return previousPeriod({ preset: f.preset, from: f.from, to: f.to });
}

/** 21/10 – 27/10/2026 (or a single day). */
export function formatAdsRange(from: string, to: string): string {
  const d = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  return from === to ? `${d(from)}/${from.slice(0, 4)}` : `${d(from)} – ${d(to)}/${to.slice(0, 4)}`;
}

// ---------------- campaign table ----------------

export const ADS_SORT_COLUMNS = ["name", "status", "budget", "spend", "revenue", "orders", "roas", "ctr", "cpc", "acos"] as const;
export type AdsSortColumn = (typeof ADS_SORT_COLUMNS)[number];

export interface AdsTableQuery {
  q: string;
  sort: AdsSortColumn;
  desc: boolean;
  page: number;
  size: PageSize;
}

export function parseAdsTableQuery(q: Query): AdsTableQuery {
  const sort = one(q.sort);
  const dir = one(q.dir);
  return {
    q: (one(q.q) ?? "").trim().slice(0, 100),
    sort: sort && (ADS_SORT_COLUMNS as readonly string[]).includes(sort) ? (sort as AdsSortColumn) : "spend",
    desc: dir !== "asc",
    page: parsePage(one(q.page)),
    size: parsePageSize(one(q.size)),
  };
}

const STATUS_ORDER: Record<AdsCampaignStatus, number> = { warning: 0, active: 1, paused: 2, ended: 3, closed: 4, unknown: 5 };

function sortValue(row: AdsCampaignRow, col: AdsSortColumn): number | string | null {
  switch (col) {
    case "name":
      return row.name.toLocaleLowerCase("vi");
    case "status":
      return STATUS_ORDER[row.status];
    case "budget":
      return row.dailyBudget;
    default:
      return row.metrics[col];
  }
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** Search (accent-insensitive) → sort (nulls last either way) → page. */
export function queryCampaigns(rows: AdsCampaignRow[], t: AdsTableQuery): { rows: AdsCampaignRow[]; total: number; page: number } {
  const needle = fold(t.q);
  // campaign name, shop, and (ADS-3A.2) advertised product name / SKU / provider item id — accent-insensitive
  const haystack = (r: AdsCampaignRow) => fold([r.name, r.shopName, ...r.topProducts.flatMap((p) => [p.name, p.sku ?? "", p.itemId ?? ""])].join(" "));
  const matched = needle ? rows.filter((r) => haystack(r).includes(needle)) : rows;
  const sorted = [...matched].sort((a, b) => {
    const va = sortValue(a, t.sort);
    const vb = sortValue(b, t.sort);
    if (va === null && vb === null) return a.name.localeCompare(b.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === "string" ? va.localeCompare(String(vb), "vi") : va - (vb as number);
    return (t.desc ? -c : c) || a.id.localeCompare(b.id);
  });
  const totalPages = Math.max(1, Math.ceil(sorted.length / t.size));
  const page = Math.min(t.page, totalPages);
  return { rows: sorted.slice((page - 1) * t.size, page * t.size), total: sorted.length, page };
}
