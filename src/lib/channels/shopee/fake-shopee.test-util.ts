// ============================================================
// TEST-ONLY in-memory fake of the Shopee v2 endpoints SHOPEE-1 uses.
// Never imported by app code. It VERIFIES signatures with the same documented
// rule (independent HMAC, not signing.ts), enforces the timestamp window,
// issues/rotates tokens, and can inject failures.
//
// It encodes our UNDERSTANDING of Shopee (third-party docs) — passing tests
// against it proves our code is self-consistent, not that Shopee agrees.
// Real-payload validation is a separate, manual step (see docs).
// ============================================================
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

type Failure =
  | { kind: "http5xx" }
  | { kind: "network" }
  | { kind: "rate_limit"; retryAfter?: string }
  | { kind: "error"; error: string; message: string };

interface FakeShop {
  codes: Set<string>;
  accessTokens: Map<string, number>; // token → expiry (ms)
  refreshTokens: Set<string>;
  revoked: boolean;
}

export class FakeShopee {
  readonly shops = new Map<string, FakeShop>();
  readonly calls: Array<{ path: string; method: string }> = [];
  private readonly failures = new Map<string, Failure[]>();
  private counter = 0;
  /** Artificial latency for refresh (ms) — widens race windows in concurrency tests. */
  refreshDelayMs = 0;
  expireInSeconds = 14400;
  shopName = "HOMIES Test Shop";

  readonly partnerId: number;
  private readonly partnerKey: string;
  private readonly nowMs: () => number;

  constructor(partnerId: number, partnerKey: string, nowMs: () => number = () => Date.now()) {
    this.partnerId = partnerId;
    this.partnerKey = partnerKey;
    this.nowMs = nowMs;
  }

  addShop(externalShopId: string): FakeShop {
    const shop: FakeShop = { codes: new Set(), accessTokens: new Map(), refreshTokens: new Set(), revoked: false };
    this.shops.set(externalShopId, shop);
    return shop;
  }

  issueCode(externalShopId: string): string {
    const code = `code-${++this.counter}-${randomUUID()}`;
    this.shops.get(externalShopId)!.codes.add(code);
    return code;
  }

  /** Queue failures for a path (consumed one per call). */
  failNext(path: string, ...failures: Failure[]): void {
    this.failures.set(path, [...(this.failures.get(path) ?? []), ...failures]);
  }

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  /** Expire every access token of a shop (simulates time passing on Shopee's side). */
  invalidateAccessTokens(externalShopId: string): void {
    this.shops.get(externalShopId)!.accessTokens.clear();
  }

  private sign(base: string): string {
    return createHmac("sha256", this.partnerKey).update(base).digest("hex");
  }

