// Run: node --test src/lib/channels/shopee/shopee.test.ts
// SHOPEE-1 unit tests — no database, no network (FakeShopee via injected fetch).
import { test } from "node:test";
import assert from "node:assert/strict";

import { decryptSecret, encryptSecret, parseEncryptionKey, SecretDecryptError } from "../../security/secrets.ts";
import { buildAuthorizationUrl, parseExternalShopId } from "./auth.ts";
import { ShopeeClient, type ShopeeLogEvent } from "./client.ts";
import { getShopeeConfig, ShopeeConfigError } from "./config.ts";
import { classifyShopeeError, ShopeeApiError } from "./errors.ts";
import { FakeShopee } from "./fake-shopee.test-util.ts";
import { shopeeSignatureBase, signedQuery, signShopeeRequest } from "./signing.ts";
import { generateAuthState, redirectUrlWithState, statesMatch } from "./state.ts";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const VALID_ENV = {
  SHOPEE_PARTNER_ID: "2001887",
  SHOPEE_PARTNER_KEY: "sample-partner-key",
  APP_URL: "https://theo-doi-hang-ve.vercel.app",
  APP_ENCRYPTION_KEY: KEY_B64,
};

// ---------------------------------------------------------------- config (1)

test("1. config fails with a clear message naming every missing variable (never values)", () => {
  assert.throws(
    () => getShopeeConfig({}),
    (err: unknown) =>
      err instanceof ShopeeConfigError &&
      ["SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY", "SHOPEE_REDIRECT_URL", "APP_ENCRYPTION_KEY"].every((name) =>
        err.message.includes(name),
      ),
  );
  assert.throws(() => getShopeeConfig({ ...VALID_ENV, SHOPEE_PARTNER_ID: "abc" }), /số nguyên dương/);
  assert.throws(() => getShopeeConfig({ ...VALID_ENV, APP_ENCRYPTION_KEY: "short-passphrase" }), (err: unknown) => {
    assert.ok(err instanceof ShopeeConfigError);
    assert.ok(!err.message.includes("short-passphrase"), "key value never echoed");
    return true;
  });
});

test("1b. config defaults: production host, redirect derived from APP_URL", () => {
  const config = getShopeeConfig(VALID_ENV);
  assert.equal(config.partnerId, 2001887);
  assert.equal(config.apiBaseUrl, "https://partner.shopeemobile.com");
  assert.equal(config.redirectUrl, "https://theo-doi-hang-ve.vercel.app/api/shopee/auth/callback");
  assert.equal(config.encryptionKey.length, 32);
});

// --------------------------------------------------------------- signing (2)

test("2. signing matches independent openssl HMAC-SHA256 reference vectors", () => {
  // printf '%s' "<base>" | openssl dgst -sha256 -hmac "sample-partner-key"
  const common = { partnerId: 2001887, partnerKey: "sample-partner-key", timestamp: 1655714431 };
  assert.equal(
    signShopeeRequest({ ...common, path: "/api/v2/shop/auth_partner", scope: { kind: "public" } }),
    "434b55d63fbc27001c489d1150735e2841aa5d7a5ae4090c159be65296624b3e",
  );
  assert.equal(
    signShopeeRequest({
      ...common,
      path: "/api/v2/shop/get_shop_info",
      scope: { kind: "shop", accessToken: "ACCESSTOKEN", shopId: "123456789" },
    }),
    "807462f535c0b7c4373db05995767a486dbad202dff76ac510d429e0fc9779cf",
  );
});

