// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1: READ-ONLY policy for product analytics
// discovery (standing rule, same spirit as ads/read-only-policy.ts).
//
// The system may READ product performance data and must NEVER write: no
// item edit, price, stock, publish / unlist, no Ads change, no write endpoint.
//
// Endpoint names are never guessed: every path below carries the evidence
// that put it here (docs/shopee-product-analytics-api.md §2). GET only — a
// POST "read" must STOP and be reviewed separately (the list is empty and the
// guard test pins it).
// ============================================================
import { ADS_MUTATION_TOKENS } from "../ads/read-only-policy.ts";

export interface ProductAnalyticsEndpoint {
  path: string;
  method: "GET";
  /** Why this path is believed to exist and to be a read. */
  evidence: string;
}

/**
 * Discovery candidates (called by the discovery tool only, within the budget).
 * get_item_extra_info: listed in the Shopee v2 Product module reference
 * (secondary reference snapshot 2026-09-06: item_id_list ≤ 50 → sale / views /
 * likes / rating_star / comment_count); verified in production 2026-10-30.
 */
export const PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES: readonly ProductAnalyticsEndpoint[] = [
  {
    path: "/api/v2/product/get_item_extra_info",
    method: "GET",
    evidence: "Shopee v2 Product module reference (item_id_list ≤ 50; sale, views, likes, rating_star, comment_count)",
  },
];

/**
 * Control path: proves what the gateway answers for a route that does NOT
 * exist (json 404 error_not_found, same as the Ads control in
 * docs/shopee-ads-api.md), so a candidate's answer can be told apart.
 */
export const PRODUCT_ANALYTICS_CONTROL_PATH = "/api/v2/product/get_this_endpoint_does_not_exist";

/** Verified product-analytics reads (production, docs/shopee-product-analytics-api.md). */
export const PRODUCT_ANALYTICS_READ_ENDPOINTS = {
  item_extra_info: "/api/v2/product/get_item_extra_info",
} as const;

/** Reads designed as POST that passed a dedicated review. EMPTY — see §9 of the phase spec. */
export const PRODUCT_ANALYTICS_APPROVED_POST_READS: readonly string[] = [];

/** Hard limits for one discovery run (spec §10: start small, never the whole catalogue). */
export const PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS = 12;
export const PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS = 10;
export const PRODUCT_ANALYTICS_DISCOVERY_GAP_MS = 1000;

export class ProductAnalyticsWriteForbiddenError extends Error {
  constructor(message: string) {
    super(`Product analytics là CHỈ ĐỌC: ${message}`);
    this.name = "ProductAnalyticsWriteForbiddenError";
  }
}

const KNOWN_PATHS = new Set<string>([
  ...PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES.map((c) => c.path),
  ...Object.values(PRODUCT_ANALYTICS_READ_ENDPOINTS),
  PRODUCT_ANALYTICS_CONTROL_PATH,
]);

/** A get_* name under /api/v2/product/ with no mutation token, and explicitly listed above. */
export function isProductAnalyticsReadPath(path: string): boolean {
  const m = /^\/api\/v2\/product\/(get_[a-z_]+)$/.exec(path);
  if (!m || !KNOWN_PATHS.has(path)) return false;
  return m[1].split("_").every((t) => !ADS_MUTATION_TOKENS.includes(t));
}

export function isProductAnalyticsReadRequest(method: string, path: string): boolean {
  if (!isProductAnalyticsReadPath(path)) return false;
  return method === "GET" || (method === "POST" && PRODUCT_ANALYTICS_APPROVED_POST_READS.includes(path));
}

/** Last line of defense before any product-analytics request leaves the process. */
export function assertProductAnalyticsReadRequest(method: string, path: string): void {
  if (!isProductAnalyticsReadRequest(method, path)) throw new ProductAnalyticsWriteForbiddenError(`từ chối ${method} ${path}`);
}
