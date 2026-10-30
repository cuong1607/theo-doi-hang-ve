// ============================================================
// SHOPEE ADS — READ-ONLY POLICY (standing rule, whole Ads roadmap).
//
// The system may READ Shopee Ads (campaigns, status, budget, performance,
// settings, product relations) and must NEVER write: no create / edit /
// rename / pause / resume / stop / delete campaign, no status, budget, bid,
// bidding strategy, target ROAS, schedule, advertised product, keyword or
// placement change, no Ads settings change, no mutation endpoint at all.
//
// This file is the single source of the rule for every layer:
//   provider / probe / discovery CLI / server actions / future job handlers
// and is enforced by read-only-guard.test.ts (allowlist, HTTP methods,
// provider surface, UI labels, job types, code-search for mutation names).
//
// Changing it requires the user's explicit "cho phép sửa campaign" AND a
// dedicated mutation-safety phase — never inferred from "optimization",
// "recommendation", "budget analysis" or "campaign management".
// See docs/shopee-ads-read-only-policy.md.
// ============================================================

/**
 * The explicit allowlist of Shopee Ads READ endpoints (verified in production,
 * docs/shopee-ads-api.md §3). The probe and the provider can call nothing else.
 */
export const ADS_READ_ENDPOINTS = {
  shop_toggle_info: "/api/v2/ads/get_shop_toggle_info",
  total_balance: "/api/v2/ads/get_total_balance",
  campaign_id_list: "/api/v2/ads/get_product_level_campaign_id_list",
  campaign_setting_info: "/api/v2/ads/get_product_level_campaign_setting_info",
  shop_daily_performance: "/api/v2/ads/get_all_cpc_ads_daily_performance",
  campaign_daily_performance: "/api/v2/ads/get_product_campaign_daily_performance",
  shop_hourly_performance: "/api/v2/ads/get_all_cpc_ads_hourly_performance",
  campaign_hourly_performance: "/api/v2/ads/get_product_campaign_hourly_performance",
  recommended_item_list: "/api/v2/ads/get_recommended_item_list",
} as const;
export type AdsReadEndpoint = keyof typeof ADS_READ_ENDPOINTS;

/**
 * ADS-3A.2 product enrichment: the ONE product-module read the Ads domain may
 * call — metadata (name / SKU / image / status) of items already referenced by
 * Ads campaigns. Verified in production (docs/shopee-ads-product-enrichment.md).
 * Exact paths only: no other /api/v2/product/ endpoint (no item list / catalogue
 * scan, no update_item / price / stock / unlist …) is reachable from Ads code.
 */
export const ADS_PRODUCT_READ_ENDPOINTS = {
  item_base_info: "/api/v2/product/get_item_base_info",
} as const;
export type AdsProductReadEndpoint = keyof typeof ADS_PRODUCT_READ_ENDPOINTS;
const PRODUCT_READ_PATHS = new Set<string>(Object.values(ADS_PRODUCT_READ_ENDPOINTS));

/** Queue job types of the Ads domain — read / sync only (ads_<what>_read). */
export const ADS_SYNC_TYPES = ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read", "ads_shop_hourly_read", "ads_campaign_hourly_read", "ads_product_enrichment_read"] as const;
export type AdsSyncType = (typeof ADS_SYNC_TYPES)[number];

export function isAdsSyncType(type: string): type is AdsSyncType {
  return (ADS_SYNC_TYPES as readonly string[]).includes(type);
}

/** HTTP methods an Ads call may use. Default deny for everything else. */
export const ADS_ALLOWED_HTTP_METHODS: readonly string[] = ["GET"];

/**
 * Read endpoints that Shopee designed as POST, after a dedicated review
 * proving they are read-only. EMPTY: adding one needs its own review entry in
 * docs/shopee-ads-read-only-policy.md (the guard test pins this list).
 */
export const ADS_APPROVED_POST_READ_ENDPOINTS: readonly string[] = [];

/** Path tokens that mean a write. Checked per "_"-separated token of the endpoint name. */
export const ADS_MUTATION_TOKENS: readonly string[] = [
  "create", "add", "new", "edit", "update", "modify", "change", "set", "rename",
  "delete", "remove", "del", "pause", "resume", "stop", "start", "terminate", "end",
  "enable", "disable", "activate", "deactivate", "toggle", "apply", "submit", "save",
  "cancel", "bid", "upload", "replace", "batch", "mass",
];

/** Read endpoint name tokens that are allowed even though they contain a mutation-looking word. */
const READ_TOKEN_EXCEPTIONS: Record<string, readonly string[]> = {
  // get_shop_toggle_info READS the shop's Ads toggle state.
  toggle: ["get_shop_toggle_info"],
};

/** Identifiers that must never appear in Ads code (code-search guard; review required, no auto-ignore). */
export const ADS_FORBIDDEN_IDENTIFIERS: readonly string[] = [
  "createCampaign", "updateCampaign", "editCampaign", "renameCampaign", "deleteCampaign",
  "pauseCampaign", "resumeCampaign", "stopCampaign", "setBudget", "updateBudget", "changeBudget",
  "setBid", "updateBid", "changeBid", "changeStatus", "setStatus", "updateStatus",
  "setTargetRoas", "updateKeyword", "addKeyword", "deleteKeyword", "applyRecommendation",
  // ADS-3A.2: product / listing writes
  "updateItem", "addItem", "deleteItem", "unlistItem", "updatePrice", "updateStock", "updateModel", "updateSku",
];

export class AdsWriteForbiddenError extends Error {
  constructor(message: string) {
    super(`Shopee Ads là CHỈ ĐỌC: ${message}`);
    this.name = "AdsWriteForbiddenError";
  }
}

/** "/api/v2/ads/get_xxx" with a read verb and no mutation token, or one exact allowlisted product read. */
export function isAdsReadOnlyPath(path: string): boolean {
  if (PRODUCT_READ_PATHS.has(path)) return /^\/api\/v2\/product\/get_[a-z_]+$/.test(path) && path.split("/").pop()!.split("_").every((t) => !ADS_MUTATION_TOKENS.includes(t));
  const m = /^\/api\/v2\/ads\/([a-z0-9_]+)$/.exec(path);
  if (!m) return false;
  const name = m[1];
  if (!name.startsWith("get_")) return false;
  return name.split("_").every((token) => !ADS_MUTATION_TOKENS.includes(token) || (READ_TOKEN_EXCEPTIONS[token] ?? []).includes(name));
}

export function isAdsReadOnlyRequest(method: string, path: string): boolean {
  if (!isAdsReadOnlyPath(path)) return false;
  if (ADS_ALLOWED_HTTP_METHODS.includes(method)) return true;
  return method === "POST" && ADS_APPROVED_POST_READ_ENDPOINTS.includes(path);
}

/** Last line of defense before any Ads request leaves the process. */
export function assertAdsReadOnlyRequest(method: string, path: string): void {
  if (!isAdsReadOnlyRequest(method, path)) throw new AdsWriteForbiddenError(`từ chối ${method} ${path}`);
}

/** Ads queue job types must be read/sync jobs: ads_<what>_read, never *_update / *_set … */
export function isAdsReadJobType(type: string): boolean {
  const m = /^ads_([a-z_]+)_read$/.exec(type);
  return !!m && m[1].split("_").every((t) => !ADS_MUTATION_TOKENS.includes(t));
}
