// ============================================================
// SHOPEE-ADS-0: the ONE place for Shopee domain flags.
//
//   SHOPEE_LEGACY_MODULES_ENABLED (default false) — the retired Shopee
//       modules: dashboard / analytics / products / orders / returns /
//       return operations / payouts / sync / system health pages, their API
//       routes and server actions, their scheduler job types and the return
//       notifications. false = no UI, no route, no job, no Shopee traffic.
//   SHOPEE_ADS_ENABLED (default true) — the Ads module (route + future sync).
//
// There is deliberately NO "all Shopee off" flag: OAuth, tokens, signing,
// the API client, queue / worker / scheduler stay available for Ads.
// Pure (no "@/" imports): usable from proxy, server and client props.
// ============================================================

type Env = Record<string, string | undefined>;

function bool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return fallback;
  if (["true", "1", "on", "yes"].includes(v)) return true;
  if (["false", "0", "off", "no"].includes(v)) return false;
  return fallback;
}

export interface ShopeeFlags {
  legacyModulesEnabled: boolean;
  adsEnabled: boolean;
}

export function getShopeeFlags(env: Env = process.env): ShopeeFlags {
  return {
    legacyModulesEnabled: bool(env.SHOPEE_LEGACY_MODULES_ENABLED, false),
    adsEnabled: bool(env.SHOPEE_ADS_ENABLED, true),
  };
}

/** Pages of the retired modules (prefix match). */
export const LEGACY_SHOPEE_PAGE_PREFIXES = [
  "/shopee/dashboard",
  "/shopee/analytics",
  "/shopee/products",
  "/shopee/orders",
  "/shopee/returns", // includes /shopee/returns/operations
  "/shopee/payouts",
  "/shopee/sync",
  "/shopee/system-health",
] as const;

/** API routes of the retired modules (prefix match). The OAuth / test-connection / internal scheduler routes are NOT here. */
export const LEGACY_SHOPEE_API_PREFIXES = ["/api/shopee/analytics", "/api/shopee/returns"] as const;

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isLegacyShopeePage(pathname: string): boolean {
  return LEGACY_SHOPEE_PAGE_PREFIXES.some((p) => matches(pathname, p));
}

export function isLegacyShopeeApi(pathname: string): boolean {
  return LEGACY_SHOPEE_API_PREFIXES.some((p) => matches(pathname, p));
}

/** Where a retired page sends people (consistent policy: redirect, never a half-working page). */
export function legacyRedirectTarget(flags: ShopeeFlags): string {
  return flags.adsEnabled ? "/shopee/ads" : "/dashboard";
}
