// SHOPEE-8 periods (pure) — node --test src/lib/analytics/periods.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { domainFreshness, formatAgeMinutes } from "./freshness.ts";
import { chooseBucket, coverageText, deltaPercent, deltaTone, formatDelta, previousPeriod, resolvePeriod, vnToday } from "./periods.ts";

test("SHOPEE-8 48 + 94: VN day boundary — 23:30 UTC is already tomorrow in Vietnam", () => {
  assert.equal(vnToday(new Date("2026-10-17T16:59:00Z")), "2026-10-17");
  assert.equal(vnToday(new Date("2026-10-17T17:00:00Z")), "2026-10-18");
  const now = new Date("2026-10-17T17:30:00Z");
  assert.deepEqual(resolvePeriod({ preset: "today" }, now), { preset: "today", from: "2026-10-18", to: "2026-10-18" });
  assert.deepEqual(resolvePeriod({ preset: "yesterday" }, now), { preset: "yesterday", from: "2026-10-17", to: "2026-10-17" });
});

test("SHOPEE-8 6 + 94: presets, custom range, previous period", () => {
  const now = new Date("2026-03-15T05:00:00Z");
  assert.deepEqual(resolvePeriod({ preset: "7d" }, now), { preset: "7d", from: "2026-03-09", to: "2026-03-15" });
  assert.deepEqual(resolvePeriod({ preset: "this_month" }, now), { preset: "this_month", from: "2026-03-01", to: "2026-03-15" });
  assert.deepEqual(resolvePeriod({ preset: "last_month" }, now), { preset: "last_month", from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(resolvePeriod({ from: "2026-03-10", to: "2026-03-01" }, now), { preset: "custom", from: "2026-03-01", to: "2026-03-10" }, "swapped range fixed");
  assert.deepEqual(resolvePeriod({ preset: "bogus" }, now), { preset: "today", from: "2026-03-15", to: "2026-03-15" });

  assert.deepEqual(previousPeriod(resolvePeriod({ preset: "today" }, now)), { from: "2026-03-14", to: "2026-03-14" });
  assert.deepEqual(previousPeriod(resolvePeriod({ preset: "7d" }, now)), { from: "2026-03-02", to: "2026-03-08" });
  assert.deepEqual(previousPeriod(resolvePeriod({ preset: "this_month" }, now)), { from: "2026-02-01", to: "2026-02-15" }, "same days of the previous month");
  assert.deepEqual(previousPeriod(resolvePeriod({ preset: "this_month" }, new Date("2026-03-31T05:00:00Z"))), { from: "2026-02-01", to: "2026-02-28" }, "clamped to month end");
  assert.deepEqual(previousPeriod(resolvePeriod({ preset: "last_month" }, now)), { from: "2026-01-01", to: "2026-01-31" });
});

test("SHOPEE-8 14: chart buckets stay small", () => {
  assert.equal(chooseBucket("2026-03-15", "2026-03-15"), "hour");
  assert.equal(chooseBucket("2026-03-14", "2026-03-15"), "hour");
  assert.equal(chooseBucket("2026-03-01", "2026-03-31"), "day");
  assert.equal(chooseBucket("2026-01-01", "2026-12-31"), "week");
});

test("SHOPEE-8 54 + 55: delta formula, zero previous, semantic direction", () => {
  assert.equal(deltaPercent("112.3", "100"), 12.3);
  assert.equal(deltaPercent("-50", "-100"), 50, "loss shrinking is +50% (|previous|)");
  assert.equal(deltaPercent("10", "0"), null, "no infinity");
  assert.equal(deltaPercent(null, "1"), null);
  assert.equal(formatDelta(null), "—");
  assert.equal(formatDelta(-5.4), "−5,4%");
  assert.equal(deltaTone(12, "up_good"), "success");
  assert.equal(deltaTone(12, "up_bad"), "danger", "more returns is not good");
  assert.equal(deltaTone(-3, "up_bad"), "success");
  assert.equal(deltaTone(5, "neutral"), "neutral");
  assert.equal(coverageText(70, 100), "70 / 100 đơn (70%)");
});

test("SHOPEE-8 70 + 71: per-domain freshness uses the OLDEST shop; stale after 3 x interval", () => {
  const now = new Date("2026-10-17T10:00:00Z");
  const last: Record<string, string | null> = {
    "s1|order": "2026-10-17T09:55:00Z",
    "s2|order": "2026-10-17T09:00:00Z",
    "s1|escrow": "2026-10-17T09:50:00Z",
    "s2|escrow": "2026-10-17T09:40:00Z",
    "s1|return": null,
    "s2|return": "2026-10-17T09:59:00Z",
  };
  const f = domainFreshness(["s1", "s2"], (s, t) => last[`${s}|${t}`] ?? null, { orderIntervalMinutes: 5, escrowIntervalMinutes: 15, returnIntervalMinutes: 15, incomeIntervalMinutes: 20, payoutIntervalMinutes: 60 }, now);
  const by = Object.fromEntries(f.map((d) => [d.syncType, d]));
  assert.deepEqual([by.order.lastSuccessAt, by.order.ageMinutes, by.order.stale], ["2026-10-17T09:00:00Z", 60, true], "one fresh shop does not make the domain fresh");
  assert.deepEqual([by.escrow.ageMinutes, by.escrow.stale, by.escrow.staleAfterMinutes], [20, false, 45]);
  assert.deepEqual([by.return.lastSuccessAt, by.return.stale], [null, true], "a shop that never synced");
  assert.equal(formatAgeMinutes(130), "2 giờ");
});