  private issueTokens(shop: FakeShop) {
    const n = ++this.counter;
    const access = `acc-${n}-${randomUUID()}`;
    const refresh = `ref-${n}-${randomUUID()}`;
    shop.accessTokens.set(access, this.nowMs() + this.expireInSeconds * 1000);
    shop.refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, expire_in: this.expireInSeconds };
  }

  /** Core handler shared by the fetch adapter and the HTTP server. */
  async handle(method: string, rawUrl: string, bodyText: string | null): Promise<{ status: number; json?: unknown; headers?: Record<string, string>; network?: boolean }> {
    const url = new URL(rawUrl);
    const path = url.pathname;
    this.calls.push({ path, method });
    const requestId = `req-${randomUUID()}`;
    const reply = (json: Record<string, unknown>, status = 200) => ({ status, json: { request_id: requestId, error: "", message: "", ...json } });
    const err = (error: string, message: string, status = 200) => reply({ error, message }, status);

    const queued = this.failures.get(path);
    const failure = queued?.shift();
    if (failure) {
      if (failure.kind === "network") return { status: 0, network: true };
      if (failure.kind === "http5xx") return { status: 502, json: { error: "error_server", message: "Bad gateway", request_id: requestId } };
      if (failure.kind === "rate_limit") {
        return { status: 429, json: { error: "error_too_many_request", message: "Too many requests", request_id: requestId }, headers: failure.retryAfter ? { "retry-after": failure.retryAfter } : {} };
      }
      return err(failure.error, failure.message);
    }

    const q = url.searchParams;
    const timestamp = Number(q.get("timestamp"));
    if (q.get("partner_id") !== String(this.partnerId)) return err("error_param", "partner_id mismatch");
    if (!Number.isInteger(timestamp) || Math.abs(this.nowMs() / 1000 - timestamp) > 300) return err("error_sign", "timestamp expired");

    const accessToken = q.get("access_token");
    const shopIdParam = q.get("shop_id");
    const isShopCall = path === "/api/v2/shop/get_shop_info";
    const base = isShopCall ? `${this.partnerId}${path}${timestamp}${accessToken ?? ""}${shopIdParam ?? ""}` : `${this.partnerId}${path}${timestamp}`;
    if (q.get("sign") !== this.sign(base)) return err("error_sign", "Wrong sign.");

    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};

    if (path === "/api/v2/shop/auth_partner") {
      return { status: 200, json: { redirect: q.get("redirect") } };
    }

    if (path === "/api/v2/auth/token/get") {
      const shop = this.shops.get(String(body.shop_id));
      if (body.partner_id !== this.partnerId) return err("error_param", "partner_id mismatch");
      if (!shop || typeof body.code !== "string" || !shop.codes.delete(body.code)) return err("error_auth", "Invalid code");
      shop.revoked = false;
      return reply({ ...this.issueTokens(shop), shop_id_list: [Number(body.shop_id)] });
    }

    if (path === "/api/v2/auth/access_token/get") {
      if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
      const shop = this.shops.get(String(body.shop_id));
      if (!shop) return err("error_param", "shop not found");
      if (shop.revoked) return err("error_auth", "Shop authorization has been revoked by seller.");
      if (typeof body.refresh_token !== "string" || !shop.refreshTokens.delete(body.refresh_token)) {
        return err("error_auth", "Invalid refresh_token.");
      }
      return reply({ ...this.issueTokens(shop), shop_id: Number(body.shop_id), partner_id: this.partnerId });
    }

    if (isShopCall) {
      const shop = this.shops.get(shopIdParam ?? "");
      const expiry = shop && accessToken ? shop.accessTokens.get(accessToken) : undefined;
      if (!shop || expiry === undefined || expiry < this.nowMs()) return err("invalid_access_token", "Invalid access_token.");
      return reply({ shop_name: this.shopName, region: "VN", status: "NORMAL", expire_time: Math.floor(this.nowMs() / 1000) + 365 * 86400 });
    }

    return err("error_not_found", "unknown path", 404);
  }

  /** fetch-compatible adapter for ShopeeClient({ fetch }). */
  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const result = await this.handle(init?.method ?? "GET", input, typeof init?.body === "string" ? init.body : null);
    if (result.network) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(result.json), {
      status: result.status,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    });
  };

  /** Real HTTP server (for end-to-end runs of the Next app); auth_partner answers with a 302. */
  listen(port: number, hooks: { onAuthPartner?: (redirect: string) => { externalShopId: string } } = {}): Promise<Server> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const url = `http://127.0.0.1:${port}${req.url}`;
        const result = await this.handle(req.method ?? "GET", url, chunks.length ? Buffer.concat(chunks).toString("utf8") : null);
        const payload = result.json as { redirect?: string; error?: string } | undefined;
        if (new URL(url).pathname === "/api/v2/shop/auth_partner" && payload?.redirect && !payload.error) {
          const { externalShopId } = hooks.onAuthPartner?.(payload.redirect) ?? { externalShopId: [...this.shops.keys()][0] };
          const target = new URL(payload.redirect);
          target.searchParams.set("code", this.issueCode(externalShopId));
          target.searchParams.set("shop_id", externalShopId);
          res.writeHead(302, { location: target.toString() });
          return res.end();
        }
        res.writeHead(result.status || 500, { "content-type": "application/json", ...(result.headers ?? {}) });
        res.end(JSON.stringify(result.json ?? {}));
      });
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
  }
}