test("2b. signing is deterministic; base string order is partner_id+path+timestamp[+token+shop_id]", () => {
  const input = { partnerId: 1, partnerKey: "k", path: "/api/v2/x", timestamp: 10, scope: { kind: "public" as const } };
  assert.equal(signShopeeRequest(input), signShopeeRequest(input));
  assert.equal(shopeeSignatureBase(input), "1/api/v2/x10");
  assert.equal(shopeeSignatureBase({ ...input, scope: { kind: "shop", accessToken: "T", shopId: "9" } }), "1/api/v2/x10T9");
  const q = signedQuery({ ...input, scope: { kind: "shop", accessToken: "T", shopId: "9" } });
  assert.deepEqual(Object.keys(q).sort(), ["access_token", "partner_id", "shop_id", "sign", "timestamp"]);
  assert.throws(() => signShopeeRequest({ ...input, path: "https://host/api/v2/x" }));
  assert.throws(() => signShopeeRequest({ ...input, timestamp: 1655714431000.5 }));
});

// ----------------------------------------------------------------- state (4,5)

test("4 + 5. auth state: random, round-trips in the redirect URL, mismatches rejected", () => {
  const a = generateAuthState();
  assert.notEqual(a, generateAuthState());
  assert.ok(a.length >= 40);
  const redirect = new URL(redirectUrlWithState("https://app.example/api/shopee/auth/callback", a));
  assert.equal(redirect.searchParams.get("state"), a);
  assert.equal(statesMatch(a, a), true);
  assert.equal(statesMatch(a, generateAuthState()), false);
  assert.equal(statesMatch(a, null), false, "missing cookie rejected");
  assert.equal(statesMatch(null, a), false, "missing query rejected");
  assert.equal(statesMatch(a, a.slice(0, -1)), false);
});

test("auth URL: signed public link to auth_partner with our redirect; partner key never in it", () => {
  const client = new ShopeeClient({ partnerId: 2001887, partnerKey: "sample-partner-key", apiBaseUrl: "https://partner.shopeemobile.com", now: () => new Date(1655714431000) });
  const url = new URL(buildAuthorizationUrl(client, "https://app.example/cb?state=abc"));
  assert.equal(url.origin + url.pathname, "https://partner.shopeemobile.com/api/v2/shop/auth_partner");
  assert.equal(url.searchParams.get("redirect"), "https://app.example/cb?state=abc");
  assert.equal(url.searchParams.get("sign"), "434b55d63fbc27001c489d1150735e2841aa5d7a5ae4090c159be65296624b3e");
  assert.ok(!url.toString().includes("sample-partner-key"));
});

test("external shop id parsing accepts only positive numeric ids", () => {
  assert.equal(parseExternalShopId("123456789"), "123456789");
  for (const bad of [null, "", "0", "-1", "12a", "1e5", "99999999999999999999"]) assert.equal(parseExternalShopId(bad), null, String(bad));
});

// --------------------------------------------------------------- secrets (10)

test("10. encryptSecret/decryptSecret: versioned AES-GCM, random IV, context-bound, tamper-evident", () => {
  const key = parseEncryptionKey(KEY_B64);
  const a = encryptSecret("access-token-xyz", key, "shop_connections:s1:access_token");
  const b = encryptSecret("access-token-xyz", key, "shop_connections:s1:access_token");
  assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.notEqual(a, b, "random IV");
  assert.ok(!a.includes("access-token-xyz"));
  assert.equal(decryptSecret(a, key, "shop_connections:s1:access_token"), "access-token-xyz");
  assert.throws(() => decryptSecret(a, key, "shop_connections:s2:access_token"), SecretDecryptError, "other shop's row");
  assert.throws(() => decryptSecret(a, key, "shop_connections:s1:refresh_token"), SecretDecryptError, "other column");
  assert.throws(() => decryptSecret(a, Buffer.alloc(32, 8), "shop_connections:s1:access_token"), SecretDecryptError, "wrong key");
  const parts = a.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptSecret(parts.join("."), key, "shop_connections:s1:access_token"), SecretDecryptError);
  assert.throws(() => decryptSecret("v0.a.b.c", key, "x"), SecretDecryptError);
  assert.throws(() => parseEncryptionKey(Buffer.alloc(16).toString("base64")));
});

// ---------------------------------------------------------- errors / client

