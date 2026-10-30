// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1: READ-ONLY discovery runner.
//
// Calls the evidenced candidates for a SMALL explicit item sample (≤ 10
// items, ≤ 12 requests, 1 s gap), plus one control path that must not exist.
// Pure + transport-injected: the dev tool (scripts/shopee/
// product-analytics-discovery.ts) supplies a signed GET transport; tests
// supply a fake. Nothing here writes anywhere.
//
// Output: per-call classification, a field inventory (path → types, example,
// nullable) and sanitized fixtures (createAdsFixtureSanitizer: stable id /
// name placeholders, metrics untouched).
// ============================================================
import { createAdsFixtureSanitizer, findFixtureSecrets } from "../ads/sanitize.ts";
import {
  assertProductAnalyticsReadRequest,
  PRODUCT_ANALYTICS_CONTROL_PATH,
  PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES,
  PRODUCT_ANALYTICS_DISCOVERY_GAP_MS,
  PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS,
  PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS,
} from "./read-only-policy.ts";

export interface DiscoveryShopPlan {
  /** Internal shops.id (the transport resolves token / provider shop id from it). */
  shopKey: string;
  shopLabel: string;
  itemIds: string[];
}

export interface DiscoveryTransportRequest {
  method: "GET";
  path: string;
  shopKey: string;
  params: Record<string, string | number>;
}

export interface DiscoveryTransportResponse {
  httpStatus: number | null;
  latencyMs: number;
  text: string;
  transportError?: { code: string; message: string };
}

export type DiscoveryTransport = (request: DiscoveryTransportRequest) => Promise<DiscoveryTransportResponse>;

export type DiscoveryClassification =
  | "OK" // HTTP 200, error empty, response present
  | "ENDPOINT_NOT_FOUND" // json 404 error_not_found (the control's expected answer)
  | "PERMISSION_DENIED"
  | "PARAM_ERROR"
  | "PROVIDER_ERROR"
  | "TRANSPORT_ERROR";

export interface DiscoveryCall {
  label: string;
  path: string;
  method: "GET";
  shopLabel: string;
  requestedItems: number;
  httpStatus: number | null;
  latencyMs: number;
  classification: DiscoveryClassification;
  providerError: string | null;
  providerMessage: string | null;
  requestId: string | null;
  /** Item ids the provider returned (real ids — in-memory only, never in fixtures). */
  returnedItemIds: string[];
  /** Parsed body (raw — callers decide what to persist; fixtures go through sanitizeDiscoveryReport). */
  body: unknown;
}

export interface DiscoveryReport {
  mode: "READ_ONLY";
  requestBudget: number;
  requestsUsed: number;
  stoppedReason: "completed" | "budget_exhausted";
  calls: DiscoveryCall[];
}

export class DiscoveryGuardError extends Error {}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function validateDiscoveryPlan(plan: readonly DiscoveryShopPlan[]): void {
  const total = plan.reduce((n, s) => n + s.itemIds.length, 0);
  if (total === 0) throw new DiscoveryGuardError("Cần ít nhất 1 item mẫu.");
  if (total > PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS) throw new DiscoveryGuardError(`Tối đa ${PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS} item mỗi lượt discovery (nhận ${total}).`);
  for (const s of plan) for (const id of s.itemIds) if (!/^[0-9]{1,20}$/.test(id)) throw new DiscoveryGuardError(`item id không hợp lệ: ${id}`);
  const calls = 1 + plan.length * PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES.length;
  if (calls > PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS) throw new DiscoveryGuardError(`Kế hoạch cần ${calls} request > ngân sách ${PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS}.`);
}

