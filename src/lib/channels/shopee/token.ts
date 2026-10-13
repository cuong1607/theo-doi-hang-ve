// ============================================================
// PHASE SHOPEE-1: Shopee connection + token lifecycle.
//
// Owns shop_connections for provider 'shopee': completing authorization,
// encrypted token storage, getValidAccessToken() with refresh, connection
// status transitions, health, and the test call.
//
// Tokens: encrypted with APP_ENCRYPTION_KEY (src/lib/security/secrets.ts),
// AAD-bound to "shop_connections:<shop uuid>:<column>". Plaintext tokens
// exist only in memory, never in the DB, logs, or any return value except
// getValidAccessToken() (server-side callers that are about to call Shopee).
//
// Refresh concurrency (Shopee rotates the refresh token on every refresh):
//   1. in-process: concurrent callers in one instance share one promise;
//   2. cross-instance: DB lease via claim_shop_token_refresh (migration
//      00039, DB clock). Losers poll until the winner has stored a fresh
//      token, then re-read it — they never refresh themselves;
//   3. after a failed refresh we re-read the row: if the stored refresh
//      token changed meanwhile, someone else rotated it — use theirs and
//      do NOT mark the connection revoked.
//
// Status rules:
//   connected / error  → refresh may be attempted automatically
//   expired / revoked  → refresh token rejected: admin must reconnect
//   disconnected       → never connected
//   Transient failures (network, 5xx, rate limit) never change status;
//   they only record last_error_*.
//
// Dependencies are injected (db, client, clock) — no "server-only" marker
// so integration tests can drive it against a real database; the app wires
// it in ./server.ts.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, encryptSecret, SecretDecryptError } from "../../security/secrets.ts";
import type { ConnectionStatus } from "../core/types.ts";
import { exchangeAuthorizationCode, refreshShopAccessToken, type ShopeeTokenSet } from "./auth.ts";
import { consoleShopeeLogger, type ShopeeClient, type ShopeeLogger } from "./client.ts";
import {
  REFRESH_LEASE_SECONDS,
  REFRESH_WAIT_MAX_MS,
  REFRESH_WAIT_POLL_MS,
  SHOPEE_PATHS,
  TOKEN_EXPIRING_SOON_SECONDS,
  TOKEN_REFRESH_BUFFER_SECONDS,
} from "./constants.ts";
import { looksRevoked, ShopeeApiError } from "./errors.ts";
import type { ShopeeShopInfoResponse } from "./types.ts";

const PROVIDER = "shopee";

export type TokenStatus = "valid" | "expiring_soon" | "expired" | "missing";

export interface ShopeeConnectionHealth {
  shopId: string;
  connectionStatus: ConnectionStatus;
  tokenStatus: TokenStatus;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastSuccessfulApiCallAt: string | null;
  lastError: { code: string | null; message: string | null; at: string | null } | null;
}

export interface TestConnectionResult {
  ok: boolean;
  shopId: string;
  requestId?: string | null;
  latencyMs?: number;
  shopName?: string | null;
  error?: { code: string; message: string; category: string };
}

export interface ShopeeConnectionServiceDeps {
  db: SupabaseClient;
  client: ShopeeClient;
  encryptionKey: Buffer;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger?: ShopeeLogger;
}

type ConnectionRow = {
  id: string;
  shop_id: string;
  connection_status: ConnectionStatus;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  last_token_refresh_at: string | null;
  last_successful_api_call_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  shops: { external_shop_id: string; channel: string } | null;
};

const CONNECTION_SELECT =
  "id, shop_id, connection_status, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, " +
  "last_token_refresh_at, last_successful_api_call_at, last_error_at, last_error_code, last_error_message, " +
  "shops!inner(external_shop_id, channel)";

/** Thrown when the stored state requires an admin action (no network call was made). */
export class ShopeeConnectionStateError extends ShopeeApiError {}

