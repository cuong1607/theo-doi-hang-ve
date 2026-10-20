// ============================================================
// PHASE SHOPEE-6B: return-logistics API port + implementations (same
// pattern as return-provider.ts). Providers return RAW provider JSON;
// parsing is return-logistics-adapter.ts's job. Never called from UI
// rendering — only scheduler → queue → worker (and the read-only dev tool).
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ShopeeClient } from "./client.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ProductProviderContext, ProviderMode, ProviderPayload } from "./product-provider.ts";
import { RETURN_LOGISTICS_API } from "./return-logistics-adapter.ts";
import type { ShopeeTokenSource } from "./token.ts";

export type ReturnLogisticsProviderContext = ProductProviderContext;

export interface ShopeeReturnLogisticsProvider {
  readonly mode: ProviderMode;
  getReverseTrackingInfo(ctx: ReturnLogisticsProviderContext, input: { returnSn: string }): Promise<ProviderPayload>;
  getTrackingNumber(ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }): Promise<ProviderPayload>;
  getTrackingInfo(ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }): Promise<ProviderPayload>;
}

export const RETURN_LOGISTICS_PATHS = {
  reverse: "/api/v2/returns/get_reverse_tracking_info",
  trackingNumber: "/api/v2/logistics/get_tracking_number",
  trackingInfo: "/api/v2/logistics/get_tracking_info",
} as const;

export class RealShopeeReturnLogisticsProvider implements ShopeeReturnLogisticsProvider {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  private async call(ctx: ReturnLogisticsProviderContext, apiName: string, apiPath: string, query: Record<string, string | number>): Promise<ProviderPayload> {
    const accessToken = await this.connections.getValidAccessToken(ctx.shopId);
    try {
      const { data, requestId } = await this.client.request({ path: apiPath, method: "GET", shop: { externalShopId: ctx.externalShopId, accessToken }, query, logShopId: ctx.shopId });
      return { apiName, raw: data, requestId };
    } catch (err) {
      if (err instanceof ShopeeApiError) await this.connections.recordApiFailure(ctx.shopId, err);
      throw err;
    }
  }

  getReverseTrackingInfo(ctx: ReturnLogisticsProviderContext, input: { returnSn: string }) {
    return this.call(ctx, RETURN_LOGISTICS_API.reverse, RETURN_LOGISTICS_PATHS.reverse, { return_sn: input.returnSn });
  }

  getTrackingNumber(ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }) {
    return this.call(ctx, RETURN_LOGISTICS_API.trackingNumber, RETURN_LOGISTICS_PATHS.trackingNumber, {
      order_sn: input.orderSn,
      ...(input.packageNumber ? { package_number: input.packageNumber } : {}),
    });
  }

  getTrackingInfo(ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }) {
    return this.call(ctx, RETURN_LOGISTICS_API.trackingInfo, RETURN_LOGISTICS_PATHS.trackingInfo, {
      order_sn: input.orderSn,
      ...(input.packageNumber ? { package_number: input.packageNumber } : {}),
    });
  }
}

// --------------------------------------------------------------- fixture

export interface ReturnLogisticsFixtureSet {
  /** get_reverse_tracking_info `response` objects by return_sn. */
  reverseBySn: Map<string, Record<string, unknown>>;
  /** get_tracking_info `response` objects by order_sn. */
  trackingByOrderSn: Map<string, Record<string, unknown>>;
  /** tracking numbers by order_sn. */
  trackingNumberByOrderSn: Map<string, string>;
}

export const emptyReturnLogisticsFixtures = (): ReturnLogisticsFixtureSet => ({ reverseBySn: new Map(), trackingByOrderSn: new Map(), trackingNumberByOrderSn: new Map() });

export type FixtureReturnLogisticsCallHook = (call: { apiName: string; input: unknown }) => void | Promise<void>;
const rid = () => `fixture-${Math.random().toString(16).slice(2, 10)}`;
const notFound = (apiName: string): ProviderPayload => ({ apiName, raw: { error: "error_not_found", message: "not found", request_id: rid() }, requestId: null });

export class FixtureShopeeReturnLogisticsProvider implements ShopeeReturnLogisticsProvider {
  readonly mode = "fixture" as const;
  private readonly fixtures: ReturnLogisticsFixtureSet;
  private readonly onCall?: FixtureReturnLogisticsCallHook;

  constructor(fixtures: ReturnLogisticsFixtureSet, options: { onCall?: FixtureReturnLogisticsCallHook } = {}) {
    this.fixtures = fixtures;
    this.onCall = options.onCall;
  }

  async getReverseTrackingInfo(_ctx: ReturnLogisticsProviderContext, input: { returnSn: string }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: RETURN_LOGISTICS_API.reverse, input });
    const r = this.fixtures.reverseBySn.get(input.returnSn);
    return r ? { apiName: RETURN_LOGISTICS_API.reverse, raw: { error: "", message: "", request_id: rid(), response: r }, requestId: null } : notFound(RETURN_LOGISTICS_API.reverse);
  }

  async getTrackingNumber(_ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: RETURN_LOGISTICS_API.trackingNumber, input });
    const t = this.fixtures.trackingNumberByOrderSn.get(input.orderSn);
    return { apiName: RETURN_LOGISTICS_API.trackingNumber, raw: { error: "", message: "", request_id: rid(), response: { tracking_number: t ?? "" } }, requestId: null };
  }

  async getTrackingInfo(_ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: RETURN_LOGISTICS_API.trackingInfo, input });
    const r = this.fixtures.trackingByOrderSn.get(input.orderSn);
    return r ? { apiName: RETURN_LOGISTICS_API.trackingInfo, raw: { error: "", message: "", request_id: rid(), response: r }, requestId: null } : notFound(RETURN_LOGISTICS_API.trackingInfo);
  }
}

export const DEFAULT_RETURN_LOGISTICS_FIXTURE_DIR = path.join("tests", "fixtures", "shopee", "return-logistics");

/** reverse-tracking-<sn>.json / tracking-info-<orderSn>.json (full envelopes, `response` used). */
export function loadReturnLogisticsFixtures(dir: string = path.join(process.cwd(), DEFAULT_RETURN_LOGISTICS_FIXTURE_DIR)): ReturnLogisticsFixtureSet {
  const set = emptyReturnLogisticsFixtures();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return set;
  }
  for (const f of files) {
    const body = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { response?: Record<string, unknown>; tracking_number?: string };
    const r = body.response;
    if (!r) continue;
    if (f.startsWith("reverse-tracking-") && r.return_sn !== undefined) set.reverseBySn.set(String(r.return_sn), r);
    if (f.startsWith("tracking-info-") && typeof r.order_sn === "string") {
      set.trackingByOrderSn.set(r.order_sn, r);
      if (body.tracking_number) set.trackingNumberByOrderSn.set(r.order_sn, body.tracking_number);
    }
  }
  return set;
}
