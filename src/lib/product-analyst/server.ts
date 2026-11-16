// ============================================================
// PRODUCT-ANALYTICS-4: server wiring of the Product Analyst.
// A channel gets the real orchestrator only when the master switch AND that
// channel's flag are on; otherwise the disabled analyst (placeholder, no model).
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { SupabaseAnalystStore } from "./analyst-store.ts";
import { ClaudeProductAnalystProvider } from "./claude-provider.ts";
import { getProductAnalystConfig, type ProductAnalystConfig } from "./config.ts";
import type { ProductAnalyst } from "./contracts.ts";
import { FakeProductAnalystProvider } from "./fake-provider.ts";
import { ProductAnalystOrchestrator } from "./orchestrator.ts";
import { DisabledProductAnalyst, type ProductAnalystProvider } from "./provider.ts";

export function createProductAnalystProvider(config: ProductAnalystConfig): ProductAnalystProvider {
  return config.provider === "fake" ? new FakeProductAnalystProvider() : new ClaudeProductAnalystProvider({ model: config.model, effort: config.effort, fallbacks: config.fallbacks });
}

export function getProductAnalyst(channel: "zalo" | "web", config: ProductAnalystConfig = getProductAnalystConfig()): ProductAnalyst {
  const channelOn = channel === "zalo" ? config.zaloEnabled : config.webEnabled;
  if (!config.enabled || !channelOn) return new DisabledProductAnalyst();
  const db = createAdminClient();
  return new ProductAnalystOrchestrator({ db, store: new SupabaseAnalystStore(db), provider: createProductAnalystProvider(config), config });
}