export function tokenContext(shopId: string, column: "access_token" | "refresh_token"): string {
  return `shop_connections:${shopId}:${column}`;
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function loadShopeeConnection(db: SupabaseClient, shopId: string): Promise<ConnectionRow | null> {
  const { data, error } = await db
    .from("shop_connections")
    .select(CONNECTION_SELECT)
    .eq("shop_id", shopId)
    .eq("provider", PROVIDER)
    .maybeSingle<ConnectionRow>();
  if (error) throw new Error(`Không đọc được kết nối Shopee: ${error.message}`);
  return data;
}

/**
 * Canonical connection health for UI/monitoring — never returns token
 * values and needs no Shopee credentials (works before env is configured).
 */
export async function getShopeeConnectionHealth(
  db: SupabaseClient,
  shopId: string,
  now: Date = new Date(),
): Promise<ShopeeConnectionHealth> {
  const row = await loadShopeeConnection(db, shopId);
  if (!row) {
    return {
      shopId,
      connectionStatus: "disconnected",
      tokenStatus: "missing",
      expiresAt: null,
      lastRefreshAt: null,
      lastSuccessfulApiCallAt: null,
      lastError: null,
    };
  }
  let tokenStatus: TokenStatus = "missing";
  if (row.access_token_encrypted && row.access_token_expires_at) {
    const msLeft = new Date(row.access_token_expires_at).getTime() - now.getTime();
    tokenStatus = msLeft <= 0 ? "expired" : msLeft <= TOKEN_EXPIRING_SOON_SECONDS * 1000 ? "expiring_soon" : "valid";
  }
  return {
    shopId,
    connectionStatus: row.connection_status,
    tokenStatus,
    expiresAt: row.access_token_expires_at,
    lastRefreshAt: row.last_token_refresh_at,
    lastSuccessfulApiCallAt: row.last_successful_api_call_at,
    lastError:
      row.last_error_code || row.last_error_message
        ? { code: row.last_error_code, message: row.last_error_message, at: row.last_error_at }
        : null,
  };
}

export class ShopeeConnectionService {
  private readonly db: SupabaseClient;
  private readonly client: ShopeeClient;
  private readonly key: Buffer;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: ShopeeLogger;
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(deps: ShopeeConnectionServiceDeps) {
    this.db = deps.db;
    this.client = deps.client;
    this.key = deps.encryptionKey;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.logger ?? consoleShopeeLogger;
  }

  // ---------------------------------------------------------------- auth

  /**
   * Callback step: exchange the code, identify the shop (external id comes
   * from Shopee's redirect and is proven by a successful exchange), upsert
   * shops + shop_connections. Throws ShopeeApiError on exchange failure
   * after recording the error on an existing shop's connection.
   */
  async completeAuthorization(params: { code: string; externalShopId: string }): Promise<{
    shopId: string;
    externalShopId: string;
    shopName: string;
    reconnected: boolean;
  }> {
    const { externalShopId } = params;
    let tokens: ShopeeTokenSet;
    try {
      tokens = await exchangeAuthorizationCode(this.client, params);
    } catch (err) {
      const error = this.asApiError(err, SHOPEE_PATHS.tokenGet);
      await this.recordExchangeFailure(externalShopId, error);
      throw error;
    }

    // Best-effort shop profile for a readable name; the connection is valid without it.
    let info: ShopeeShopInfoResponse | null = null;
    try {
      ({ data: info } = await this.client.request<ShopeeShopInfoResponse>({
        path: SHOPEE_PATHS.shopInfo,
        method: "GET",
        shop: { externalShopId, accessToken: tokens.accessToken },
      }));
    } catch {
      info = null;
    }

    const existingShop = await this.findShopByExternalId(externalShopId);
    const shopName = info?.shop_name?.trim() || existingShop?.shop_name || `Shopee shop ${externalShopId}`;
    const { data: shop, error: shopError } = await this.db
      .from("shops")
      .upsert(
        {
          channel: PROVIDER,
          external_shop_id: externalShopId,
          shop_name: shopName,
          region: info?.region ?? existingShop?.region ?? null,
          is_active: true,
        },
        { onConflict: "channel,external_shop_id" },
      )
      .select("id")
      .single();
    if (shopError || !shop) throw new Error(`Không lưu được shop: ${shopError?.message ?? "unknown"}`);

    const { data: existingConnection } = await this.db
      .from("shop_connections")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("provider", PROVIDER)
      .maybeSingle();

    const nowIso = this.now().toISOString();
    const { error: connError } = await this.db.from("shop_connections").upsert(
      {
        shop_id: shop.id,
        provider: PROVIDER,
        connection_status: "connected",
        ...this.encryptedTokenColumns(shop.id, tokens),
        last_successful_api_call_at: info ? nowIso : null,
        last_error_at: null,
        last_error_code: null,
        last_error_message: null,
        refresh_lock_id: null,
        refresh_lock_until: null,
      },
      { onConflict: "shop_id,provider" },
    );
    if (connError) throw new Error(`Không lưu được kết nối Shopee: ${connError.message}`);

    const reconnected = Boolean(existingConnection);
    this.log({
      event: reconnected ? "SHOPEE_RECONNECTED" : "SHOPEE_CONNECTED",
      ok: true,
      shopId: shop.id,
      externalShopId,
      requestId: tokens.requestId,
    });
    return { shopId: shop.id, externalShopId, shopName, reconnected };
  }

  // --------------------------------------------------------------- tokens

  /** The one entry point every shop-level Shopee call uses to get a token. */
  async getValidAccessToken(shopId: string): Promise<string> {
    const row = await this.loadConnection(shopId);
    this.assertUsable(row);
    const accessToken = this.decryptOrFail(row, "access_token");
    if (this.isFresh(row.access_token_expires_at)) return accessToken;

    const pending = this.inFlight.get(shopId);
    if (pending) return pending;
    const refresh = this.refreshWithLease(shopId).finally(() => this.inFlight.delete(shopId));
    this.inFlight.set(shopId, refresh);
    return refresh;
  }

  private async refreshWithLease(shopId: string): Promise<string> {
    let lockId = await this.claimLease(shopId);
    if (!lockId) {
      const fresh = await this.waitForOtherRefresh(shopId);
      if (fresh) return fresh;
      lockId = await this.claimLease(shopId);
      if (!lockId) {
        throw new ShopeeApiError({
          apiPath: SHOPEE_PATHS.accessTokenGet,
          errorCode: "refresh_in_progress",
          message: "Một tiến trình khác đang làm mới token Shopee, vui lòng thử lại.",
          category: "transient",
        });
      }
    }

    try {
      // Re-read under the lease: another instance may have refreshed just before we claimed it.
      const row = await this.loadConnection(shopId);
      this.assertUsable(row);
      if (this.isFresh(row.access_token_expires_at)) return this.decryptOrFail(row, "access_token");

      const refreshToken = this.decryptOrFail(row, "refresh_token");
      const externalShopId = row.shops!.external_shop_id;
      let tokens: ShopeeTokenSet;
      try {
        tokens = await refreshShopAccessToken(this.client, { refreshToken, externalShopId, logShopId: shopId });
      } catch (err) {
        return await this.handleRefreshFailure(row, this.asApiError(err, SHOPEE_PATHS.accessTokenGet));
      }

      const nowIso = this.now().toISOString();
      const { error } = await this.db
        .from("shop_connections")
        .update({
          ...this.encryptedTokenColumns(shopId, tokens),
          connection_status: "connected",
          last_token_refresh_at: nowIso,
          last_error_at: null,
          last_error_code: null,
          last_error_message: null,
        })
        .eq("id", row.id);
      if (error) throw new Error(`Không lưu được token Shopee mới: ${error.message}`);

      this.log({ event: "SHOPEE_TOKEN_REFRESHED", ok: true, shopId, externalShopId, requestId: tokens.requestId });
      return tokens.accessToken;
    } finally {
      await this.db
        .from("shop_connections")
        .update({ refresh_lock_id: null, refresh_lock_until: null })
        .eq("refresh_lock_id", lockId);
    }
  }

  private async handleRefreshFailure(usedRow: ConnectionRow, error: ShopeeApiError): Promise<string> {
    // Did someone else rotate the token while our refresh was in flight?
    const current = await this.loadConnection(usedRow.shop_id);
    if (
      current?.refresh_token_encrypted &&
      current.refresh_token_encrypted !== usedRow.refresh_token_encrypted &&
      this.isFresh(current.access_token_expires_at)
    ) {
      return this.decryptOrFail(current, "access_token");
    }

    let status: ConnectionStatus | null = null;
    if (error.category === "auth") status = looksRevoked(error) ? "revoked" : "expired";
    else if (error.category === "signature" || error.category === "invalid_request") status = "error";
    // transient / rate_limit / invalid_response / unknown: keep status, record the error only.

    await this.recordError(usedRow.shop_id, error, status);
    this.log({
      event: status === "revoked" ? "SHOPEE_REVOKED" : "SHOPEE_CONNECTION_ERROR",
      ok: false,
      shopId: usedRow.shop_id,
      apiPath: error.apiPath,
      errorCode: error.errorCode,
      category: error.category,
      requestId: error.requestId,
    });
    throw error;
  }

  private async claimLease(shopId: string): Promise<string | null> {
    const { data, error } = await this.db.rpc("claim_shop_token_refresh", {
      p_shop_id: shopId,
      p_provider: PROVIDER,
      p_lease_seconds: REFRESH_LEASE_SECONDS,
    });
    if (error) throw new Error(`Không lấy được khóa làm mới token: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  private async waitForOtherRefresh(shopId: string): Promise<string | null> {
    const deadline = Date.now() + REFRESH_WAIT_MAX_MS;
    while (Date.now() < deadline) {
      await this.sleep(REFRESH_WAIT_POLL_MS);
      const row = await this.loadConnection(shopId);
      this.assertUsable(row);
      if (this.isFresh(row.access_token_expires_at)) return this.decryptOrFail(row, "access_token");
    }
    return null;
  }

  // ------------------------------------------------------- status/health

  async recordApiSuccess(shopId: string): Promise<void> {
    await this.db
      .from("shop_connections")
      .update({ last_successful_api_call_at: this.now().toISOString() })
      .eq("shop_id", shopId)
      .eq("provider", PROVIDER);
  }

  /** A shop-level call failed. Auth errors force the next call to refresh first. */
  async recordApiFailure(shopId: string, error: ShopeeApiError): Promise<void> {
    if (error instanceof ShopeeConnectionStateError) return; // state already recorded
    if (error.category === "auth") {
      await this.recordError(shopId, error, "error", { access_token_expires_at: this.now().toISOString() });
    } else {
      await this.recordError(shopId, error, error.category === "signature" ? "error" : null);
    }
  }

  getHealth(shopId: string): Promise<ShopeeConnectionHealth> {
    return getShopeeConnectionHealth(this.db, shopId, this.now());
  }

  /** SHOPEE-1 test call: GET /api/v2/shop/get_shop_info (read-only, no snapshot stored). */
  async testConnection(shopId: string): Promise<TestConnectionResult> {
    const started = Date.now();
    try {
      const accessToken = await this.getValidAccessToken(shopId);
      const row = await this.loadConnection(shopId);
      const { data, requestId, latencyMs } = await this.client.request<ShopeeShopInfoResponse>({
        path: SHOPEE_PATHS.shopInfo,
        method: "GET",
        shop: { externalShopId: row!.shops!.external_shop_id, accessToken },
        logShopId: shopId,
      });
      await this.recordApiSuccess(shopId);
      return { ok: true, shopId, requestId, latencyMs, shopName: data.shop_name ?? null };
    } catch (err) {
      const error = this.asApiError(err, SHOPEE_PATHS.shopInfo);
      await this.recordApiFailure(shopId, error);
      return {
        ok: false,
        shopId,
        requestId: error.requestId,
        latencyMs: Date.now() - started,
        error: { code: error.errorCode, message: error.message, category: error.category },
      };
    }
  }

  // ------------------------------------------------------------ helpers

  private encryptedTokenColumns(shopId: string, tokens: ShopeeTokenSet) {
    return {
      access_token_encrypted: encryptSecret(tokens.accessToken, this.key, tokenContext(shopId, "access_token")),
      refresh_token_encrypted: encryptSecret(tokens.refreshToken, this.key, tokenContext(shopId, "refresh_token")),
      access_token_expires_at: new Date(this.now().getTime() + tokens.expiresInSeconds * 1000).toISOString(),
    };
  }

  private isFresh(expiresAt: string | null): boolean {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() - this.now().getTime() > TOKEN_REFRESH_BUFFER_SECONDS * 1000;
  }

  private loadConnection(shopId: string): Promise<ConnectionRow | null> {
    return loadShopeeConnection(this.db, shopId);
  }

  private assertUsable(row: ConnectionRow | null): asserts row is ConnectionRow {
    const fail = (errorCode: string, message: string): never => {
      throw new ShopeeConnectionStateError({ apiPath: SHOPEE_PATHS.accessTokenGet, errorCode, message, category: "auth" });
    };
    if (!row || row.connection_status === "disconnected" || !row.access_token_encrypted) {
      return fail("not_connected", "Shop chưa được kết nối Shopee.");
    }
    if (row.shops?.channel !== PROVIDER) return fail("not_connected", "Shop không thuộc kênh Shopee.");
    if (row.connection_status === "revoked" || row.connection_status === "expired") {
      return fail(`connection_${row.connection_status}`, "Quyền truy cập Shopee đã hết hiệu lực — admin cần kết nối lại shop.");
    }
  }

  private decryptOrFail(row: ConnectionRow, column: "access_token" | "refresh_token"): string {
    const stored = column === "access_token" ? row.access_token_encrypted : row.refresh_token_encrypted;
    try {
      if (!stored) throw new SecretDecryptError("missing");
      return decryptSecret(stored, this.key, tokenContext(row.shop_id, column));
    } catch {
      const error = new ShopeeConnectionStateError({
        apiPath: SHOPEE_PATHS.accessTokenGet,
        errorCode: "decrypt_failed",
        message: "Không giải mã được token Shopee đã lưu (APP_ENCRYPTION_KEY đã đổi?) — admin cần kết nối lại shop.",
        category: "auth",
      });
      void this.recordError(row.shop_id, error, "error");
      throw error;
    }
  }

  private async recordError(
    shopId: string,
    error: ShopeeApiError,
    status: ConnectionStatus | null,
    extra: Record<string, string> = {},
  ): Promise<void> {
    const reference = error.requestId ? ` (request_id: ${error.requestId})` : "";
    await this.db
      .from("shop_connections")
      .update({
        ...(status ? { connection_status: status } : {}),
        ...extra,
        last_error_at: this.now().toISOString(),
        last_error_code: truncate(error.errorCode, 100),
        last_error_message: truncate(`${error.message}${reference}`),
      })
      .eq("shop_id", shopId)
      .eq("provider", PROVIDER);
  }

  private async recordExchangeFailure(externalShopId: string, error: ShopeeApiError): Promise<void> {
    const shop = await this.findShopByExternalId(externalShopId);
    if (shop) {
      const { data } = await this.db
        .from("shop_connections")
        .select("id")
        .eq("shop_id", shop.id)
        .eq("provider", PROVIDER)
        .maybeSingle();
      if (data) await this.recordError(shop.id, error, "error");
      else {
        await this.db.from("shop_connections").insert({
          shop_id: shop.id,
          provider: PROVIDER,
          connection_status: "error",
          last_error_at: this.now().toISOString(),
          last_error_code: truncate(error.errorCode, 100),
          last_error_message: truncate(error.message),
        });
      }
    }
    this.log({
      event: "SHOPEE_CONNECTION_ERROR",
      ok: false,
      shopId: shop?.id,
      externalShopId,
      apiPath: error.apiPath,
      errorCode: error.errorCode,
      category: error.category,
      requestId: error.requestId,
    });
  }

  private async findShopByExternalId(externalShopId: string) {
    const { data } = await this.db
      .from("shops")
      .select("id, shop_name, region")
      .eq("channel", PROVIDER)
      .eq("external_shop_id", externalShopId)
      .maybeSingle<{ id: string; shop_name: string; region: string | null }>();
    return data;
  }

  private asApiError(err: unknown, apiPath: string): ShopeeApiError {
    if (err instanceof ShopeeApiError) return err;
    return new ShopeeApiError({ apiPath, errorCode: "unexpected_error", message: "Lỗi không xác định khi xử lý kết nối Shopee." });
  }
}
