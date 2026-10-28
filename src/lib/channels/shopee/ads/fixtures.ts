// ============================================================
// SHOPEE-ADS-UI-1: deterministic FIXTURE data for the Ads dashboard.
//
// No Shopee call, no DB: every number is a pure function of
// (campaign, day, hour) through a seeded PRNG, so the same URL renders the
// same dashboard and tests can assert on it. The output is the
// AdsDashboardData view model — the exact shape the real source
// (SHOPEE-ADS-1) will return, so the UI never depends on fixture quirks.
//
// Campaign archetypes the UI must handle: high-performing, high-ROAS,
// low-performing, high-spend, zero-order, paused, ended, declining CTR.
// Names are generic — never real production campaigns.
// ============================================================

import { addDays, daysBetween, vnToday } from "../../../analytics/periods.ts";

import { adsPreviousRange } from "./filters.ts";
import { addTotals, adsDeltaPercent, deriveMetrics, FLAT_DELTA_PCT, ZERO_TOTALS } from "./metrics.ts";
import type {
  AdsCampaignRow,
  AdsCampaignStatus,
  AdsCampaignType,
  AdsDashboardData,
  AdsFilters,
  AdsInsight,
  AdsMetricValues,
  AdsShopOption,
  AdsTotals,
  AdsTrendPoint,
} from "./view-models.ts";

export const FIXTURE_SHOPS: AdsShopOption[] = [
  { id: "demo-shop-1", name: "Shop 1" },
  { id: "demo-shop-2", name: "Shop 2" },
];

interface CampaignSpec {
  id: string;
  name: string;
  shopId: string;
  type: AdsCampaignType;
  status: AdsCampaignStatus;
  dailyBudget: number | null;
  /** Typical spend per day before noise (VND). */
  spend: number;
  cpc: number;
  ctr: number;
  cvr: number;
  aov: number;
  /** First active day, relative to today (days ago). */
  startDaysAgo: number;
  /** Last active day (days ago) — paused / ended campaigns. */
  stopDaysAgo?: number;
  /** Per-day multiplicative drift of CTR (declining creative). */
  ctrDrift?: number;
  products: string[];
}

const P = (...names: string[]) => names.map((n) => `Sản phẩm mẫu ${n}`);

