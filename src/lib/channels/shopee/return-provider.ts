// ============================================================
// PHASE SHOPEE-6: return API port + implementations (same pattern as
// order-provider.ts). The return job depends only on ShopeeReturnProvider;
// providers return RAW provider JSON, parsing is return-adapter.ts's job.
// Never called from UI rendering — only scheduler → queue → worker.
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ShopeeClient } from "./client.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ProductProviderContext, ProviderMode, ProviderPayload } from "./product-provider.ts";
import type { ShopeeTokenSource } from "./token.ts";

export type ReturnProviderContext = ProductProviderContext;

export interface ListReturnsInput {
  /** Unix seconds (update_time range; ≤ MAX_RETURN_WINDOW_SECONDS). */
  updateTimeFrom: number;
  updateTimeTo: number;
  pageNo: number;
  pageSize: number;
}

export interface ShopeeReturnProvider {
  readonly mode: ProviderMode;
  listReturns(ctx: ReturnProviderContext, input: ListReturnsInput): Promise<ProviderPayload>;
  getReturnDetail(ctx: ReturnProviderContext, input: { returnSn: string }): Promise<ProviderPayload>;
}

export const RETURN_PATHS = {
  list: "/api/v2/returns/get_return_list",
  detail: "/api/v2/returns/get_return_detail",
} as const;

/** Documented: time range ≤ 15 days, page_size ≤ 100 — UNVERIFIED on Go-Live (docs/shopee-returns.md). */
export const MAX_RETURN_WINDOW_SECONDS = 15 * 24 * 60 * 60;
export const RETURN_LIST_PAGE_SIZE = 50;

export class RealShopeeReturnProvider implements ShopeeReturnProvider {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  private async call(ctx: ReturnProviderContext, apiName: string, apiPath: string, query: Record<string, string | number>): Promise<ProviderPayload> {
    const accessToken = await this.connections.getValidAccessToken(ctx.shopId);
    try {
      const { data, requestId } = await this.client.request({ path: apiPath, method: "GET", shop: { externalShopId: ctx.externalShopId, accessToken }, query, logShopId: ctx.shopId });
      return { apiName, raw: data, requestId };
    } catch (err) {
      if (err instanceof ShopeeApiError) await this.connections.recordApiFailure(ctx.shopId, err);
      throw err;
    }
  }

  listReturns(ctx: ReturnProviderContext, input: ListReturnsInput) {
    return this.call(ctx, "v2.returns.get_return_list", RETURN_PATHS.list, {
      page_no: input.pageNo,
      page_size: Math.min(input.pageSize, 100),
      update_time_from: input.updateTimeFrom,
      update_time_to: input.updateTimeTo,
    });
  }

  getReturnDetail(ctx: ReturnProviderContext, input: { returnSn: string }) {
    return this.call(ctx, "v2.returns.get_return_detail", RETURN_PATHS.detail, { return_sn: input.returnSn });
  }
}

// --------------------------------------------------------------- fixture

export interface ReturnFixtureSet {
  /** Raw return objects as Shopee returns them (list entries AND detail responses). */
  returnsBySn: Map<string, Record<string, unknown>>;
}

export type FixtureReturnCallHook = (call: { apiName: string; input: unknown }) => void | Promise<void>;

const rid = () => `fixture-${Math.random().toString(16).slice(2, 10)}`;

export class FixtureShopeeReturnProvider implements ShopeeReturnProvider {
  readonly mode = "fixture" as const;
  private readonly fixtures: ReturnFixtureSet;
  private readonly onCall?: FixtureReturnCallHook;
  private readonly failSns: ReadonlySet<string>;

  /** failSns: get_return_detail answers with a provider error for these (failure-isolation tests). */
  constructor(fixtures: ReturnFixtureSet, options: { onCall?: FixtureReturnCallHook; failSns?: Iterable<string> } = {}) {
    this.fixtures = fixtures;
    this.onCall = options.onCall;
    this.failSns = new Set(options.failSns ?? []);
  }

  async listReturns(_ctx: ReturnProviderContext, input: ListReturnsInput): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.returns.get_return_list", input });
    const all = [...this.fixtures.returnsBySn.values()]
      .filter((r) => {
        const t = Number(r.update_time);
        return Number.isFinite(t) && t >= input.updateTimeFrom && t <= input.updateTimeTo;
      })
      .sort((a, b) => Number(a.update_time) - Number(b.update_time));
    const page = all.slice(input.pageNo * input.pageSize, (input.pageNo + 1) * input.pageSize);
    return {
      apiName: "v2.returns.get_return_list",
      raw: { error: "", message: "", request_id: rid(), response: { return: page, more: (input.pageNo + 1) * input.pageSize < all.length } },
      requestId: null,
    };
  }

  async getReturnDetail(_ctx: ReturnProviderContext, input: { returnSn: string }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.returns.get_return_detail", input });
    if (this.failSns.has(input.returnSn)) {
      return { apiName: "v2.returns.get_return_detail", raw: { error: "error_not_found", message: "return not found", request_id: rid() }, requestId: null };
    }
    const r = this.fixtures.returnsBySn.get(input.returnSn);
    return {
      apiName: "v2.returns.get_return_detail",
      raw: r ? { error: "", message: "", request_id: rid(), response: r } : { error: "error_not_found", message: "return not found", request_id: rid() },
      requestId: null,
    };
  }
}

export const DEFAULT_RETURN_FIXTURE_DIR = path.join("tests", "fixtures", "shopee", "return");

export function loadReturnFixtures(dir: string = path.join(process.cwd(), DEFAULT_RETURN_FIXTURE_DIR)): ReturnFixtureSet {
  const returnsBySn = new Map<string, Record<string, unknown>>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^get-return-detail-.+\.json$/.test(f));
  } catch {
    return { returnsBySn };
  }
  for (const f of files) {
    const body = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { response?: Record<string, unknown> };
    if (body.response?.return_sn !== undefined) returnsBySn.set(String(body.response.return_sn), body.response);
  }
  return { returnsBySn };
}
