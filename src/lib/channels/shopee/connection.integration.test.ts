// ============================================================
// SHOPEE-1 — connection/token lifecycle against the REAL database in
// .env.local (local Docker Supabase in dev) and an in-memory FakeShopee:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/connection.integration.test.ts
//
// Each test uses its own random numeric external shop id; every shop it
// creates is deleted in `after` (cascades to shop_connections).
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { ShopeeClient, type ShopeeLogEvent } from "./client.ts";
import { ShopeeApiError } from "./errors.ts";
import { FakeShopee } from "./fake-shopee.test-util.ts";
import { getShopeeConnectionHealth, ShopeeConnectionService } from "./token.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const PARTNER_ID = 2001887;
const PARTNER_KEY = "integration-partner-key";
const KEY = Buffer.alloc(32, 42);
const createdExternalIds: string[] = [];

after(async () => {
  if (createdExternalIds.length) {
    await db.from("shops").delete().eq("channel", "shopee").in("external_shop_id", createdExternalIds);
  }
});

function newExternalId(): string {
  const id = String(randomInt(9_000_000_000, 9_999_999_999));
  createdExternalIds.push(id);
  return id;
}

function setup(fake = new FakeShopee(PARTNER_ID, PARTNER_KEY), opts: { key?: Buffer; logs?: ShopeeLogEvent[] } = {}) {
  const logs = opts.logs ?? [];
  const client = new ShopeeClient({
    partnerId: PARTNER_ID,
    partnerKey: PARTNER_KEY,
    apiBaseUrl: "https://partner.fake.example",
    fetch: fake.fetch,
    sleep: async () => {},
    logger: (e) => logs.push(e),
  });
  const service = new ShopeeConnectionService({ db, client, encryptionKey: opts.key ?? KEY, logger: (e) => logs.push(e) });
  return { fake, client, service, logs };
}

async function connect(env = setup()) {
  const externalShopId = newExternalId();
  env.fake.addShop(externalShopId);
  const result = await env.service.completeAuthorization({ code: env.fake.issueCode(externalShopId), externalShopId });
  return { ...env, externalShopId, shopId: result.shopId, result };
}

async function connectionRow(shopId: string) {
  const { data } = await db.from("shop_connections").select("*").eq("shop_id", shopId).single();
  return data as Record<string, string | null>;
}

async function expireSoon(shopId: string, minutesLeft = 2) {
  await db
    .from("shop_connections")
    .update({ access_token_expires_at: new Date(Date.now() + minutesLeft * 60_000).toISOString() })
    .eq("shop_id", shopId);
}

// ------------------------------------------------------------------ auth

test("6 + 8 + 9. token exchange success upserts shop (Shopee-provided id) + connected connection", async () => {
  const { shopId, externalShopId, result } = await connect();
  assert.equal(result.reconnected, false);
  assert.equal(result.shopName, "HOMIES Test Shop");
  const { data: shop } = await db.from("shops").select("channel, external_shop_id, shop_name, region, is_active").eq("id", shopId).single();
  assert.deepEqual(shop, { channel: "shopee", external_shop_id: externalShopId, shop_name: "HOMIES Test Shop", region: "VN", is_active: true });
  const row = await connectionRow(shopId);
  assert.equal(row.connection_status, "connected");
  assert.equal(row.provider, "shopee");
  const msLeft = new Date(row.access_token_expires_at!).getTime() - Date.now();
  assert.ok(msLeft > 3.9 * 3600_000 && msLeft <= 4 * 3600_000, "expiry = now + expire_in");
});

test("8 + 9 (reconnect). same shop authorized again → same shops row, one connection, reconnected", async () => {
  const env = await connect();
  const again = await env.service.completeAuthorization({ code: env.fake.issueCode(env.externalShopId), externalShopId: env.externalShopId });
  assert.equal(again.shopId, env.shopId);
  assert.equal(again.reconnected, true);
  const { count } = await db.from("shop_connections").select("id", { count: "exact", head: true }).eq("shop_id", env.shopId);
  assert.equal(count, 1);
  assert.ok(env.logs.some((l) => l.event === "SHOPEE_RECONNECTED"));
});

test("7. token exchange failure: error normalized; existing shop's connection → error; unknown shop not created", async () => {
  const env = await connect();
  await assert.rejects(
    env.service.completeAuthorization({ code: "used-or-forged-code", externalShopId: env.externalShopId }),
    (err: unknown) => err instanceof ShopeeApiError && err.errorCode === "error_auth" && err.requestId !== null,
  );
  const row = await connectionRow(env.shopId);
  assert.equal(row.connection_status, "error");
  assert.equal(row.last_error_code, "error_auth");
  assert.match(row.last_error_message!, /request_id: req-/);

  const unknownId = newExternalId();
  env.fake.addShop(unknownId);
  await assert.rejects(env.service.completeAuthorization({ code: "nope", externalShopId: unknownId }));
  const { count } = await db.from("shops").select("id", { count: "exact", head: true }).eq("external_shop_id", unknownId);
  assert.equal(count, 0, "no shop invented from a failed exchange");
});