export function classifyDiscoveryResponse(res: DiscoveryTransportResponse): { classification: DiscoveryClassification; json: Record<string, unknown> | null } {
  if (res.transportError || res.httpStatus === null) return { classification: "TRANSPORT_ERROR", json: null };
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(res.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  const code = typeof json?.error === "string" ? json.error : "";
  if (code === "error_not_found" || (res.httpStatus === 404 && !json)) return { classification: "ENDPOINT_NOT_FOUND", json };
  if (/permission|auth|forbidden|access_denied/i.test(code) || res.httpStatus === 403) return { classification: "PERMISSION_DENIED", json };
  if (/param/i.test(code)) return { classification: "PARAM_ERROR", json };
  if (res.httpStatus === 200 && json && !code && json.response !== undefined) return { classification: "OK", json };
  return { classification: "PROVIDER_ERROR", json };
}

function itemIdsOf(json: Record<string, unknown> | null): string[] {
  const list = (json?.response as { item_list?: unknown } | undefined)?.item_list;
  if (!Array.isArray(list)) return [];
  return list.map((i) => (i && typeof i === "object" ? String((i as { item_id?: unknown }).item_id ?? "") : "")).filter(Boolean);
}

export async function runProductAnalyticsDiscovery(options: {
  plan: readonly DiscoveryShopPlan[];
  transport: DiscoveryTransport;
  includeControl?: boolean;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DiscoveryReport> {
  validateDiscoveryPlan(options.plan);
  const sleep = options.sleep ?? sleepMs;
  const gap = options.gapMs ?? PRODUCT_ANALYTICS_DISCOVERY_GAP_MS;
  const report: DiscoveryReport = { mode: "READ_ONLY", requestBudget: PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS, requestsUsed: 0, stoppedReason: "completed", calls: [] };

  const call = async (label: string, path: string, shop: DiscoveryShopPlan, params: Record<string, string | number>, requestedItems: number) => {
    if (report.requestsUsed >= report.requestBudget) {
      report.stoppedReason = "budget_exhausted";
      return;
    }
    assertProductAnalyticsReadRequest("GET", path);
    if (report.requestsUsed > 0) await sleep(gap);
    report.requestsUsed++;
    const res = await options.transport({ method: "GET", path, shopKey: shop.shopKey, params });
    const { classification, json } = classifyDiscoveryResponse(res);
    report.calls.push({
      label,
      path,
      method: "GET",
      shopLabel: shop.shopLabel,
      requestedItems,
      httpStatus: res.httpStatus,
      latencyMs: res.latencyMs,
      classification,
      providerError: typeof json?.error === "string" && json.error ? json.error : res.transportError?.code ?? null,
      providerMessage: typeof json?.message === "string" && json.message ? json.message.slice(0, 300) : null,
      requestId: typeof json?.request_id === "string" ? json.request_id : null,
      returnedItemIds: itemIdsOf(json),
      body: json,
    });
  };

  if (options.includeControl !== false) await call("control", PRODUCT_ANALYTICS_CONTROL_PATH, options.plan[0], {}, 0);
  for (const shop of options.plan) {
    for (const c of PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES) {
      await call(c.path.split("/").pop()!, c.path, shop, { item_id_list: shop.itemIds.join(",") }, shop.itemIds.length);
    }
  }
  return report;
}

// ------------------------------------------------------------
// Field inventory
// ------------------------------------------------------------
export interface FieldInfo {
  path: string;
  types: string[];
  /** Seen null / missing in at least one array element. */
  nullable: boolean;
  example: unknown;
  occurrences: number;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Walk payloads → one entry per JSON path ("response.item_list[].views"). Examples come from `examples` (sanitized). */
export function inventoryFields(payloads: readonly unknown[], examples: readonly unknown[] = payloads): FieldInfo[] {
  const map = new Map<string, { types: Set<string>; nulls: number; example: unknown; occurrences: number; parents: number }>();
  const walk = (v: unknown, ex: unknown, path: string) => {
    const e = map.get(path) ?? { types: new Set<string>(), nulls: 0, example: undefined, occurrences: 0, parents: 0 };
    e.types.add(typeOf(v));
    e.occurrences++;
    if (v === null) e.nulls++;
    if (e.example === undefined && v !== null && typeof v !== "object") e.example = ex;
    map.set(path, e);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, Array.isArray(ex) ? ex[i] : undefined, `${path}[]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, ex && typeof ex === "object" ? (ex as Record<string, unknown>)[k] : undefined, path ? `${path}.${k}` : k);
    }
  };
  payloads.forEach((p, i) => walk(p, examples[i], ""));
  // nullable also when a key is missing in some elements of its array
  const out: FieldInfo[] = [];
  for (const [path, e] of map) {
    if (!path) continue;
    const parent = path.replace(/\.[^.[\]]+$/, "");
    const parentCount = parent !== path ? map.get(parent)?.occurrences ?? e.occurrences : e.occurrences;
    out.push({ path, types: [...e.types].sort(), nullable: e.nulls > 0 || e.occurrences < parentCount, example: e.example, occurrences: e.occurrences });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ------------------------------------------------------------
// Cross-source context (spec §18 / §20): provider counters next to internal
// order facts and Ads facts of the SAME item. Context only — never an
// equality reconciliation, never "organic = total − Ads".
// ------------------------------------------------------------
export interface InternalItemFacts {
  /** Sales-status orders / units in the internal DB (coverage starts at firstOrderAt). */
  ordersInDb: number;
  unitsInDb: number;
  firstOrderAt: string | null;
  units7d: number;
  orders7d: number;
}

export interface AdsItemFacts {
  /** shopee_ads_products has (shop, provider_item_id) = the provider item id, as text. */
  adsProductRow: boolean;
  campaigns: number;
  impression7d: number;
  clicks7d: number;
  expense7d: number;
  broadOrder7d: number;
  directOrder7d: number;
}

export interface ItemComparison {
  itemId: string;
  returned: boolean;
  provider: { sale: number | null; views: number | null; likes: number | null; ratingStar: number | null; commentCount: number | null } | null;
  internal: InternalItemFacts;
  ads: AdsItemFacts;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function buildItemComparisons(
  requested: readonly string[],
  body: unknown,
  internal: ReadonlyMap<string, InternalItemFacts>,
  ads: ReadonlyMap<string, AdsItemFacts>,
): ItemComparison[] {
  const list = (body as { response?: { item_list?: unknown } } | null)?.response?.item_list;
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(list)) for (const i of list) if (i && typeof i === "object") byId.set(String((i as { item_id?: unknown }).item_id), i as Record<string, unknown>);
  const emptyInternal: InternalItemFacts = { ordersInDb: 0, unitsInDb: 0, firstOrderAt: null, units7d: 0, orders7d: 0 };
  const emptyAds: AdsItemFacts = { adsProductRow: false, campaigns: 0, impression7d: 0, clicks7d: 0, expense7d: 0, broadOrder7d: 0, directOrder7d: 0 };
  return requested.map((itemId) => {
    const p = byId.get(itemId);
    return {
      itemId,
      returned: !!p,
      provider: p ? { sale: num(p.sale), views: num(p.views), likes: num(p.likes), ratingStar: num(p.rating_star), commentCount: num(p.comment_count) } : null,
      internal: internal.get(itemId) ?? emptyInternal,
      ads: ads.get(itemId) ?? emptyAds,
    };
  });
}

/** channel_api_snapshots.entity_type of an admin probe run (one row per run). */
export const PRODUCT_ANALYTICS_PROBE_ENTITY = "product_analytics_probe";

export interface ProductAnalyticsProbeResult {
  environment: "production" | "sandbox";
  shopLabel: string;
  ranAt: string;
  /** Last 7 completed VN days used for the internal / Ads context. */
  window: { from: string; to: string };
  report: DiscoveryReport;
  comparisons: ItemComparison[];
}

/** Sanitized copy of every call body (stable placeholders) + a secret scan that must come back empty. */
export function sanitizeDiscoveryReport(
  report: DiscoveryReport,
  knownSecrets: readonly string[] = [],
  options: { comparisons?: readonly ItemComparison[]; suffix?: string } = {},
): { fixtures: Array<{ name: string; content: unknown }>; secretFindings: string[] } {
  // one sanitizer for the whole report: the same real item id → the same placeholder in bodies and comparisons
  const s = createAdsFixtureSanitizer();
  const suffix = options.suffix ? `-${options.suffix}` : "";
  const fixtures: Array<{ name: string; content: unknown }> = report.calls.map((c, i) => ({
    name: `${c.label === "control" ? "control-not-found" : c.label.replace(/^get_/, "").replace(/_/g, "-")}${i > 1 ? `-${i}` : ""}${suffix}.json`,
    content: {
      _meta: { path: c.path, method: c.method, httpStatus: c.httpStatus, classification: c.classification, requestedItems: c.requestedItems, latencyMs: c.latencyMs, note: "sanitized payload (SHOPEE-PRODUCT-ANALYTICS-1); ids / names are stable placeholders" },
      body: s.sanitize(c.body),
    },
  }));
  if (options.comparisons) {
    // snake_case item_id so the sanitizer's id rule applies (camelCase itemId would slip through)
    const rows = options.comparisons.map(({ itemId, ...rest }) => s.sanitize({ item_id: itemId, ...rest }));
    fixtures.push({ name: `comparison${suffix}.json`, content: { _meta: { note: "provider counters next to internal order / Ads facts of the same items — context, not reconciliation" }, rows } });
  }
  return { fixtures, secretFindings: findFixtureSecrets(fixtures, knownSecrets) };
}