export const FIXTURE_CAMPAIGNS: CampaignSpec[] = [
  // high-performing
  { id: "cmp-001", name: "Search - Best Sellers", shopId: "demo-shop-1", type: "search", status: "active", dailyBudget: 1_500_000, spend: 1_150_000, cpc: 1_900, ctr: 0.036, cvr: 0.042, aov: 245_000, startDaysAgo: 120, products: P("A1", "A2", "A3") },
  // high-ROAS
  { id: "cmp-002", name: "Search - Brand Keywords", shopId: "demo-shop-1", type: "search", status: "active", dailyBudget: 600_000, spend: 420_000, cpc: 1_350, ctr: 0.058, cvr: 0.061, aov: 268_000, startDaysAgo: 200, products: P("B1", "B2") },
  // high-spend, average return
  { id: "cmp-003", name: "Search - Main SKUs", shopId: "demo-shop-2", type: "search", status: "active", dailyBudget: 4_000_000, spend: 3_350_000, cpc: 2_450, ctr: 0.029, cvr: 0.031, aov: 255_000, startDaysAgo: 150, products: P("C1", "C2", "C3") },
  // low-performing → needs attention
  { id: "cmp-004", name: "Discovery - New Arrivals", shopId: "demo-shop-2", type: "discovery", status: "warning", dailyBudget: 900_000, spend: 780_000, cpc: 2_650, ctr: 0.014, cvr: 0.011, aov: 198_000, startDaysAgo: 45, products: P("D1", "D2") },
  // zero-order: spends budget, no orders
  { id: "cmp-005", name: "Discovery - Combo Test", shopId: "demo-shop-1", type: "discovery", status: "warning", dailyBudget: 400_000, spend: 330_000, cpc: 2_200, ctr: 0.012, cvr: 0, aov: 310_000, startDaysAgo: 12, products: P("E1") },
  // paused 9 days ago
  { id: "cmp-006", name: "Retargeting - Seasonal", shopId: "demo-shop-1", type: "discovery", status: "paused", dailyBudget: 700_000, spend: 520_000, cpc: 1_700, ctr: 0.041, cvr: 0.038, aov: 230_000, startDaysAgo: 90, stopDaysAgo: 9, products: P("F1", "F2") },
  // ended 16 days ago
  { id: "cmp-007", name: "Shop Ads - Flash Sale", shopId: "demo-shop-2", type: "shop", status: "ended", dailyBudget: 2_000_000, spend: 1_650_000, cpc: 1_550, ctr: 0.047, cvr: 0.052, aov: 189_000, startDaysAgo: 40, stopDaysAgo: 16, products: P("G1", "G2", "G3") },
  // solid, declining CTR (creative fatigue)
  { id: "cmp-008", name: "Retargeting - Main SKUs", shopId: "demo-shop-2", type: "discovery", status: "active", dailyBudget: 1_200_000, spend: 880_000, cpc: 1_600, ctr: 0.052, cvr: 0.047, aov: 236_000, startDaysAgo: 75, ctrDrift: -0.012, products: P("H1", "H2") },
  { id: "cmp-009", name: "Discovery - Combo", shopId: "demo-shop-1", type: "discovery", status: "active", dailyBudget: 800_000, spend: 610_000, cpc: 1_950, ctr: 0.027, cvr: 0.029, aov: 348_000, startDaysAgo: 60, products: P("I1", "I2") },
  { id: "cmp-010", name: "Shop Ads - Brand Store", shopId: "demo-shop-1", type: "shop", status: "active", dailyBudget: 500_000, spend: 360_000, cpc: 1_250, ctr: 0.044, cvr: 0.033, aov: 214_000, startDaysAgo: 180, products: P("J1", "J2") },
  { id: "cmp-011", name: "Auto - Catalog", shopId: "demo-shop-2", type: "auto", status: "active", dailyBudget: 1_000_000, spend: 720_000, cpc: 2_050, ctr: 0.024, cvr: 0.035, aov: 262_000, startDaysAgo: 100, products: P("K1", "K2", "K3") },
  { id: "cmp-012", name: "Search - Long Tail", shopId: "demo-shop-2", type: "search", status: "active", dailyBudget: 350_000, spend: 240_000, cpc: 1_150, ctr: 0.031, cvr: 0.039, aov: 205_000, startDaysAgo: 130, products: P("L1", "L2") },
  { id: "cmp-013", name: "Discovery - Bundles", shopId: "demo-shop-2", type: "discovery", status: "paused", dailyBudget: 600_000, spend: 450_000, cpc: 2_300, ctr: 0.022, cvr: 0.024, aov: 372_000, startDaysAgo: 70, stopDaysAgo: 3, products: P("M1") },
  { id: "cmp-014", name: "Auto - New Products", shopId: "demo-shop-1", type: "auto", status: "active", dailyBudget: 450_000, spend: 300_000, cpc: 1_800, ctr: 0.026, cvr: 0.027, aov: 228_000, startDaysAgo: 20, products: P("N1", "N2") },
];

/** 120 campaigns for the performance / pagination check (?demo=large). */
export function largeFixtureCampaigns(count = 120): CampaignSpec[] {
  const out: CampaignSpec[] = [];
  for (let i = 0; i < count; i++) {
    const base = FIXTURE_CAMPAIGNS[i % FIXTURE_CAMPAIGNS.length];
    const r = rng(hash(`large-${i}`));
    const k = 0.5 + r() * 1.2;
    out.push({
      ...base,
      id: `cmp-l${String(i + 1).padStart(3, "0")}`,
      name: `${base.name.split(" - ")[0]} - Nhóm ${String(i + 1).padStart(3, "0")}`,
      shopId: FIXTURE_SHOPS[i % 2].id,
      spend: Math.round(base.spend * k),
      dailyBudget: base.dailyBudget === null ? null : Math.round(base.dailyBudget * k),
      cvr: base.cvr * (0.7 + r() * 0.6),
    });
  }
  return out;
}

// ---------------- deterministic PRNG ----------------

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Share of a day's activity per VN hour (sums to 1): quiet night, lunch + evening peaks. */
const HOUR_WEIGHTS = (() => {
  const raw = [0.6, 0.35, 0.2, 0.15, 0.15, 0.25, 0.6, 1.1, 1.6, 1.9, 2.1, 2.4, 2.6, 2.2, 1.9, 1.8, 1.9, 2.0, 2.3, 2.8, 3.3, 3.5, 2.8, 1.5];
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
})();

