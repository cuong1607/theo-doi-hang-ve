// ============================================================
// PHASE SHOPEE-2: which Shopee data source the app uses.
//
//   SHOPEE_PROVIDER_MODE = live | fixture
//   default: production → live, anything else → fixture
//
// Fixture mode is only ALLOWED outside production, or when the operator
// explicitly sets ENABLE_SHOPEE_FIXTURE_MODE=true. There is no automatic
// live→fixture fallback anywhere: an unavailable live API is reported as
// such ("Chưa kết nối API Shopee"), never papered over with fixture data.
// ============================================================
import type { ProviderMode } from "./product-provider.ts";

type Env = Record<string, string | undefined>;

export interface ProviderModeConfig {
  mode: ProviderMode;
  /** Whether fixture tooling (fixture shop, fixture sync) may be used at all. */
  fixtureAllowed: boolean;
  /** Set when the configuration is contradictory (e.g. fixture in production without opt-in). */
  problem: string | null;
}

export function getShopeeProviderMode(env: Env = process.env): ProviderModeConfig {
  const isProduction = env.NODE_ENV === "production";
  const fixtureAllowed = !isProduction || env.ENABLE_SHOPEE_FIXTURE_MODE === "true";
  const raw = env.SHOPEE_PROVIDER_MODE?.trim().toLowerCase();

  if (raw && raw !== "live" && raw !== "fixture") {
    return { mode: "live", fixtureAllowed, problem: `SHOPEE_PROVIDER_MODE không hợp lệ: "${raw}" (chỉ nhận live | fixture).` };
  }
  const mode: ProviderMode = raw === "live" || raw === "fixture" ? raw : isProduction ? "live" : "fixture";
  if (mode === "fixture" && !fixtureAllowed) {
    return {
      mode: "live",
      fixtureAllowed,
      problem: "Fixture mode bị chặn trên production (cần ENABLE_SHOPEE_FIXTURE_MODE=true nếu thật sự muốn).",
    };
  }
  return { mode, fixtureAllowed, problem: null };
}
