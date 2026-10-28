// ============================================================
// SHOPEE-ADS-1A: production READ-ONLY Ads probe — the pure core.
//
// One implementation shared by the admin-only server action
// (/shopee/ads/probe, runs where the production credentials live) and the
// dev CLI (scripts/shopee/ads-discovery.ts). The transport is injected; this
// file never touches the network, the DB or a token.
//
// Guarantees (fail closed, covered by probe.test.ts):
//   * GET only, and only the exact allowlisted Ads paths below — no create /
//     edit / status / bid / budget / delete endpoint is reachable, and no
//     caller-supplied path is accepted.
//   * production needs an explicit confirmation flag.
//   * hard request budget (≤ ADS_PROBE_MAX_REQUESTS per run), sequential
//     calls with a gap, circuit breaker on repeated 5xx / rate-limit /
//     unavailable / auth answers.
//   * every saved body goes through the fixture sanitizer: credentials and
//     shop / partner ids dropped, names and provider ids replaced by stable
//     placeholders (relationships across calls preserved), metrics untouched.
//
// Request parameters follow the Shopee v2 Ads module listing. They are
// CANDIDATES: a provider parameter error is recorded as evidence, never
// "fixed" by trying random combinations.
// ============================================================
import { isAdsReadOnlyRequest } from "./read-only-policy.ts";
import { createAdsFixtureSanitizer, type AdsFixtureSanitizer } from "./sanitize.ts";

export const ADS_PROBE_ENDPOINTS = {
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

export type AdsProbeEndpoint = keyof typeof ADS_PROBE_ENDPOINTS;

/** Hard ceiling of provider requests per probe run (callers may only lower it). */
export const ADS_PROBE_MAX_REQUESTS = 25;
export const ADS_PROBE_GAP_MS = 1000;
/** Text the admin must type to start a probe (explicit production opt-in). */
export const ADS_PROBE_CONFIRM_TEXT = "READ-ONLY";
/** Campaign ids carried from the list into setting / performance calls. */
export const ADS_PROBE_MAX_CAMPAIGNS = 5;
/** Longest array kept in a saved body (structure is what matters, not volume). */
const MAX_ARRAY_ITEMS = 100;

const ALLOWED_PATHS = new Set<string>(Object.values(ADS_PROBE_ENDPOINTS));

export class AdsProbeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsProbeGuardError";
  }
}

/** Fail-closed request guard: the read-only policy (GET, read path) + exact allowlisted Ads path. */
export function assertAdsProbeRequest(method: string, path: string): void {
  if (method !== "GET" || !isAdsReadOnlyRequest(method, path)) throw new AdsProbeGuardError(`Probe Ads chỉ cho phép GET đọc (nhận ${method} ${path}).`);
  if (!ALLOWED_PATHS.has(path)) throw new AdsProbeGuardError(`Đường dẫn không nằm trong allowlist probe Ads: ${path}`);
}

export function isAllowlistedAdsPath(path: string): boolean {
  return ALLOWED_PATHS.has(path);
}

export type AdsProbeEnvironment = "production" | "sandbox";

export type AdsProbeClassification =
  | "AVAILABLE"
  | "PERMISSION_DENIED"
  | "REAUTH_REQUIRED"
  | "SHOP_NOT_ELIGIBLE"
  | "ENDPOINT_UNAVAILABLE"
  | "PARAM_ERROR"
  | "PROVIDER_ERROR"
  | "UNKNOWN";

export interface AdsProbeTransportRequest {
  endpoint: AdsProbeEndpoint;
  method: "GET";
  path: string;
  params: Record<string, string | number>;
}

/** What a transport returns: raw text (already scrubbed of token / key by the transport). */
export interface AdsProbeTransportResponse {
  httpStatus: number | null;
  latencyMs: number;
  text: string;
  /** Transport-level failure before / instead of an HTTP answer (network, token). */
  transportError?: { code: string; message: string; reauth?: boolean };
}

export type AdsProbeTransport = (request: AdsProbeTransportRequest) => Promise<AdsProbeTransportResponse>;