test("error classification: auth / signature / rate limit / transient / validation", () => {
  assert.equal(classifyShopeeError("error_auth", 200), "auth");
  assert.equal(classifyShopeeError("invalid_access_token", 200), "auth");
  assert.equal(classifyShopeeError("error_permission", 403), "auth");
  assert.equal(classifyShopeeError("error_sign", 200), "signature");
  assert.equal(classifyShopeeError("error_too_many_request", 429), "rate_limit");
  assert.equal(classifyShopeeError("http_429", 429), "rate_limit");
  assert.equal(classifyShopeeError("error_server", 500), "transient");
  assert.equal(classifyShopeeError("system_busy", 200), "transient");
  assert.equal(classifyShopeeError("network_error", null), "transient");
  assert.equal(classifyShopeeError("error_param", 200), "invalid_request");
  assert.equal(classifyShopeeError("something_new", 200), "unknown");
  assert.equal(new ShopeeApiError({ apiPath: "/x", errorCode: "error_server", message: "m", httpStatus: 500 }).retryable, true);
  assert.equal(new ShopeeApiError({ apiPath: "/x", errorCode: "error_sign", message: "m" }).retryable, false);
});

function makeClient(fake: FakeShopee, logs: ShopeeLogEvent[] = [], extra: Partial<ConstructorParameters<typeof ShopeeClient>[0]> = {}) {
  return new ShopeeClient({
    partnerId: fake.partnerId,
    partnerKey: "sample-partner-key",
    apiBaseUrl: "https://partner.test.example",
    fetch: fake.fetch,
    sleep: async () => {},
    logger: (e) => logs.push(e),
    ...extra,
  });
}

async function shopToken(fake: FakeShopee, externalShopId: string) {
  fake.addShop(externalShopId);
  const client = makeClient(fake);
  const { data } = await client.request<{ access_token?: string }>({
    path: "/api/v2/auth/token/get",
    method: "POST",
    body: { code: fake.issueCode(externalShopId), shop_id: Number(externalShopId), partner_id: fake.partnerId },
  });
  return data.access_token!;
}

test("18 + 19. client success returns request_id/latency; provider errors normalized with request_id", async () => {
  const fake = new FakeShopee(2001887, "sample-partner-key");
  const token = await shopToken(fake, "555");
  const client = makeClient(fake);
  const ok = await client.request<{ shop_name?: string }>({ path: "/api/v2/shop/get_shop_info", method: "GET", shop: { externalShopId: "555", accessToken: token } });
  assert.equal(ok.data.shop_name, "HOMIES Test Shop");
  assert.match(ok.requestId ?? "", /^req-/);
  assert.equal(typeof ok.latencyMs, "number");

  await assert.rejects(
    client.request({ path: "/api/v2/shop/get_shop_info", method: "GET", shop: { externalShopId: "555", accessToken: "wrong" } }),
    (err: unknown) => {
      assert.ok(err instanceof ShopeeApiError);
      assert.equal(err.errorCode, "invalid_access_token");
      assert.equal(err.category, "auth");
      assert.equal(err.retryable, false);
      assert.match(err.requestId ?? "", /^req-/, "request_id kept for Shopee support");
      assert.equal(err.apiPath, "/api/v2/shop/get_shop_info");
      return true;
    },
  );
});

