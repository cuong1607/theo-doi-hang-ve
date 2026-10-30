// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1: Product Analyst provider selection.
//
// Phase 1 ships ONLY the disabled provider: a controlled placeholder, no
// model call, no network. AI_PRODUCT_ANALYST_ENABLED / _PROVIDER / _MODEL
// are read so the configuration surface exists, but even "enabled" cannot
// reach a model yet — ClaudeProductAnalystProvider is a later phase.
// ============================================================
import type { ProductAnalystProvider, ProductAnalystResponse } from "./contracts.ts";

export const PRODUCT_ANALYST_PLACEHOLDER = "Hệ thống phân tích sản phẩm đang được chuẩn bị.";

export interface ProductAnalystConfig {
  enabled: boolean;
  provider: string | null;
  model: string | null;
}

export function getProductAnalystConfig(env: Record<string, string | undefined> = process.env): ProductAnalystConfig {
  return {
    enabled: ["true", "1", "on", "yes"].includes((env.AI_PRODUCT_ANALYST_ENABLED ?? "").trim().toLowerCase()),
    provider: env.AI_PRODUCT_ANALYST_PROVIDER?.trim() || null,
    model: env.AI_PRODUCT_ANALYST_MODEL?.trim() || null,
  };
}

export class DisabledProductAnalystProvider implements ProductAnalystProvider {
  readonly name = "disabled";
  // the request is ignored on purpose: nothing is analysed in this phase
  async analyze(): Promise<ProductAnalystResponse> {
    return { kind: "placeholder", text: PRODUCT_ANALYST_PLACEHOLDER };
  }
}

/** Always the disabled provider in this phase (a real provider is a separately reviewed phase). */
export function getProductAnalystProvider(config: ProductAnalystConfig = getProductAnalystConfig()): ProductAnalystProvider {
  if (config.enabled) {
    console.warn(JSON.stringify({ source: "product-analyst", event: "enabled_but_not_implemented", provider: config.provider }));
  }
  return new DisabledProductAnalystProvider();
}
