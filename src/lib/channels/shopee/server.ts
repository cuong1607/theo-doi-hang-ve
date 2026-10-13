// ============================================================
// PHASE SHOPEE-1: server wiring for the Shopee module (env config +
// service-role DB + real fetch). The ONLY entry point routes/pages use.
//
// Callers must authorize first (src/lib/auth/session.ts, channel:manage) —
// the service-role client bypasses RLS.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { ShopeeClient } from "./client.ts";
import { getShopeeConfig, type ShopeeConfig } from "./config.ts";
import { ShopeeConnectionService } from "./token.ts";

import { FixtureShopeeProductProvider, loadProductFixtures, RealShopeeProductProvider, type ShopeeProductProvider } from "./product-provider.ts";
import { ShopeeProductSyncService } from "./product-sync.ts";
import { getShopeeProviderMode } from "./provider-mode.ts";

let cached: { config: ShopeeConfig; client: ShopeeClient; service: ShopeeConnectionService } | null = null;

/**
 * Product sync wired to the configured data source (SHOPEE_PROVIDER_MODE).
 * Live mode needs complete Shopee config (throws ShopeeConfigError
 * otherwise) — it NEVER falls back to fixtures.
 */
export function getShopeeProductSync(): { mode: "live" | "fixture"; sync: ShopeeProductSyncService } {
  const { mode, problem } = getShopeeProviderMode();
  if (problem) throw new Error(problem);
  let provider: ShopeeProductProvider;
  if (mode === "fixture") {
    provider = new FixtureShopeeProductProvider(loadProductFixtures());
  } else {
    const { client, service } = getShopee();
    provider = new RealShopeeProductProvider({ client, connections: service });
  }
  return { mode, sync: new ShopeeProductSyncService({ db: createAdminClient(), provider }) };
}

/**
 * One instance per server process so the in-process refresh de-dup and the
 * concurrency cap are shared by every request. Throws ShopeeConfigError
 * (naming variables, never values) when env is incomplete.
 */
export function getShopee() {
  if (cached) return cached;
  const config = getShopeeConfig();
  const client = new ShopeeClient({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    apiBaseUrl: config.apiBaseUrl,
  });
  const service = new ShopeeConnectionService({ db: createAdminClient(), client, encryptionKey: config.encryptionKey });
  cached = { config, client, service };
  return cached;
}
