// ============================================================
// SHOPEE-ADS-UI-1: where the Ads dashboard gets its view model.
//
// The page only knows AdsDashboardSource. Today: FixtureAdsDashboardSource
// (no network, no DB). SHOPEE-ADS-1 adds a DB-backed source that reads the
// synced canonical Ads tables and returns the SAME AdsDashboardData — the
// UI does not change.
// ============================================================

import type { AdsDemoScenario } from "./filters.ts";
import { buildFixtureDashboard } from "./fixtures.ts";
import type { AdsDashboardData, AdsFilters } from "./view-models.ts";

export interface AdsDashboardSource {
  readonly kind: "fixture" | "shopee";
  load(filters: AdsFilters): Promise<AdsDashboardData>;
}

/** Friendly, provider-agnostic failure — the UI never shows the raw cause. */
export class AdsDataUnavailableError extends Error {
  readonly code = "ads_data_unavailable";
  constructor(cause?: unknown) {
    super("Không tải được dữ liệu quảng cáo.", { cause });
    this.name = "AdsDataUnavailableError";
  }
}

export class FixtureAdsDashboardSource implements AdsDashboardSource {
  readonly kind = "fixture" as const;
  private readonly scenario: AdsDemoScenario | null;
  private readonly now: () => Date;

  constructor(opts: { scenario?: AdsDemoScenario | null; now?: () => Date } = {}) {
    this.scenario = opts.scenario ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  async load(filters: AdsFilters): Promise<AdsDashboardData> {
    if (this.scenario === "slow") await new Promise((r) => setTimeout(r, 1500));
    if (this.scenario === "error") throw new AdsDataUnavailableError(new Error("fixture: simulated failure"));
    const scenario = this.scenario === "empty" || this.scenario === "unsynced" || this.scenario === "large" ? this.scenario : null;
    return buildFixtureDashboard(filters, { now: this.now(), scenario });
  }
}