// ---------------------------------------------------------------- storage

test("11. tokens stored encrypted only (v1 format, context-bound); plaintext never in the row", async () => {
  const env = await connect();
  const token = await env.service.getValidAccessToken(env.shopId);
  const row = await connectionRow(env.shopId);
  const rowText = JSON.stringify(row);
  assert.ok(!rowText.includes(token), "access token plaintext absent");
  const refreshTokens = [...env.fake.shops.get(env.externalShopId)!.refreshTokens];
  assert.ok(refreshTokens.every((rt) => !rowText.includes(rt)), "refresh token plaintext absent");
  assert.match(row.access_token_encrypted!, /^v1\./);
  assert.match(row.refresh_token_encrypted!, /^v1\./);

  // Ciphertext copied onto ANOTHER shop's row must not decrypt there.
  const other = await connect(setup(env.fake));
  await db.from("shop_connections").update({ access_token_encrypted: row.access_token_encrypted }).eq("shop_id", other.shopId);
  await assert.rejects(other.service.getValidAccessToken(other.shopId), (err: unknown) => err instanceof ShopeeApiError && err.errorCode === "decrypt_failed");
});

test("decrypt failure (APP_ENCRYPTION_KEY changed) → decrypt_failed, connection marked error", async () => {
  const env = await connect();
  const wrongKey = setup(env.fake, { key: Buffer.alloc(32, 1) });
  await assert.rejects(wrongKey.service.getValidAccessToken(env.shopId), (err: unknown) => err instanceof ShopeeApiError && err.errorCode === "decrypt_failed");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await connectionRow(env.shopId)).connection_status, "error");
});

// ---------------------------------------------------------------- refresh

test("12. valid token returned without refresh", async () => {
  const env = await connect();
  const a = await env.service.getValidAccessToken(env.shopId);
  const b = await env.service.getValidAccessToken(env.shopId);
  assert.equal(a, b);
  assert.equal(env.fake.count("/api/v2/auth/access_token/get"), 0);
});

test("13 + 14. near-expiry token refreshes; new access AND rotated refresh token persisted", async () => {
  const env = await connect();
  const before = await connectionRow(env.shopId);
  const oldToken = await env.service.getValidAccessToken(env.shopId);
  await expireSoon(env.shopId, 5); // inside the 10-minute safety buffer

  const fresh = await env.service.getValidAccessToken(env.shopId);
  assert.notEqual(fresh, oldToken);
  assert.equal(env.fake.count("/api/v2/auth/access_token/get"), 1);
  const after = await connectionRow(env.shopId);
  assert.notEqual(after.access_token_encrypted, before.access_token_encrypted);
  assert.notEqual(after.refresh_token_encrypted, before.refresh_token_encrypted, "rotated refresh token stored");
  assert.ok(after.last_token_refresh_at);
  assert.equal(after.refresh_lock_id, null, "lease released");
  assert.ok(new Date(after.access_token_expires_at!).getTime() - Date.now() > 3.9 * 3600_000);

  // The stored (rotated) refresh token works for the next refresh too.
  await expireSoon(env.shopId, 1);
  await env.service.getValidAccessToken(env.shopId);
  assert.equal(env.fake.count("/api/v2/auth/access_token/get"), 2);
  assert.equal((await connectionRow(env.shopId)).connection_status, "connected");
});

test("15. concurrent refresh across instances: exactly ONE refresh call, everyone gets the same token", async () => {
  const env = await connect();
  env.fake.refreshDelayMs = 400;
  await expireSoon(env.shopId, 1);
  // Two independent service instances = two serverless instances (no shared memory).
  const instanceA = setup(env.fake);
  const instanceB = setup(env.fake);
  const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const a = new ShopeeConnectionService({ db, client: instanceA.client, encryptionKey: KEY, sleep: realSleep, logger: () => {} });
  const b = new ShopeeConnectionService({ db, client: instanceB.client, encryptionKey: KEY, sleep: realSleep, logger: () => {} });

  const tokens = await Promise.all([
    ...Array.from({ length: 4 }, () => a.getValidAccessToken(env.shopId)),
    ...Array.from({ length: 4 }, () => b.getValidAccessToken(env.shopId)),
  ]);
  assert.equal(env.fake.count("/api/v2/auth/access_token/get"), 1, "single refresh_token grant");
  assert.equal(new Set(tokens).size, 1, "all callers share the refreshed token");
  const row = await connectionRow(env.shopId);
  assert.equal(row.connection_status, "connected");
  assert.equal(row.refresh_lock_id, null);
  env.fake.refreshDelayMs = 0;
});

