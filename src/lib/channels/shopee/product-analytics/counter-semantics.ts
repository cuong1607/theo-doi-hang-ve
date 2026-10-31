// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1P: what do get_item_extra_info `sale` / `views`
// mean? Pure comparison of two (or more) probe snapshots of the SAME item ids.
//
// Evidence rules:
//   - a cumulative counter never decreases → any decrease rules it out;
//   - `sale` must grow by at least the units we KNOW were sold in between
//     (Ads direct_item_sold of a single-item campaign = a lower bound on the
//     item's real units; NOT total units);
//   - a lifetime counter can't be below the units already recorded in our
//     own orders for that item (historical facts stay true even though the
//     order sync is stopped; they are never used as CURRENT truth).
// One interval is weak evidence: the verdicts are LIKELY_*, never "verified",
// and `sale` is never called daily units sold.
// No I/O, no canonical table: the script turns cloud probe snapshots into a
// report / sanitized fixture.
// ============================================================
import type { ProductAnalyticsProbeResult } from "./discovery.ts";

export type SaleSemantics = "LIKELY_CUMULATIVE" | "LIKELY_ROLLING" | "LIKELY_OTHER" | "INSUFFICIENT_EVIDENCE";
export type ViewsBehaviour = "INCREASES" | "FLAT" | "DECREASES" | "RESETS" | "NOT_RETURNED";
export type ViewsSemantics = "MONOTONIC_SO_FAR" | "NON_MONOTONIC" | "INSUFFICIENT_EVIDENCE";
/** Capability state: structure and meaning are tracked separately, never collapsed. */
export type CounterCapability = "STRUCTURE_VERIFIED" | "SEMANTICS_VERIFIED" | "SEMANTICS_UNKNOWN";

export interface CounterSnapshot {
  itemId: string;
  capturedAt: string;
  returned: boolean;
  sale: number | null;
  views: number | null;
  likes: number | null;
  ratingStar: number | null;
  commentCount: number | null;
  /** Units of this item already in our orders (historical, any date) — 0 when unknown. */
  knownUnitsInDb: number;
}

export function snapshotsFromProbe(result: ProductAnalyticsProbeResult): CounterSnapshot[] {
  return result.comparisons.map((c) => ({
    itemId: c.itemId,
    capturedAt: result.ranAt,
    returned: c.returned,
    sale: c.provider?.sale ?? null,
    views: c.provider?.views ?? null,
    likes: c.provider?.likes ?? null,
    ratingStar: c.provider?.ratingStar ?? null,
    commentCount: c.provider?.commentCount ?? null,
    knownUnitsInDb: c.internal.unitsInDb,
  }));
}

export interface ItemIntervalContext {
  /** Provider listing status from the Ads enrichment (NORMAL / UNLIST / SELLER_DELETE / null). */
  providerStatus: string | null;
  /** Sum of Ads direct_item_sold (single-item campaigns) over the VN hours lying wholly inside [T0, T1]; null = no such campaign. */
  adsDirectUnitsLowerBound: number | null;
  adsHours: number;
}

export interface ItemCounterDelta {
  itemId: string;
  providerStatus: string | null;
  returnedT0: boolean;
  returnedT1: boolean;
  saleT0: number | null;
  saleT1: number | null;
  deltaSale: number | null;
  viewsT0: number | null;
  viewsT1: number | null;
  deltaViews: number | null;
  deltaLikes: number | null;
  deltaCommentCount: number | null;
  adsDirectUnitsLowerBound: number | null;
  /** sale below units we already recorded → cannot be a lifetime counter. */
  saleBelowKnownUnits: boolean;
  sale: SaleSemantics;
  views: ViewsBehaviour;
}

const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);

export function classifyItemSale(d: Pick<ItemCounterDelta, "deltaSale" | "adsDirectUnitsLowerBound" | "saleBelowKnownUnits">): SaleSemantics {
  if (d.deltaSale === null) return "INSUFFICIENT_EVIDENCE";
  if (d.deltaSale < 0) return "LIKELY_ROLLING";
  const lb = d.adsDirectUnitsLowerBound;
  // grew less than units we know were sold: not a live cumulative counter (rolling window, lag or another definition)
  if (lb !== null && d.deltaSale < lb) return "LIKELY_OTHER";
  if (d.saleBelowKnownUnits) return "LIKELY_ROLLING";
  if (lb !== null && lb > 0) return "LIKELY_CUMULATIVE";
  // no known sale in the interval: a flat or growing value fits every hypothesis
  return "INSUFFICIENT_EVIDENCE";
}

export function classifyItemViews(t0: number | null, t1: number | null): ViewsBehaviour {
  if (t0 === null || t1 === null) return "NOT_RETURNED";
  if (t1 === t0) return "FLAT";
  if (t1 > t0) return "INCREASES";
  // a drop to (almost) nothing from a meaningful value looks like a reset, not a sliding window
  return t0 >= 100 && t1 <= t0 * 0.1 ? "RESETS" : "DECREASES";
}

