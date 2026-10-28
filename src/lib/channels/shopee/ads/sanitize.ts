// ============================================================
// SHOPEE-ADS-1 / 1A: scrub Ads payloads before they are printed, saved as
// test fixtures or downloaded from the production probe.
//
// sanitizeAdsPayload      stateless: drops credential-looking keys
//                         (+ shop / partner ids with dropIdentity).
// createAdsFixtureSanitizer  stateful, for probe fixtures: additionally
//                         replaces business-sensitive names (campaign / item
//                         / keyword …) and provider ids with STABLE
//                         placeholders — the same real value always maps to
//                         the same placeholder within one sanitizer, so
//                         relationships across payloads survive. Value TYPES
//                         are kept (number id → number, string id → string);
//                         metrics, statuses, dates and money are untouched.
// ============================================================

const SECRET_KEY = /token|secret|password|authori[sz]ation|cookie|partner_key|(^|_)sign(ature)?($|_)|(^|_)headers?$/i;
const IDENTITY_KEY = /^(shop_id|partner_id|merchant_id|main_account_id)$/i;
/** Provider ids (request_id is a support handle, kept). */
const ID_KEY = /(^|_)id$|_id_list$|_ids$/i;
const KEEP_ID_KEY = /^request_id$/i;
const NAME_KEY = /(^|_)(name|title|keyword|keywords|search_term)$/i;

export function sanitizeAdsPayload(value: unknown, options: { dropIdentity?: boolean } = {}): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitizeAdsPayload(v, options));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      if (options.dropIdentity && IDENTITY_KEY.test(key)) continue;
      out[key] = sanitizeAdsPayload(v, options);
    }
    return out;
  }
  return value;
}

export interface AdsFixtureSanitizer {
  sanitize(value: unknown): unknown;
  /** Request params: id lists ("1,2,3") masked with the same mapping as bodies. */
  sanitizeParams(params: Record<string, string | number>): Record<string, string | number>;
}

const ID_BASE = 900_000_000;

function labelFor(key: string): string {
  const stem = key.replace(/(^|_)(name|title)$/i, "").replace(/_/g, " ").trim();
  const word = stem || "name";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function createAdsFixtureSanitizer(): AdsFixtureSanitizer {
  const ids = new Map<string, number>();
  const names = new Map<string, string>();

  const maskId = (v: string): number => {
    let n = ids.get(v);
    if (n === undefined) {
      n = ID_BASE + ids.size + 1;
      ids.set(v, n);
    }
    return n;
  };

  const maskIdValue = (v: unknown): unknown => {
    if (typeof v === "number" && Number.isFinite(v)) return v === 0 ? 0 : maskId(String(v));
    if (typeof v === "string") {
      if (/^\d+$/.test(v)) return v === "0" ? v : String(maskId(v));
      if (/^\d+(,\d+)+$/.test(v)) return v.split(",").map((x) => String(maskId(x))).join(",");
      return v;
    }
    if (Array.isArray(v)) return v.map(maskIdValue);
    if (v && typeof v === "object") return sanitize(v);
    return v;
  };

  const maskName = (key: string, v: unknown): unknown => {
    if (typeof v === "string") {
      if (!v) return v;
      const label = labelFor(key);
      const k = `${label}\u0000${v}`;
      let out = names.get(k);
      if (!out) {
        out = `${label} #${[...names.keys()].filter((x) => x.startsWith(`${label}\u0000`)).length + 1}`;
        names.set(k, out);
      }
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => maskName(key, x));
    if (v && typeof v === "object") return sanitize(v);
    return v;
  };

  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY.test(key) || IDENTITY_KEY.test(key)) continue;
        if (ID_KEY.test(key) && !KEEP_ID_KEY.test(key)) out[key] = maskIdValue(v);
        else if (NAME_KEY.test(key)) out[key] = maskName(key, v);
        else out[key] = sanitize(v);
      }
      return out;
    }
    return value;
  };

  return {
    sanitize,
    sanitizeParams(params) {
      const out: Record<string, string | number> = {};
      for (const [key, v] of Object.entries(params)) {
        if (SECRET_KEY.test(key) || IDENTITY_KEY.test(key)) continue;
        out[key] = ID_KEY.test(key) ? (maskIdValue(v) as string | number) : v;
      }
      return out;
    },
  };
}

/**
 * Review step before a fixture is written / committed: lists anything that
 * still looks sensitive (credential-like keys, shop / partner ids,
 * bearer / JWT / long hex or base64 blobs, explicit known secrets).
 * Empty array = clean.
 */
export function findFixtureSecrets(value: unknown, knownSecrets: readonly string[] = []): string[] {
  const findings: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const p = at ? `${at}.${k}` : k;
        if (SECRET_KEY.test(k)) findings.push(`${p}: credential-like key`);
        if (IDENTITY_KEY.test(k)) findings.push(`${p}: shop / partner identifier`);
        walk(child, p);
      }
      return;
    }
    if (typeof v === "string") {
      if (/bearer\s+\S/i.test(v)) findings.push(`${at}: bearer value`);
      if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) findings.push(`${at}: JWT-like value`);
      if (/^[a-f0-9]{32,}$/i.test(v) && !/(^|\.)request_id$/.test(at)) findings.push(`${at}: long hex value`);
      if (/^[A-Za-z0-9+/=_-]{48,}$/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v)) findings.push(`${at}: long token-like value`);
      for (const s of knownSecrets) if (s && v.includes(s)) findings.push(`${at}: contains a known secret`);
    }
  };
  walk(value, "");
  return findings;
}