function vnHour(now: Date): number {
  return new Date(now.getTime() + 7 * 3_600_000).getUTCHours();
}

/** Fraction of today already elapsed (activity-weighted), e.g. 0.42 at 14h. */
function todayFraction(now: Date): number {
  const h = vnHour(now);
  return HOUR_WEIGHTS.slice(0, h + 1).reduce((a, b) => a + b, 0);
}

/** One campaign, one full VN day (before the "today so far" cut). */
function campaignDay(c: CampaignSpec, day: string, today: string): AdsTotals {
  const ago = daysBetween(day, today) - 1;
  if (ago < 0 || ago > c.startDaysAgo || (c.stopDaysAgo !== undefined && ago < c.stopDaysAgo)) return ZERO_TOTALS;
  const r = rng(hash(`${c.id}|${day}`));
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const dom = Number(day.slice(8, 10));
  const mon = Number(day.slice(5, 7));
  const seasonal = (dow === 0 || dow === 6 ? 1.12 : 1) * (dom === mon ? 1.65 : dom === 15 || dom === 25 ? 1.25 : 1);
  const growth = 1 + 0.004 * (60 - Math.min(ago, 60)); // gently rising lately
  let spend = c.spend * seasonal * growth * (0.78 + r() * 0.44);
  if (c.dailyBudget !== null) spend = Math.min(spend, c.dailyBudget);
  spend = Math.round(spend / 100) * 100;
  const cpc = c.cpc * (0.88 + r() * 0.24);
  const clicks = Math.max(0, Math.round(spend / cpc));
  const ctr = c.ctr * (0.9 + r() * 0.2) * (c.ctrDrift ? Math.max(0.35, 1 + c.ctrDrift * (30 - Math.min(ago, 30))) : 1);
  const impressions = ctr > 0 ? Math.round(clicks / ctr) : 0;
  const orders = c.cvr > 0 ? Math.floor(clicks * c.cvr * seasonal * (0.75 + r() * 0.5) + r()) : 0;
  const revenue = Math.round((orders * c.aov * (0.85 + r() * 0.3)) / 1000) * 1000;
  return { spend, revenue, orders, clicks, impressions };
}

const scale = (t: AdsTotals, f: number): AdsTotals => ({
  spend: Math.round(t.spend * f),
  revenue: Math.round(t.revenue * f),
  orders: Math.round(t.orders * f),
  clicks: Math.round(t.clicks * f),
  impressions: Math.round(t.impressions * f),
});

/** Day totals as visible "now": today is cut at the current hour. */
function campaignDayNow(c: CampaignSpec, day: string, today: string, now: Date): AdsTotals {
  const full = campaignDay(c, day, today);
  return day === today ? scale(full, todayFraction(now)) : full;
}

function daysOf(from: string, to: string): string[] {
  const n = daysBetween(from, to);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(from, i));
}

const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

interface Bucket {
  key: string;
  label: string;
  /** (campaign) → totals in this bucket */
  get: (c: CampaignSpec) => AdsTotals;
}

function buckets(f: AdsFilters, today: string, now: Date): { granularity: AdsDashboardData["granularity"]; list: Bucket[] } {
  const days = daysOf(f.from, f.to);
  if (days.length === 1) {
    const day = days[0];
    const lastHour = day === today ? vnHour(now) : 23;
    const list: Bucket[] = [];
    for (let h = 0; h <= lastHour; h++) {
      list.push({
        key: `${day}T${String(h).padStart(2, "0")}`,
        label: `${h}h`,
        get: (c) => scale(campaignDay(c, day, today), HOUR_WEIGHTS[h]),
      });
    }
    return { granularity: "hour", list };
  }
  if (days.length <= 92) {
    return { granularity: "day", list: days.map((d) => ({ key: d, label: dayLabel(d), get: (c) => campaignDayNow(c, d, today, now) })) };
  }
  const list: Bucket[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    list.push({ key: chunk[0], label: dayLabel(chunk[0]), get: (c) => chunk.reduce((acc, d) => addTotals(acc, campaignDayNow(c, d, today, now)), ZERO_TOTALS) });
  }
  return { granularity: "week", list };
}

