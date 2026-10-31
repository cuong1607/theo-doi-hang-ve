// SHOPEE-PRODUCT-ANALYTICS-1P — T0/T1 counter semantics: contradiction wins,
// Ads units are only a lower bound, never "verified" from one interval.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyItemSale,
  classifyItemViews,
  compareCounterSnapshots,
  summarizeCounterSemantics,
  type CounterSnapshot,
  type ItemIntervalContext,
} from "./counter-semantics.ts";

const snap = (itemId: string, sale: number | null, views: number | null, at: string, knownUnitsInDb = 0): CounterSnapshot => ({
  itemId,
  capturedAt: at,
  returned: sale !== null,
  sale,
  views,
  likes: sale === null ? null : 1,
  ratingStar: sale === null ? null : 4.9,
  commentCount: sale === null ? null : 3,
  knownUnitsInDb,
});
const ctx = (lb: number | null, status = "NORMAL"): ItemIntervalContext => ({ providerStatus: status, adsDirectUnitsLowerBound: lb, adsHours: lb === null ? 0 : 23 });
const T0 = "2026-10-30T09:00:00.000Z";
const T1 = "2026-10-31T09:00:00.000Z";

test("item sale: decrease → rolling, below Ads units → other, covers Ads units → cumulative, no sales → insufficient", () => {
  assert.equal(classifyItemSale({ deltaSale: -2, adsDirectUnitsLowerBound: 0, saleBelowKnownUnits: false }), "LIKELY_ROLLING");
  assert.equal(classifyItemSale({ deltaSale: 1, adsDirectUnitsLowerBound: 4, saleBelowKnownUnits: false }), "LIKELY_OTHER");
  assert.equal(classifyItemSale({ deltaSale: 5, adsDirectUnitsLowerBound: 4, saleBelowKnownUnits: false }), "LIKELY_CUMULATIVE");
  assert.equal(classifyItemSale({ deltaSale: 0, adsDirectUnitsLowerBound: 0, saleBelowKnownUnits: false }), "INSUFFICIENT_EVIDENCE");
  assert.equal(classifyItemSale({ deltaSale: 3, adsDirectUnitsLowerBound: null, saleBelowKnownUnits: false }), "INSUFFICIENT_EVIDENCE");
  assert.equal(classifyItemSale({ deltaSale: null, adsDirectUnitsLowerBound: 4, saleBelowKnownUnits: false }), "INSUFFICIENT_EVIDENCE");
  // below units we already recorded → not lifetime, even if it grew
  assert.equal(classifyItemSale({ deltaSale: 2, adsDirectUnitsLowerBound: 1, saleBelowKnownUnits: true }), "LIKELY_ROLLING");
});

test("item views: increase / flat / decrease / reset / missing", () => {
  assert.equal(classifyItemViews(100, 130), "INCREASES");
  assert.equal(classifyItemViews(100, 100), "FLAT");
  assert.equal(classifyItemViews(100, 95), "DECREASES");
  assert.equal(classifyItemViews(5000, 12), "RESETS");
  assert.equal(classifyItemViews(null, 12), "NOT_RETURNED");
});

test("compare: same ids only, omitted items stay explicit, known DB units checked", () => {
  const deltas = compareCounterSnapshots(
    [snap("1", 100, 1000, T0, 10), snap("2", 50, 400, T0), snap("3", null, null, T0)],
    [snap("1", 104, 1100, T1), snap("2", 48, 380, T1)],
    new Map([["1", ctx(3)], ["2", ctx(0)], ["3", ctx(null, "SELLER_DELETE")]]),
  );
  assert.deepEqual(deltas.map((d) => [d.itemId, d.deltaSale, d.deltaViews, d.sale, d.views]), [
    ["1", 4, 100, "LIKELY_CUMULATIVE", "INCREASES"],
    ["2", -2, -20, "LIKELY_ROLLING", "DECREASES"],
    ["3", null, null, "INSUFFICIENT_EVIDENCE", "NOT_RETURNED"],
  ]);
  assert.equal(deltas[2].providerStatus, "SELLER_DELETE");
  assert.equal(deltas[2].returnedT1, false);
  const below = compareCounterSnapshots([snap("9", 5, 10, T0, 40)], [snap("9", 6, 11, T1, 40)], new Map([["9", ctx(1)]]));
  assert.equal(below[0].saleBelowKnownUnits, true);
  assert.equal(below[0].sale, "LIKELY_ROLLING");
});

test("summary: one contradiction wins; cumulative needs ≥ 3 items; capability never VERIFIED; LOW confidence on one interval", () => {
  const ok = compareCounterSnapshots(
    ["a", "b", "c"].map((id) => snap(id, 100, 500, T0)),
    ["a", "b", "c"].map((id) => snap(id, 103, 520, T1)),
    new Map(["a", "b", "c"].map((id) => [id, ctx(2)])),
  );
  const v = summarizeCounterSemantics(ok, 1);
  assert.equal(v.sale.classification, "LIKELY_CUMULATIVE");
  assert.equal(v.sale.confidence, "LOW");
  assert.equal(v.sale.capability, "SEMANTICS_UNKNOWN");
  assert.equal(v.views.classification, "MONOTONIC_SO_FAR");
  assert.equal(v.views.capability, "SEMANTICS_UNKNOWN");
  assert.equal(summarizeCounterSemantics(ok, 3).sale.confidence, "MEDIUM");

  const mixed = [...ok, ...compareCounterSnapshots([snap("d", 100, 500, T0)], [snap("d", 90, 450, T1)], new Map([["d", ctx(0)]]))];
  const m = summarizeCounterSemantics(mixed, 5);
  assert.equal(m.sale.classification, "LIKELY_ROLLING");
  assert.equal(m.views.classification, "NON_MONOTONIC");

  const two = summarizeCounterSemantics(ok.slice(0, 2), 1);
  assert.equal(two.sale.classification, "INSUFFICIENT_EVIDENCE");
  assert.equal(summarizeCounterSemantics([], 1).views.classification, "INSUFFICIENT_EVIDENCE");
});
