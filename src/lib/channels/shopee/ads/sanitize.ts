// ============================================================
// SHOPEE-ADS-1: scrub Ads payloads before they are printed, saved as test
// fixtures or stored as raw snapshots. Ads responses carry no buyer PII,
// but defensively drop anything that looks like a credential, and the
// discovery fixtures also drop the shop / partner identifiers.
// ============================================================

const SECRET_KEY = /token|sign|secret|partner_key|password|authorization/i;

export function sanitizeAdsPayload(value: unknown, options: { dropIdentity?: boolean } = {}): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitizeAdsPayload(v, options));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      if (options.dropIdentity && (key === "shop_id" || key === "partner_id")) continue;
      out[key] = sanitizeAdsPayload(v, options);
    }
    return out;
  }
  return value;
}
