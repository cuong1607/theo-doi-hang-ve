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
];

export class AdsWriteForbiddenError extends Error {
  constructor(message: string) {
    super(`Shopee Ads là CHỈ ĐỌC: ${message}`);
    this.name = "AdsWriteForbiddenError";
  }
}

/** "/api/v2/ads/get_xxx" with a read verb and no mutation token. */
export function isAdsReadOnlyPath(path: string): boolean {
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
