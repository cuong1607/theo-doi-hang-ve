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

let cached: { config: ShopeeConfig; client: ShopeeClient; service: ShopeeConnectionService } | null = null;

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
