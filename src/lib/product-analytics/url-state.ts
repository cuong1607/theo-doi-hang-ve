// ============================================================
// PRODUCT-ANALYTICS-2/3: /shopee/product-analytics URL state (pure, tested).
// ?period=7d|30d|today|yesterday|custom&from&to&shop=<uuid|all>&q&ads=with|without
// &status=NORMAL|UNLIST|…&health=GOOD|…|ATTENTION&signal=SALES_DOWN|…&sort&dir&page&size
// Everything is applied by SQL (product_intelligence_list); values are validated here.
// ============================================================
import { INTEL_PAGE_SIZES, INTEL_SORTS, isHealthFilter, isSignalFilter, type IntelListQuery, type IntelSort } from "./intelligence.ts";
import { resolveProductPeriod, type ProductPeriod } from "./periods.ts";

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const PRODUCT_LIST_PAGE_SIZE = 50;

export interface ProductAnalyticsUrlState {
  period: ProductPeriod;
  shop: string;
  list: Required<Pick<IntelListQuery, "q" | "ads" | "status" | "health" | "signal" | "sort" | "dir" | "page" | "pageSize">>;
}

export function parseProductAnalyticsQuery(sp: Query, now: Date = new Date()): ProductAnalyticsUrlState {
  const period = resolveProductPeriod({ preset: one(sp.period), from: one(sp.from), to: one(sp.to) }, now);
  const shop = one(sp.shop);
  const ads = one(sp.ads);
  const status = one(sp.status);
  const health = one(sp.health);
  const signal = one(sp.signal);
  const sort = one(sp.sort);
  const page = Number(one(sp.page));
  const size = Number(one(sp.size));
  return {
    period,
    shop: shop && /^[0-9a-f-]{36}$/i.test(shop) ? shop : "all",
    list: {
      q: (one(sp.q) ?? "").slice(0, 100),
      ads: ads === "with" || ads === "without" ? ads : "all",
      status: status && /^[A-Z_]{2,30}$/.test(status) ? status : "all",
      health: isHealthFilter(health) ? health : "all",
      signal: isSignalFilter(signal) ? signal : "all",
      sort: INTEL_SORTS.includes(sort as IntelSort) ? (sort as IntelSort) : "priority",
      dir: one(sp.dir) === "asc" ? "asc" : "desc",
      page: Number.isInteger(page) && page > 0 && page < 10_000 ? page : 1,
      pageSize: (INTEL_PAGE_SIZES as readonly number[]).includes(size) ? size : PRODUCT_LIST_PAGE_SIZE,
    },
  };
}

/** Query string for a link that changes some keys (others kept; defaults dropped). */
export function productAnalyticsHref(path: string, current: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const merged = { ...current, ...patch };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "" && v !== "all") qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}