export function compareCounterSnapshots(
  t0: readonly CounterSnapshot[],
  t1: readonly CounterSnapshot[],
  context: ReadonlyMap<string, ItemIntervalContext>,
): ItemCounterDelta[] {
  const later = new Map(t1.map((s) => [s.itemId, s]));
  return t0.map((a) => {
    const b = later.get(a.itemId);
    const ctx = context.get(a.itemId);
    const saleT1 = b?.sale ?? null;
    const known = Math.max(a.knownUnitsInDb, b?.knownUnitsInDb ?? 0);
    const base = {
      itemId: a.itemId,
      providerStatus: ctx?.providerStatus ?? null,
      returnedT0: a.returned,
      returnedT1: b?.returned ?? false,
      saleT0: a.sale,
      saleT1,
      deltaSale: delta(a.sale, saleT1),
      viewsT0: a.views,
      viewsT1: b?.views ?? null,
      deltaViews: delta(a.views, b?.views ?? null),
      deltaLikes: delta(a.likes, b?.likes ?? null),
      deltaCommentCount: delta(a.commentCount, b?.commentCount ?? null),
      adsDirectUnitsLowerBound: ctx?.adsDirectUnitsLowerBound ?? null,
      saleBelowKnownUnits: known > 0 && [a.sale, saleT1].some((v) => v !== null && v < known),
    };
    return { ...base, sale: classifyItemSale(base), views: classifyItemViews(base.viewsT0, base.viewsT1) };
  });
}

export interface CounterSemanticsVerdict {
  sale: { classification: SaleSemantics; confidence: "MEDIUM" | "LOW"; capability: CounterCapability; reasons: string[]; counts: Record<SaleSemantics, number> };
  views: { classification: ViewsSemantics; capability: CounterCapability; reasons: string[]; counts: Record<ViewsBehaviour, number> };
  intervals: number;
}

/**
 * Shop-wide verdict over every compared interval. Contradicting evidence
 * wins: one decrease rules out "cumulative". "Cumulative" needs ≥ 3 items
 * whose growth covered known sales and no contradiction; confidence stays LOW
 * with a single interval. Semantics are never marked VERIFIED here — that
 * needs the multi-day follow-up (docs/shopee-product-analytics-api.md §10).
 */
export function summarizeCounterSemantics(deltas: readonly ItemCounterDelta[], intervals = 1): CounterSemanticsVerdict {
  const saleCounts: Record<SaleSemantics, number> = { LIKELY_CUMULATIVE: 0, LIKELY_ROLLING: 0, LIKELY_OTHER: 0, INSUFFICIENT_EVIDENCE: 0 };
  const viewCounts: Record<ViewsBehaviour, number> = { INCREASES: 0, FLAT: 0, DECREASES: 0, RESETS: 0, NOT_RETURNED: 0 };
  for (const d of deltas) {
    saleCounts[d.sale]++;
    viewCounts[d.views]++;
  }
  const saleReasons: string[] = [];
  let sale: SaleSemantics;
  if (saleCounts.LIKELY_ROLLING > 0) {
    sale = "LIKELY_ROLLING";
    saleReasons.push(`${saleCounts.LIKELY_ROLLING} item(s) decreased or sat below units already recorded — not a lifetime counter`);
  } else if (saleCounts.LIKELY_OTHER > 0) {
    sale = "LIKELY_OTHER";
    saleReasons.push(`${saleCounts.LIKELY_OTHER} item(s) grew less than their Ads-attributed units — lagging or differently defined`);
  } else if (saleCounts.LIKELY_CUMULATIVE >= 3) {
    sale = "LIKELY_CUMULATIVE";
    saleReasons.push(`${saleCounts.LIKELY_CUMULATIVE} item(s) grew by at least their Ads-attributed units, none decreased`);
  } else {
    sale = "INSUFFICIENT_EVIDENCE";
    saleReasons.push("too few items with known sales in the interval to tell cumulative from rolling");
  }
  if (intervals < 3) saleReasons.push(`${intervals} interval(s) observed — run the multi-day follow-up before relying on it`);

  const returned = deltas.length - viewCounts.NOT_RETURNED;
  let views: ViewsSemantics;
  const viewReasons: string[] = [];
  if (viewCounts.DECREASES + viewCounts.RESETS > 0) {
    views = "NON_MONOTONIC";
    viewReasons.push(`${viewCounts.DECREASES} decrease(s), ${viewCounts.RESETS} reset(s)`);
  } else if (returned > 0 && viewCounts.INCREASES > 0) {
    views = "MONOTONIC_SO_FAR";
    viewReasons.push(`${viewCounts.INCREASES} increased, ${viewCounts.FLAT} flat, none decreased — still not proof of a lifetime counter`);
  } else {
    views = "INSUFFICIENT_EVIDENCE";
    viewReasons.push("no movement observed");
  }

  return {
    sale: { classification: sale, confidence: sale !== "INSUFFICIENT_EVIDENCE" && intervals >= 3 ? "MEDIUM" : "LOW", capability: "SEMANTICS_UNKNOWN", reasons: saleReasons, counts: saleCounts },
    views: { classification: views, capability: "SEMANTICS_UNKNOWN", reasons: viewReasons, counts: viewCounts },
    intervals,
  };
}