export interface AdsProbeCall {
  step: number;
  endpoint: AdsProbeEndpoint;
  purpose: string;
  method: "GET";
  path: string;
  /** Sanitized (campaign ids masked like in the bodies). */
  params: Record<string, string | number>;
  httpStatus: number | null;
  latencyMs: number;
  classification: AdsProbeClassification;
  errorCode: string | null;
  message: string | null;
  requestId: string | null;
  /** Top-level keys of the envelope and of `response` (shape evidence). */
  envelopeKeys: string[];
  responseKeys: string[];
  /** Length of every array found, by JSON path (record counts). */
  arrayLengths: Record<string, number>;
  /** Keys that look like paging (next / more / total / offset / cursor / page) with their values. */
  paginationHints: Record<string, unknown>;
  /** Sanitized envelope (or raw non-JSON text prefix). */
  body: unknown;
  truncatedArrays: string[];
  /** Same-params repeat: +N = identical to step N (request_id ignored), −N = answered differently. */
  identicalTo?: number;
}

export type AdsProbeKind = "baseline" | "expansion";

export interface AdsProbeReport {
  /** baseline = ADS-1A light pass; expansion = ADS-1A.1 (pagination, reconciliation, restatement, ranges). */
  kind: AdsProbeKind;
  environment: AdsProbeEnvironment;
  mode: "READ_ONLY";
  shopLabel: string;
  startedAt: string;
  finishedAt: string;
  timeZone: string;
  dates: { today: string; yesterday: string; threeDaysAgo: string; sevenDaysAgo: string; thirtyDaysAgo: string };
  /** Expansion only: aggregates computed from the RAW answers (metrics / enums — nothing identifying). */
  summary?: AdsProbeExpansionSummary;
  requestBudget: number;
  requestsUsed: number;
  stoppedReason: "completed" | "budget" | "circuit_breaker" | "reauth_required";
  /** Classification of the first Ads answer (availability / permission). */
  adsAccess: AdsProbeClassification | null;
  calls: AdsProbeCall[];
}

// ------------------------------------------------------------------ classification

const SERVICE_NOT_FOUND = /ERROR_SP_SERVICE_NOT_FOUND/i;

export function classifyAdsProbeResponse(input: {
  httpStatus: number | null;
  errorCode: string | null;
  message: string | null;
  rawText: string;
  json: boolean;
}): AdsProbeClassification {
  const { httpStatus, errorCode, rawText, json } = input;
  const code = errorCode ?? "";
  const text = `${code} ${input.message ?? ""}`;
  if (httpStatus === 200 && json && !code) return "AVAILABLE";
  if (SERVICE_NOT_FOUND.test(rawText) || code === "error_not_found" || (httpStatus === 404 && !json)) return "ENDPOINT_UNAVAILABLE";
  if (httpStatus === 429 || /too_many|rate_limit|frequen|throttl/i.test(code)) return "PROVIDER_ERROR";
  if (/acc?e+ss_?token|refresh_?token|invalid_?token|token_?expired|error_auth|expired/i.test(text)) return "REAUTH_REQUIRED";
  if (/permission|no_?access|unauthori[sz]ed|forbidden|not_?authori[sz]ed/i.test(text) || httpStatus === 403) return "PERMISSION_DENIED";
  if (/eligib|whitelist|not_?open|not_?enabled|not_?support/i.test(text)) return "SHOP_NOT_ELIGIBLE";
  if (/param|invalid|illegal|required|format/i.test(code)) return "PARAM_ERROR";
  if ((httpStatus != null && httpStatus >= 500) || /error_server|error_inner|system|busy|internal|timeout|network/i.test(code)) return "PROVIDER_ERROR";
  return "UNKNOWN";
}

/** Answers that count towards the circuit breaker. */
function isBreakerFailure(call: AdsProbeCall): boolean {
  return call.classification === "PROVIDER_ERROR" || call.classification === "ENDPOINT_UNAVAILABLE" || call.classification === "REAUTH_REQUIRED";
}

// ------------------------------------------------------------------ shape helpers

function shapeEvidence(value: unknown): { arrayLengths: Record<string, number>; paginationHints: Record<string, unknown> } {
  const arrayLengths: Record<string, number> = {};
  const paginationHints: Record<string, unknown> = {};
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) {
      arrayLengths[at || "$"] = v.length;
      if (v.length > 0) walk(v[0], `${at}[0]`);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const p = at ? `${at}.${k}` : k;
        if (/next|more|total|offset|cursor|page|limit|count/i.test(k) && (typeof child !== "object" || child === null)) paginationHints[p] = child;
        walk(child, p);
      }
    }
  };
  walk(value, "");
  return { arrayLengths, paginationHints };
}