test("17 (client). retry policy: GET retried on 5xx/network/429 (bounded), never on signature/auth or POST", async () => {
  const fake = new FakeShopee(2001887, "sample-partner-key");
  const token = await shopToken(fake, "777");
  const sleeps: number[] = [];
  const client = makeClient(fake, [], { sleep: async (ms) => void sleeps.push(ms) });
  const call = () => client.request({ path: "/api/v2/shop/get_shop_info", method: "GET", shop: { externalShopId: "777", accessToken: token } });

  fake.failNext("/api/v2/shop/get_shop_info", { kind: "http5xx" }, { kind: "network" });
  const res = await call();
  assert.equal(res.attempts, 3, "two retries then success");

  fake.failNext("/api/v2/shop/get_shop_info", { kind: "http5xx" }, { kind: "http5xx" }, { kind: "http5xx" });
  await assert.rejects(call(), (err: unknown) => err instanceof ShopeeApiError && err.category === "transient");
  assert.equal(fake.count("/api/v2/shop/get_shop_info"), 3 + 3, "capped at 1 + MAX_READ_RETRIES attempts");

  sleeps.length = 0;
  fake.failNext("/api/v2/shop/get_shop_info", { kind: "rate_limit", retryAfter: "3" });
  await call();
  assert.equal(sleeps[0], 3000, "Retry-After honoured");

  const before = fake.count("/api/v2/shop/get_shop_info");
  fake.failNext("/api/v2/shop/get_shop_info", { kind: "error", error: "error_sign", message: "Wrong sign" });
  await assert.rejects(call());
  assert.equal(fake.count("/api/v2/shop/get_shop_info") - before, 1, "signature error not retried");

  fake.failNext("/api/v2/auth/access_token/get", { kind: "http5xx" });
  const postBefore = fake.count("/api/v2/auth/access_token/get");
  await assert.rejects(client.request({ path: "/api/v2/auth/access_token/get", method: "POST", body: {} }));
  assert.equal(fake.count("/api/v2/auth/access_token/get") - postBefore, 1, "POST (refresh) never retried");
});

test("timeout surfaces as a transient ShopeeApiError", async () => {
  const hanging = (_input: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const client = new ShopeeClient({ partnerId: 1, partnerKey: "k", apiBaseUrl: "https://x.example", fetch: hanging, timeoutMs: 20, maxRetries: 0, logger: () => {} });
  await assert.rejects(client.request({ path: "/api/v2/shop/get_shop_info", method: "GET" }), (err: unknown) =>
    err instanceof ShopeeApiError && err.errorCode === "timeout" && err.retryable,
  );
});

test("concurrency cap: never more than maxConcurrent requests in flight", async () => {
  let active = 0;
  let peak = 0;
  const slow = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return new Response(JSON.stringify({ error: "", request_id: "r" }), { status: 200 });
  };
  const client = new ShopeeClient({ partnerId: 1, partnerKey: "k", apiBaseUrl: "https://x.example", fetch: slow, maxConcurrent: 2, logger: () => {} });
  await Promise.all(Array.from({ length: 7 }, () => client.request({ path: "/api/v2/shop/get_shop_info", method: "GET" })));
  assert.equal(peak, 2);
});

test("22. logs and errors never contain partner key, tokens, signature or query string", async () => {
  const fake = new FakeShopee(2001887, "sample-partner-key");
  const logs: ShopeeLogEvent[] = [];
  const token = await shopToken(fake, "888");
  const client = makeClient(fake, logs);
  await client.request({ path: "/api/v2/shop/get_shop_info", method: "GET", shop: { externalShopId: "888", accessToken: token } });
  await client.request({ path: "/api/v2/shop/get_shop_info", method: "GET", shop: { externalShopId: "888", accessToken: "bad-token-value" } }).catch(() => {});
  // Provider echoing a secret back is redacted from the error message.
  fake.failNext("/api/v2/auth/access_token/get", { kind: "error", error: "error_auth", message: `refresh_token ${"rt-secret-123"} is invalid` });
  const echoed = await client
    .request({ path: "/api/v2/auth/access_token/get", method: "POST", body: { refresh_token: "rt-secret-123" } })
    .catch((e: unknown) => e as ShopeeApiError);

  const serialized = JSON.stringify(logs) + JSON.stringify(echoed);
  for (const secret of ["sample-partner-key", token, "bad-token-value", "rt-secret-123", "sign=", "access_token="]) {
    assert.ok(!serialized.includes(secret), `leaked: ${secret}`);
  }
  assert.ok(logs.length >= 3);
  assert.ok(logs.every((l) => l.apiPath && typeof l.latencyMs === "number"));
});