test("16. refresh rejected because seller revoked → revoked; later calls fail fast without calling Shopee", async () => {
  const env = await connect();
  env.fake.shops.get(env.externalShopId)!.revoked = true;
  await expireSoon(env.shopId, 1);
  await assert.rejects(env.service.getValidAccessToken(env.shopId), (err: unknown) => err instanceof ShopeeApiError && err.category === "auth");
  const row = await connectionRow(env.shopId);
  assert.equal(row.connection_status, "revoked");
  assert.equal(row.last_error_code, "error_auth");
  assert.ok(env.logs.some((l) => l.event === "SHOPEE_REVOKED"));

  const callsBefore = env.fake.calls.length;
  await assert.rejects(env.service.getValidAccessToken(env.shopId), (err: unknown) => err instanceof ShopeeApiError && err.errorCode === "connection_revoked");
  assert.equal(env.fake.calls.length, callsBefore, "no network call once revoked");

  // Reconnect restores it.
  await env.service.completeAuthorization({ code: env.fake.issueCode(env.externalShopId), externalShopId: env.externalShopId });
  assert.equal((await connectionRow(env.shopId)).connection_status, "connected");
});

test("16b. refresh token rejected (not a revocation) → expired, needs reconnect", async () => {
  const env = await connect();
  env.fake.shops.get(env.externalShopId)!.refreshTokens.clear();
  await expireSoon(env.shopId, 1);
  await assert.rejects(env.service.getValidAccessToken(env.shopId));
  assert.equal((await connectionRow(env.shopId)).connection_status, "expired");
});

test("17. temporary network / 5xx failure on refresh does NOT change status; next call recovers", async () => {
  const env = await connect();
  await expireSoon(env.shopId, 1);
  env.fake.failNext("/api/v2/auth/access_token/get", { kind: "network" });
  await assert.rejects(env.service.getValidAccessToken(env.shopId), (err: unknown) => err instanceof ShopeeApiError && err.category === "transient");
  let row = await connectionRow(env.shopId);
  assert.equal(row.connection_status, "connected", "not revoked/expired");
  assert.equal(row.last_error_code, "network_error");
  assert.equal(row.refresh_lock_id, null, "lease released after failure");

  env.fake.failNext("/api/v2/auth/access_token/get", { kind: "http5xx" });
  await assert.rejects(env.service.getValidAccessToken(env.shopId));
  assert.equal((await connectionRow(env.shopId)).connection_status, "connected");

  await env.service.getValidAccessToken(env.shopId);
  row = await connectionRow(env.shopId);
  assert.equal(row.connection_status, "connected");
  assert.equal(row.last_error_code, null, "success clears the error");
});

// ------------------------------------------------------------- test call

test("18. testConnection success: get_shop_info ok, last_successful_api_call_at set, no token in result", async () => {
  const env = await connect();
  await db.from("shop_connections").update({ last_successful_api_call_at: null }).eq("shop_id", env.shopId);
  const result = await env.service.testConnection(env.shopId);
  assert.equal(result.ok, true);
  assert.equal(result.shopName, "HOMIES Test Shop");
  assert.match(result.requestId ?? "", /^req-/);
  assert.ok(typeof result.latencyMs === "number");
  const token = await env.service.getValidAccessToken(env.shopId);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok((await connectionRow(env.shopId)).last_successful_api_call_at);
});

test("19. testConnection API error normalized; auth error forces a refresh on the next call", async () => {
  const env = await connect();
  env.fake.invalidateAccessTokens(env.externalShopId); // Shopee no longer accepts our access token
  const failed = await env.service.testConnection(env.shopId);
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, "invalid_access_token");
  assert.equal(failed.error?.category, "auth");
  assert.match(failed.requestId ?? "", /^req-/);
  const row = await connectionRow(env.shopId);
  assert.equal(row.connection_status, "error");
  assert.ok(new Date(row.access_token_expires_at!).getTime() <= Date.now() + 1000, "token marked stale");

  const retried = await env.service.testConnection(env.shopId);
  assert.equal(retried.ok, true, "refreshed then succeeded");
  assert.equal(env.fake.count("/api/v2/auth/access_token/get"), 1);
  assert.equal((await connectionRow(env.shopId)).connection_status, "connected");
});

test("health: token status valid / expiring_soon / expired / missing; never exposes tokens", async () => {
  const env = await connect();
  let health = await getShopeeConnectionHealth(db, env.shopId);
  assert.equal(health.connectionStatus, "connected");
  assert.equal(health.tokenStatus, "valid");
  await expireSoon(env.shopId, 20);
  assert.equal((await getShopeeConnectionHealth(db, env.shopId)).tokenStatus, "expiring_soon");
  await expireSoon(env.shopId, -1);
  health = await getShopeeConnectionHealth(db, env.shopId);
  assert.equal(health.tokenStatus, "expired");
  const token = env.fake.shops.get(env.externalShopId)!.accessTokens.keys().next().value!;
  assert.ok(!JSON.stringify(health).includes(token));
  assert.ok(!JSON.stringify(health).includes("v1."), "no ciphertext either");

  const missing = await getShopeeConnectionHealth(db, "00000000-0000-0000-0000-000000000000");
  assert.deepEqual([missing.connectionStatus, missing.tokenStatus], ["disconnected", "missing"]);
});
