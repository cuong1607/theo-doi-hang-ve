// ============================================================
// SHOPEE-ADS-1A: server transport for the READ-ONLY Ads probe.
//
// Runs inside the app (where the production partner credentials live) for
// ONE explicitly chosen, connected live shop. Uses the established token
// flow (ShopeeConnectionService.getValidAccessToken — refreshes the way the
// app always does; no second token system) and the production signing code
// (ShopeeClient.signedUrl). Writes NOTHING to the Ads domain (there are no
// Ads tables); the report is returned to the admin who triggered it.
//
// Logs: metadata only (shop id, endpoint label, method, status, latency,
// provider error code, request id, record count). Never the URL (it carries
// the token + signature), never a body, never a token / key.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { getShopee } from "../server.ts";
import { ShopeeApiError } from "../errors.ts";
import { runAdsProbe, type AdsProbeReport, type AdsProbeTransport } from "./probe.ts";
import { assertAdsReadOnlyRequest } from "./read-only-policy.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const running = new Set<string>();

export class AdsProbeInputError extends Error {}

export interface AdsProbeShopOption {
  id: string;
  shopName: string;
  externalShopId: string;
  connectionStatus: string | null;
  timezone: string;
}

/** Connected live Shopee shops an admin may probe (internal ids only). */
export async function listAdsProbeShops(): Promise<AdsProbeShopOption[]> {
  const { data, error } = await createAdminClient()
    .from("shops")
    .select("id, shop_name, external_shop_id, timezone, shop_connections(connection_status)")
    .eq("channel", "shopee")
    .eq("data_source", "live")
    .eq("is_active", true)
    .order("shop_name");
  if (error) throw new Error("Không tải được danh sách shop.");
  return (data ?? []).map((s) => ({
    id: s.id as string,
    shopName: s.shop_name as string,
    externalShopId: s.external_shop_id as string,
    connectionStatus: (s.shop_connections as unknown as Array<{ connection_status: string }> | null)?.[0]?.connection_status ?? null,
    timezone: (s.timezone as string | null) || "Asia/Ho_Chi_Minh",
  }));
}

export function adsProbeEnvironment(apiBaseUrl: string): "production" | "sandbox" {
  return /sandbox|test-stable/i.test(apiBaseUrl) ? "sandbox" : "production";
}

export async function runAdsProbeForShop(shopId: string): Promise<AdsProbeReport> {
  const shops = await listAdsProbeShops();
  const shop = shops.find((s) => s.id === shopId);
  // Only a validated internal shop record — never a provider shop id from the caller.
  if (!shop) throw new AdsProbeInputError("Shop không hợp lệ (cần shop Shopee live đang hoạt động).");
  if (shop.connectionStatus !== "connected") throw new AdsProbeInputError(`Shop chưa kết nối (trạng thái: ${shop.connectionStatus ?? "không có"}).`);
  if (running.has(shopId)) throw new AdsProbeInputError("Đang có một lượt probe cho shop này.");

  const { config, client, service } = getShopee();
  const environment = adsProbeEnvironment(config.apiBaseUrl);
  const secrets = [config.partnerKey];

  const transport: AdsProbeTransport = async (req) => {
    assertAdsReadOnlyRequest(req.method, req.path); // defense in depth (the runner already checked the allowlist)
    let accessToken: string;
    try {
      accessToken = await service.getValidAccessToken(shop.id);
    } catch (err) {
      // auth category = expired / revoked / needs reconnect (ShopeeConnectionStateError included)
      const reauth = err instanceof ShopeeApiError && err.category === "auth";
      return {
        httpStatus: null,
        latencyMs: 0,
        text: "",
        transportError: {
          code: err instanceof ShopeeApiError ? err.errorCode : "token_unavailable",
          message: err instanceof ShopeeApiError ? err.message : "Không lấy được access token.",
          reauth,
        },
      };
    }
    secrets.push(accessToken);
    const url = client.signedUrl(req.path, req.params, { externalShopId: shop.externalShopId, accessToken });
    const started = Date.now();
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const raw = await res.text();
      const text = secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), raw);
      return { httpStatus: res.status, latencyMs: Date.now() - started, text };
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return { httpStatus: null, latencyMs: Date.now() - started, text: "", transportError: { code: timeout ? "timeout" : "network_error", message: timeout ? "Shopee không phản hồi kịp." : "Không kết nối được tới Shopee." } };
    }
  };

  running.add(shopId);
  try {
    console.info(JSON.stringify({ source: "shopee-ads-probe", event: "probe_started", environment, mode: "READ_ONLY", shopId }));
    const report = await runAdsProbe({
      environment,
      confirmProduction: true, // the server action requires the admin's explicit confirmation before calling this
      shopLabel: shop.shopName,
      transport,
      timeZone: shop.timezone,
      onCall: (c) =>
        console.info(
          JSON.stringify({
            source: "shopee-ads-probe",
            event: "probe_call",
            shopId,
            endpoint: c.endpoint,
            method: c.method,
            status: c.httpStatus,
            latencyMs: c.latencyMs,
            classification: c.classification,
            errorCode: c.errorCode,
            requestId: c.requestId,
            records: c.arrayLengths,
          }),
        ),
    });
    console.info(JSON.stringify({ source: "shopee-ads-probe", event: "probe_finished", shopId, requests: report.requestsUsed, stoppedReason: report.stoppedReason, adsAccess: report.adsAccess }));
    return report;
  } finally {
    running.delete(shopId);
  }
}