function rangeTotals(c: CampaignSpec, from: string, to: string, today: string, now: Date, cutPreviousAtHour: boolean): AdsTotals {
  return daysOf(from, to).reduce((acc, d) => {
    // "Hôm nay" compares with yesterday up to the same hour — not a full day.
    const t = cutPreviousAtHour ? scale(campaignDay(c, d, today), todayFraction(now)) : campaignDayNow(c, d, today, now);
    return addTotals(acc, t);
  }, ZERO_TOTALS);
}

function activeDays(c: CampaignSpec, from: string, to: string, today: string): number {
  return daysOf(from, to).filter((d) => {
    const ago = daysBetween(d, today) - 1;
    return ago >= 0 && ago <= c.startDaysAgo && (c.stopDaysAgo === undefined || ago >= c.stopDaysAgo);
  }).length;
}

const SPARK_KEYS: Array<keyof AdsMetricValues> = ["spend", "revenue", "orders", "clicks", "impressions", "roas", "acos", "ctr", "cpc", "conversionRate"];

function demoInsights(cur: AdsMetricValues, prev: AdsMetricValues, rows: AdsCampaignRow[]): AdsInsight[] {
  const out: AdsInsight[] = [];
  const d = (k: keyof AdsMetricValues) => adsDeltaPercent(cur[k], prev[k]);
  const spendD = d("spend");
  const revD = d("revenue");
  if (spendD !== null && revD !== null && spendD > FLAT_DELTA_PCT && revD < -FLAT_DELTA_PCT) {
    out.push({ id: "spend-up-revenue-down", tone: "warning", title: "Chi tiêu tăng nhưng doanh thu giảm", description: `Chi tiêu tăng ${spendD.toFixed(1).replace(".", ",")}% trong khi doanh thu giảm ${Math.abs(revD).toFixed(1).replace(".", ",")}% so với kỳ trước.` });
  }
  const noOrder = rows.filter((r) => r.metrics.spend > 0 && r.metrics.orders === 0).sort((a, b) => b.metrics.spend - a.metrics.spend)[0];
  if (noOrder) {
    out.push({ id: `no-order-${noOrder.id}`, tone: "danger", title: "Campaign tiêu ngân sách nhưng chưa có đơn", description: `"${noOrder.name}" đã chi tiêu nhưng chưa ghi nhận đơn nào trong kỳ.`, campaignName: noOrder.name });
  }
  const roasD = d("roas");
  if (roasD !== null && roasD > FLAT_DELTA_PCT) {
    out.push({ id: "roas-up", tone: "success", title: "ROAS cao hơn kỳ trước", description: `ROAS tăng ${roasD.toFixed(1).replace(".", ",")}% — mỗi đồng quảng cáo mang về nhiều doanh thu hơn.` });
  } else if (roasD !== null && roasD < -FLAT_DELTA_PCT) {
    out.push({ id: "roas-down", tone: "warning", title: "ROAS thấp hơn kỳ trước", description: `ROAS giảm ${Math.abs(roasD).toFixed(1).replace(".", ",")}% so với kỳ trước.` });
  }
  const ctrD = d("ctr");
  if (ctrD !== null && ctrD < -FLAT_DELTA_PCT) {
    out.push({ id: "ctr-down", tone: "warning", title: "CTR đang giảm", description: `CTR giảm ${Math.abs(ctrD).toFixed(1).replace(".", ",")}% — có thể cần làm mới hình ảnh / tiêu đề quảng cáo.` });
  }
  const nearCap = rows.find((r) => r.status === "active" && r.periodBudget && r.metrics.spend / r.periodBudget >= 0.92);
  if (nearCap) {
    out.push({ id: `budget-${nearCap.id}`, tone: "info", title: "Sắp chạm trần ngân sách", description: `"${nearCap.name}" đã dùng ${Math.round((nearCap.metrics.spend / (nearCap.periodBudget ?? 1)) * 100)}% ngân sách trong kỳ.`, campaignName: nearCap.name });
  }
  return out.slice(0, 4);
}

export interface FixtureOptions {
  now?: Date;
  scenario?: "empty" | "unsynced" | "large" | null;
}