function truncateArrays(value: unknown, at = "", truncated: string[] = []): unknown {
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) truncated.push(`${at || "$"} (${value.length} → ${MAX_ARRAY_ITEMS})`);
    return value.slice(0, MAX_ARRAY_ITEMS).map((v, i) => truncateArrays(v, `${at}[${i}]`, truncated));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateArrays(v, at ? `${at}.${k}` : k, truncated)]));
  }
  return value;
}

/** Campaign ids anywhere in a payload, under keys named like "campaign_id" (shape unknown until verified). */
export function findCampaignIds(data: unknown, limit = ADS_PROBE_MAX_CAMPAIGNS): string[] {
  const found: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, key);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, k);
      return;
    }
    if (/^campaign_id$/i.test(key) && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) found.push(String(v));
  };
  walk(data, "");
  return [...new Set(found)].slice(0, limit);
}

/** Shopee Ads date parameter candidate: DD-MM-YYYY in the shop's timezone. */
export function adsProbeDate(date: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(date);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("day")}-${v("month")}-${v("year")}`;
}

// ------------------------------------------------------------------ runner

export interface RunAdsProbeOptions {
  environment: AdsProbeEnvironment;
  /** Must be true for environment "production" (explicit opt-in). */
  confirmProduction?: boolean;
  shopLabel: string;
  transport: AdsProbeTransport;
  now?: Date;
  timeZone?: string;
  maxRequests?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  includeToday?: boolean;
  /** Metadata-only logging hook (never bodies). */
  onCall?: (call: AdsProbeCall) => void;
}

const BREAKER_THRESHOLD = 3;
const REAUTH_THRESHOLD = 2;

type ProbeCallFn = (endpoint: AdsProbeEndpoint, purpose: string, params?: Record<string, string | number>) => Promise<{ call: AdsProbeCall; data: unknown }>;
type ProbeScript = (call: ProbeCallFn, dates: AdsProbeReport["dates"], report: AdsProbeReport, options: RunAdsProbeOptions) => Promise<void>;

/** ADS-1A baseline: one light pass over every allowlisted endpoint. */
export function runAdsProbe(options: RunAdsProbeOptions): Promise<AdsProbeReport> {
  return runProbeSession(options, "baseline", ADS_PROBE_MAX_REQUESTS, baselineScript);
}

/** ADS-1A.1 expansion: bounded campaign pagination, full-coverage reconciliation, restatement + range evidence. */
export function runAdsProbeExpansion(options: RunAdsProbeOptions): Promise<AdsProbeReport> {
  return runProbeSession(options, "expansion", ADS_PROBE_EXPANSION_MAX_REQUESTS, expansionScript);
}

async function runProbeSession(options: RunAdsProbeOptions, kind: AdsProbeKind, ceiling: number, script: ProbeScript): Promise<AdsProbeReport> {
  if (options.environment === "production" && options.confirmProduction !== true) {
    throw new AdsProbeGuardError("Probe production cần xác nhận rõ ràng (confirmProduction).");
  }
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Asia/Ho_Chi_Minh";
  const budget = Math.max(1, Math.min(options.maxRequests ?? ceiling, ceiling));
  const gapMs = options.gapMs ?? ADS_PROBE_GAP_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const sanitizer: AdsFixtureSanitizer = createAdsFixtureSanitizer();
  const day = 86_400_000;
  const dates = {
    today: adsProbeDate(now, timeZone),
    yesterday: adsProbeDate(new Date(now.getTime() - day), timeZone),
    threeDaysAgo: adsProbeDate(new Date(now.getTime() - 3 * day), timeZone),
    sevenDaysAgo: adsProbeDate(new Date(now.getTime() - 7 * day), timeZone),
    thirtyDaysAgo: adsProbeDate(new Date(now.getTime() - 30 * day), timeZone),
  };

  const report: AdsProbeReport = {
    kind,
    environment: options.environment,
    mode: "READ_ONLY",
    shopLabel: options.shopLabel,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    timeZone,
    dates,
    requestBudget: budget,
    requestsUsed: 0,
    stoppedReason: "completed",
    adsAccess: null,
    calls: [],
  };

  let consecutiveBreaker = 0;
  let reauthCount = 0;
  const rawBodies = new Map<number, string>();
  const rawParams = new Map<number, Record<string, string | number>>();

  class Stop extends Error {}

  const call: ProbeCallFn = async (endpoint, purpose, params = {}) => {
    if (report.requestsUsed >= budget) {
      report.stoppedReason = "budget";
      throw new Stop();
    }
    const path = ADS_PROBE_ENDPOINTS[endpoint];
    assertAdsProbeRequest("GET", path);
    if (report.requestsUsed > 0) await sleep(gapMs);
    report.requestsUsed++;
    const res = await options.transport({ endpoint, method: "GET", path, params });

    let json: { error?: unknown; message?: unknown; request_id?: unknown; response?: unknown } | null = null;
    if (!res.transportError) {
      try {
        const parsed = JSON.parse(res.text);
        json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        json = null;
      }
    }
    const errorCode = res.transportError?.code ?? (json && typeof json.error === "string" && json.error ? json.error : json ? null : res.httpStatus === 200 ? null : `http_${res.httpStatus ?? "none"}`);
    const message = res.transportError?.message ?? (json && typeof json.message === "string" && json.message ? json.message : null);
    const classification: AdsProbeClassification = res.transportError
      ? res.transportError.reauth
        ? "REAUTH_REQUIRED"
        : "PROVIDER_ERROR"
      : classifyAdsProbeResponse({ httpStatus: res.httpStatus, errorCode, message, rawText: res.text, json: json !== null });

    const truncatedArrays: string[] = [];
    const sanitizedBody = json ? truncateArrays(sanitizer.sanitize(json), "", truncatedArrays) : res.transportError ? null : res.text.slice(0, 400);
    const evidence = json ? shapeEvidence(json.response ?? json) : { arrayLengths: {}, paginationHints: {} };
    const entry: AdsProbeCall = {
      step: report.calls.length + 1,
      endpoint,
      purpose,
      method: "GET",
      path,
      params: sanitizer.sanitizeParams(params),
      httpStatus: res.httpStatus,
      latencyMs: res.latencyMs,
      classification,
      errorCode,
      message,
      requestId: json && typeof json.request_id === "string" ? json.request_id : null,
      envelopeKeys: json ? Object.keys(json) : [],
      responseKeys: json?.response && typeof json.response === "object" && !Array.isArray(json.response) ? Object.keys(json.response) : [],
      arrayLengths: evidence.arrayLengths,
      paginationHints: sanitizer.sanitize(evidence.paginationHints) as Record<string, unknown>,
      body: sanitizedBody,
      truncatedArrays,
    };
    // Stability evidence vs an earlier call with the same endpoint + params.
    const stripped = stripRequestId(res.text);
    const prev = report.calls.find((p) => p.endpoint === endpoint && JSON.stringify(rawParams.get(p.step)) === JSON.stringify(params));
    if (prev) entry.identicalTo = rawBodies.get(prev.step) === stripped ? prev.step : -prev.step;
    rawBodies.set(entry.step, stripped);
    rawParams.set(entry.step, params);
    report.calls.push(entry);
    options.onCall?.(entry);
    if (report.adsAccess === null) report.adsAccess = classification;

    if (isBreakerFailure(entry)) consecutiveBreaker++;
    else consecutiveBreaker = 0;
    if (classification === "REAUTH_REQUIRED") reauthCount++;
    if (reauthCount >= REAUTH_THRESHOLD) {
      report.stoppedReason = "reauth_required";
      throw new Stop();
    }
    if (consecutiveBreaker >= BREAKER_THRESHOLD) {
      report.stoppedReason = "circuit_breaker";
      throw new Stop();
    }
    return { call: entry, data: json?.response ?? null };
  };

  try {
    await script(call, dates, report, options);
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

const baselineScript: ProbeScript = async (call, dates, _report, options) => {
  {
    // 1–2. availability / permission / account
    await call("shop_toggle_info", "Ads availability + token permission + shop Ads state");
    await call("total_balance", "Ads account balance (money representation)");
    // 3. entity list
    const list = await call("campaign_id_list", "Campaign ids (entity identity, pagination)", { ad_type: "all", offset: 0, limit: 50 });
    const ids = list.call.classification === "AVAILABLE" ? findCampaignIds(list.data) : [];
    const idList = ids.join(",");
    // 4. settings of a few real campaigns
    if (ids.length) await call("campaign_setting_info", "Campaign settings: status / budget / bid / schedule / type / products", { info_type_list: "1,2,3,4", campaign_id_list: idList });
    // 5. daily performance — one completed day first
    const shopDaily = await call("shop_daily_performance", "Shop-level daily performance, yesterday", { start_date: dates.yesterday, end_date: dates.yesterday });
    let campaignDailyOk = false;
    if (ids.length) {
      const c = await call("campaign_daily_performance", "Campaign daily performance, yesterday", { start_date: dates.yesterday, end_date: dates.yesterday, campaign_id_list: idList });
      campaignDailyOk = c.call.classification === "AVAILABLE";
    }
    const shopDailyOk = shopDaily.call.classification === "AVAILABLE";
    if (shopDailyOk) {
      // small multi-day range (row grain per day?) + same completed day again (stability)
      await call("shop_daily_performance", "Shop-level daily performance, last 3 completed days (range grain)", { start_date: dates.threeDaysAgo, end_date: dates.yesterday });
      await call("shop_daily_performance", "Same completed day again (response stability)", { start_date: dates.yesterday, end_date: dates.yesterday });
      // 6. hourly only after daily works
      await call("shop_hourly_performance", "Shop-level hourly performance, yesterday (grain)", { performance_date: dates.yesterday });
    }
    if (campaignDailyOk) await call("campaign_hourly_performance", "Campaign hourly performance, yesterday (grain)", { performance_date: dates.yesterday, campaign_id_list: idList });
    if (shopDailyOk && options.includeToday !== false) {
      await call("shop_daily_performance", "Today (is the current day partial?)", { start_date: dates.today, end_date: dates.today });
    }
    // 7. product-related
    await call("recommended_item_list", "Recommended items (product relation)");
  }
};

// ------------------------------------------------------------------ ADS-1A.1 expansion

/** Hard ceiling of the expansion run (spec: ≈30 additional GETs). */
export const ADS_PROBE_EXPANSION_MAX_REQUESTS = 30;
export const ADS_PROBE_MAX_PAGES = 5;
export const ADS_PROBE_MAX_SCANNED_CAMPAIGNS = 250;
/** Campaign ids per setting / performance call (50 is the size verified so far; 20 is the one fallback). */
const ID_BATCH = 50;
const ID_BATCH_FALLBACK = 20;
const NON_ZERO_SAMPLE = 5;

const METRIC_KEYS = ["expense", "impression", "clicks", "direct_order", "broad_order", "direct_gmv", "broad_gmv"] as const;
type MetricTotals = Record<(typeof METRIC_KEYS)[number], number>;

export interface AdsProbeExpansionSummary {
  pagesFetched: number;
  pageSizeTried: number[];
  campaignsScanned: number;
  hasNextPageAtEnd: boolean | null;
  coverageComplete: boolean;
  reconciliation: {
    date: string;
    campaignsWithRows: number;
    shop: MetricTotals | null;
    sumCampaigns: MetricTotals;
    delta: MetricTotals | null;
  } | null;
  nonZeroCampaigns: number;
  statusCounts: Record<string, number>;
  adTypeCounts: Record<string, number>;
  biddingCounts: Record<string, number>;
  budgetZero: number;
  budgetPositive: number;
  roasTargetZero: number;
  roasTargetPositive: number;
  rangeChecks: Array<{ endpoint: AdsProbeEndpoint; days: number; classification: AdsProbeClassification; rows: number | null }>;
}

const zeroTotals = (): MetricTotals => ({ expense: 0, impression: 0, clicks: 0, direct_order: 0, broad_order: 0, direct_gmv: 0, broad_gmv: 0 });
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (map: Record<string, number>, key: unknown) => {
  const k = typeof key === "string" ? key : key === null || key === undefined ? "(null)" : String(key);
  map[k] = (map[k] ?? 0) + 1;
};

/** Raw campaign rows of a *_campaign_*_performance response. */
function campaignRows(data: unknown): Array<{ campaignId: string; metrics: Array<Record<string, unknown>> }> {
  return asArray(asRecord(data).campaign_list).map((c) => {
    const r = asRecord(c);
    return { campaignId: String(r.campaign_id), metrics: asArray(r.metrics_list).map(asRecord) };
  });
}

const expansionScript: ProbeScript = async (call, dates, report) => {
  const summary: AdsProbeExpansionSummary = {
    pagesFetched: 0,
    pageSizeTried: [],
    campaignsScanned: 0,
    hasNextPageAtEnd: null,
    coverageComplete: false,
    reconciliation: null,
    nonZeroCampaigns: 0,
    statusCounts: {},
    adTypeCounts: {},
    biddingCounts: {},
    budgetZero: 0,
    budgetPositive: 0,
    roasTargetZero: 0,
    roasTargetPositive: 0,
    rangeChecks: [],
  };
  report.summary = summary;

  // 1. bounded pagination (one larger page-size test, one fallback to the verified 50)
  const ids: string[] = [];
  let limit = 100;
  let offset = 0;
  let hasNext = true;
  while (hasNext && summary.pagesFetched < ADS_PROBE_MAX_PAGES && ids.length < ADS_PROBE_MAX_SCANNED_CAMPAIGNS) {
    const pageLimit = Math.min(limit, ADS_PROBE_MAX_SCANNED_CAMPAIGNS - ids.length);
    summary.pageSizeTried.push(pageLimit);
    const page = await call("campaign_id_list", `Campaign list page ${summary.pagesFetched + 1} (offset ${offset}, limit ${pageLimit})`, { ad_type: "all", offset, limit: pageLimit });
    if (page.call.classification === "PARAM_ERROR" && limit > 50 && summary.pagesFetched === 0) {
      limit = 50;
      continue;
    }
    if (page.call.classification !== "AVAILABLE") break;
    const list = asArray(asRecord(page.data).campaign_list);
    for (const id of findCampaignIds(page.data, Number.MAX_SAFE_INTEGER)) if (!ids.includes(id)) ids.push(id);
    hasNext = asRecord(page.data).has_next_page === true;
    summary.hasNextPageAtEnd = hasNext;
    summary.pagesFetched++;
    offset += list.length;
    if (list.length === 0) break;
  }
  summary.campaignsScanned = ids.length;
  summary.coverageComplete = summary.hasNextPageAtEnd === false;
  if (!ids.length) return;

  const batches = (list: string[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  // 2. campaign daily performance of EVERY scanned campaign for one completed day (reconciliation)
  const spendByCampaign = new Map<string, number>();
  const sum = zeroTotals();
  let campaignsWithRows = 0;
  let size = ID_BATCH;
  let queue = batches(ids, size);
  for (let i = 0; i < queue.length; i++) {
    const res = await call("campaign_daily_performance", `All campaigns, ${dates.yesterday} (batch ${i + 1}/${queue.length})`, { start_date: dates.yesterday, end_date: dates.yesterday, campaign_id_list: queue[i].join(",") });
    if (res.call.classification === "PARAM_ERROR" && size > ID_BATCH_FALLBACK && i === 0) {
      size = ID_BATCH_FALLBACK;
      queue = batches(ids, size);
      i = -1;
      continue;
    }
    if (res.call.classification !== "AVAILABLE") break;
    for (const row of campaignRows(res.data)) {
      campaignsWithRows++;
      for (const m of row.metrics) {
        for (const k of METRIC_KEYS) sum[k] += num(m[k]);
        spendByCampaign.set(row.campaignId, (spendByCampaign.get(row.campaignId) ?? 0) + num(m.expense));
      }
    }
  }

  // 3. settings of every scanned campaign (status / type / bidding / budget / roas_target distribution)
  for (const [i, batch] of batches(ids, size).entries()) {
    const res = await call("campaign_setting_info", `Settings, all scanned campaigns (batch ${i + 1})`, { info_type_list: "1,2,3,4", campaign_id_list: batch.join(",") });
    if (res.call.classification !== "AVAILABLE") break;
    for (const c of asArray(asRecord(res.data).campaign_list)) {
      const common = asRecord(asRecord(c).common_info);
      count(summary.statusCounts, common.campaign_status);
      count(summary.adTypeCounts, common.ad_type);
      count(summary.biddingCounts, common.bidding_method);
      if (num(common.campaign_budget) > 0) summary.budgetPositive++;
      else summary.budgetZero++;
      if (num(asRecord(asRecord(c).auto_bidding_info).roas_target) > 0) summary.roasTargetPositive++;
      else summary.roasTargetZero++;
    }
  }

  // 4. non-zero sample: 7-day campaign range (also the campaign-endpoint range check) + one hourly
  const nonZero = [...spendByCampaign.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  summary.nonZeroCampaigns = nonZero.length;
  const sample = nonZero.slice(0, NON_ZERO_SAMPLE);
  if (sample.length) {
    const r7 = await call("campaign_daily_performance", `Top ${sample.length} spending campaigns, 7 days (${dates.sevenDaysAgo} → ${dates.yesterday})`, { start_date: dates.sevenDaysAgo, end_date: dates.yesterday, campaign_id_list: sample.join(",") });
    summary.rangeChecks.push({ endpoint: "campaign_daily_performance", days: 7, classification: r7.call.classification, rows: r7.call.classification === "AVAILABLE" ? (campaignRows(r7.data)[0]?.metrics.length ?? 0) : null });
    await call("campaign_hourly_performance", `Top spending campaign, hourly ${dates.yesterday}`, { performance_date: dates.yesterday, campaign_id_list: sample[0] });
  }

  // 5. shop daily 7 days: restatement window (re-reads the earlier completed days) + range check
  const s7 = await call("shop_daily_performance", `Shop daily, 7 days (${dates.sevenDaysAgo} → ${dates.yesterday}) — restatement + range`, { start_date: dates.sevenDaysAgo, end_date: dates.yesterday });
  summary.rangeChecks.push({ endpoint: "shop_daily_performance", days: 7, classification: s7.call.classification, rows: s7.call.classification === "AVAILABLE" ? asArray(s7.data).length : null });
  const shopRow = asArray(s7.data).map(asRecord).find((r) => r.date === dates.yesterday);
  const shop = shopRow ? (Object.fromEntries(METRIC_KEYS.map((k) => [k, num(shopRow[k])])) as MetricTotals) : null;
  summary.reconciliation = {
    date: dates.yesterday,
    campaignsWithRows,
    shop,
    sumCampaigns: sum,
    delta: shop ? (Object.fromEntries(METRIC_KEYS.map((k) => [k, shop[k] - sum[k]])) as MetricTotals) : null,
  };

  // 6. longer range: 30 days (dashboard preset). No further escalation.
  if (s7.call.classification === "AVAILABLE") {
    const s30 = await call("shop_daily_performance", `Shop daily, 30 days (${dates.thirtyDaysAgo} → ${dates.yesterday}) — range limit`, { start_date: dates.thirtyDaysAgo, end_date: dates.yesterday });
    summary.rangeChecks.push({ endpoint: "shop_daily_performance", days: 30, classification: s30.call.classification, rows: s30.call.classification === "AVAILABLE" ? asArray(s30.data).length : null });
  }
};

function stripRequestId(text: string): string {
  return text.replace(/"request_id"\s*:\s*"[^"]*"/g, '"request_id":""');
}

/** Per-endpoint fixture files from a report (only successful answers). */
export function adsProbeFixtures(report: AdsProbeReport): Array<{ name: string; content: unknown }> {
  const used = new Map<string, number>();
  return report.calls
    .filter((c) => c.classification === "AVAILABLE")
    .map((c) => {
      const base = `${report.kind === "expansion" ? "exp-" : ""}${c.endpoint.replace(/_/g, "-")}`;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      return {
        name: n === 1 ? base : `${base}-${n}`,
        content: {
          _meta: {
            endpoint: c.path,
            method: c.method,
            params: c.params,
            purpose: c.purpose,
            environment: report.environment,
            captured_at: report.startedAt,
            http_status: c.httpStatus,
            latency_ms: c.latencyMs,
            truncated_arrays: c.truncatedArrays,
            note: "Sanitized real response: credentials and shop/partner ids removed; names and provider ids replaced by stable placeholders (consistent across this probe run); metrics untouched.",
          },
          response: c.body,
        },
      };
    });
}
