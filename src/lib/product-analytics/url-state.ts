// ============================================================
// PRODUCT-ANALYTICS-2: /shopee/product-analytics URL state (pure, tested).
// ?period=7d|30d|today|yesterday|custom&from&to&shop=<uuid|all>&q&ads=with|without
// &status=NORMAL|UNLIST|…&sort&dir&page
// ============================================================
import { resolveProductPeriod, type ProductPeriod } from "./periods.ts";
import { PRODUCT_LIST_SORTS, type ProductListQuery, type ProductListSort } from "./read-model.ts";

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const PRODUCT_LIST_PAGE_SIZE = 50;

export interface ProductAnalyticsUrlState {
  period: ProductPeriod;
  shop: string;
  list: ProductListQuery;
  page: number;
}

export function parseProductAnalyticsQuery(sp: Query, now: Date = new Date()): ProductAnalyticsUrlState {
  const period = resolveProductPeriod({ preset: one(sp.period), from: one(sp.from), to: one(sp.to) }, now);
  const shop = one(sp.shop);
  const ads = one(sp.ads);
  const status = one(sp.status);
  const sort = one(sp.sort);
  const page = Number(one(sp.page));
  return {
    period,
    shop: shop && /^[0-9a-f-]{36}$/i.test(shop) ? shop : "all",
    list: {
      q: (one(sp.q) ?? "").slice(0, 100),
      ads: ads === "with" || ads === "without" ? ads : "all",
      status: status && /^[A-Z_]{2,30}$/.test(status) ? status : "all",
      sort: PRODUCT_LIST_SORTS.includes(sort as ProductListSort) ? (sort as ProductListSort) : "gmv",
      dir: one(sp.dir) === "asc" ? "asc" : "desc",
    },
    page: Number.isInteger(page) && page > 0 && page < 10_000 ? page : 1,
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