/** Builds the whole dashboard view model from fixtures (pure, synchronous). */
export function buildFixtureDashboard(input: AdsFilters, opts: FixtureOptions = {}): AdsDashboardData {
  const now = opts.now ?? new Date();
  const today = vnToday(now);
  const filters: AdsFilters = { ...input, shop: FIXTURE_SHOPS.some((s) => s.id === input.shop) ? input.shop : "all" };
  const prevRange = adsPreviousRange(filters);
  const all = opts.scenario === "empty" || opts.scenario === "unsynced" ? [] : opts.scenario === "large" ? largeFixtureCampaigns() : FIXTURE_CAMPAIGNS;
  const specs = all.filter((c) => (filters.shop === "all" || c.shopId === filters.shop) && (filters.type === "all" || c.type === filters.type));
  const { granularity, list } = buckets(filters, today, now);
  const cutPrev = filters.preset === "today";

  const shopName = new Map(FIXTURE_SHOPS.map((s) => [s.id, s.name]));
  const allStatusRows: AdsCampaignRow[] = specs
    .map((c) => {
      const totals = rangeTotals(c, filters.from, filters.to, today, now, false);
      const days = activeDays(c, filters.from, filters.to, today);
      const metrics = deriveMetrics(totals);
      const shares = c.products.length === 1 ? [1] : c.products.length === 2 ? [0.62, 0.38] : [0.5, 0.3, 0.2];
      return {
        id: c.id,
        name: c.name,
        shopId: c.shopId,
        shopName: shopName.get(c.shopId) ?? c.shopId,
        type: c.type,
        status: c.status,
        dailyBudget: c.dailyBudget,
        periodBudget: c.dailyBudget === null ? null : c.dailyBudget * days,
        metrics,
        trend: list.map((b) => {
          const t = b.get(c);
          return { label: b.label, spend: t.spend, revenue: t.revenue };
        }),
        topProducts: c.products.map((name, i) => ({
          name,
          spend: Math.round(totals.spend * shares[i]),
          revenue: Math.round(totals.revenue * shares[i]),
          orders: Math.round(totals.orders * shares[i]),
        })),
      } satisfies AdsCampaignRow;
    })
    // a campaign with no activity at all in the period is not listed
    .filter((r) => r.metrics.spend > 0 || r.metrics.impressions > 0 || r.status === "active");
  const campaigns = filters.status === "all" ? allStatusRows : allStatusRows.filter((r) => r.status === filters.status);
  const statusCounts = { all: allStatusRows.length, active: 0, paused: 0, ended: 0, warning: 0 };
  for (const r of allStatusRows) statusCounts[r.status]++;

  const listed = new Set(campaigns.map((r) => r.id));
  const live = specs.filter((c) => listed.has(c.id));
  const current = deriveMetrics(campaigns.reduce((acc, r) => addTotals(acc, r.metrics), ZERO_TOTALS));
  const previous = deriveMetrics(live.reduce((acc, c) => addTotals(acc, rangeTotals(c, prevRange.from, prevRange.to, today, now, cutPrev)), ZERO_TOTALS));

  const bucketTotals = list.map((b) => live.reduce((acc, c) => addTotals(acc, b.get(c)), ZERO_TOTALS));
  const trend: AdsTrendPoint[] = list.map((b, i) => {
    const t = bucketTotals[i];
    return { key: b.key, label: b.label, spend: t.spend, revenue: t.revenue, orders: t.orders, clicks: t.clicks, roas: t.spend > 0 ? t.revenue / t.spend : null };
  });
  const sparkRows = bucketTotals.map(deriveMetrics);
  const spark = Object.fromEntries(SPARK_KEYS.map((k) => [k, sparkRows.map((m) => m[k] ?? 0)])) as Record<keyof AdsMetricValues, number[]>;
  const budget = campaigns.reduce((acc, r) => acc + (r.periodBudget ?? 0), 0);

  return {
    filters,
    previousRange: prevRange,
    granularity,
    shops: FIXTURE_SHOPS,
    overview: { current, previous, spark, budget },
    trend,
    campaigns,
    statusCounts,
    insights: demoInsights(current, previous, campaigns),
    sync: {
      state: opts.scenario === "unsynced" ? "never" : "fresh",
      lastSyncedAt: opts.scenario === "unsynced" ? null : new Date(now.getTime() - 3 * 60_000).toISOString(),
      source: "fixture",
    },
    generatedAt: now.toISOString(),
  };
}
