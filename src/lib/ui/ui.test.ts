// ============================================================
// PHASE UIUX-1 — UI logic (pure, no DOM / DB):
//   node --test src/lib/ui/ui.test.ts
//
// formatting, status → tone, progress, list URL state, toast store, async
// action runner (no double submit, friendly errors, toasts), navigation,
// plus static guards (loading.tsx on data routes, no raw palette colours,
// no raw error rendering).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createActionRunner, DEFAULT_ACTION_ERROR, phaseOf, type ActionOutcome } from "./action-runner.ts";
import { formatAge, formatCurrency, formatDate, formatDateTime, formatDecimalString, formatDuration, formatPercent, formatPercentString, formatQuantity, formatSignedCurrency, formatTime, numericSign } from "./format.ts";
import { activeFilterCount, buildListHref, pageRange, parsePage, parsePageSize } from "./list-query.ts";
import { activeNavHref, pageTitleFor } from "./navigation.ts";
import { progressPercent } from "./progress.ts";
import {
  FINANCIAL_STATUS_TONE,
  JOB_STATUS_TONE,
  MAPPING_STATUS_TONE,
  ORDER_STATUS_TONE,
  profitTone,
  READINESS_TONE,
  RECONCILIATION_TONE,
  SYNC_STATE_TONE,
  TONE_BADGE_CLASS,
  toneOf,
} from "./status.ts";
import { createToastStore, MAX_VISIBLE_TOASTS, TOAST_DURATION_MS } from "./toast-store.ts";
import { SYNC_DISPLAY_LABELS } from "../channels/core/sync-display.ts";

const ROOT = new URL("../../../", import.meta.url);
const rootPath = (rel: string) => path.join(ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1"), rel);

// ------------------------------------------------------------ formatting (34 / 35)

test("formatCurrency: NUMERIC strings exact (no float), numbers rounded to the đồng, null → —", () => {
  assert.equal(formatCurrency("1234567"), "1.234.567 ₫");
  assert.equal(formatCurrency("1234567.50"), "1.234.567,5 ₫");
  assert.equal(formatCurrency("-2700"), "-2.700 ₫");
  assert.equal(formatCurrency("0.00"), "0 ₫");
  assert.equal(formatCurrency("-0"), "0 ₫");
  assert.equal(formatCurrency("12345678901234567890.12"), "12.345.678.901.234.567.890,12 ₫", "beyond float precision, still exact");
  assert.equal(formatCurrency(1234567.6), "1.234.568 ₫");
  assert.equal(formatCurrency(null), "—");
  assert.equal(formatCurrency(undefined), "—");
  assert.equal(formatCurrency(Number.NaN), "—");
});

test("PATCH estimated profit display: signed amount + SQL-computed percent", () => {
  assert.equal(formatSignedCurrency("30000.0000"), "+30.000 ₫");
  assert.equal(formatSignedCurrency("-10000.0000"), "-10.000 ₫");
  assert.equal(formatSignedCurrency("0.0000"), "0 ₫");
  assert.equal(formatSignedCurrency(null), "—");
  assert.equal(formatPercentString("30.0"), "30%");
  assert.equal(formatPercentString("-12.5"), "-12,5%");
  assert.equal(formatPercentString(null), "—", "total 0 / unknown → —");
});

test("formatQuantity / formatPercent / numericSign", () => {
  assert.equal(formatQuantity("1500"), "1.500");
  assert.equal(formatQuantity(2.5), "2,5");
  assert.equal(formatQuantity(null), "—");
  assert.equal(formatPercent(0.125), "12,5%");
  assert.equal(formatPercent(null), "—");
  assert.equal(numericSign("150000.00"), 1);
  assert.equal(numericSign("-1"), -1);
  assert.equal(numericSign("0.000"), 0);
  assert.equal(numericSign(null), null);
  assert.equal(formatDecimalString("1000000"), "1.000.000");
});

test("dates: dd/MM/yyyy and dd/MM/yyyy HH:mm in Asia/Ho_Chi_Minh; calendar days never shift", () => {
  // 2026-10-15T17:30Z = 16/10/2026 00:30 in Vietnam (UTC+7)
  assert.equal(formatDateTime("2026-10-15T17:30:00Z"), "16/10/2026 00:30");
  assert.equal(formatDate("2026-10-15T17:30:00Z"), "16/10/2026");
  assert.equal(formatTime("2026-10-16T01:05:00Z"), "08:05");
  assert.equal(formatDate("2026-10-16"), "16/10/2026", "a plain date is a calendar day, not an instant");
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime("not a date"), "—");
});

test("durations and job age", () => {
  assert.equal(formatDuration(850), "850 ms");
  assert.equal(formatDuration(38_000), "38 giây");
  assert.equal(formatDuration(185_000), "3 phút 5 giây");
  assert.equal(formatDuration(120_000), "2 phút");
  assert.equal(formatDuration(2 * 3600_000 + 10 * 60_000), "2 giờ 10 phút");
  assert.equal(formatDuration(-1), "—");
  assert.equal(formatAge("2026-10-16T08:00:00Z", new Date("2026-10-16T08:00:38Z")), "38 giây");
  assert.equal(formatAge(null), "—");
});

// ------------------------------------------------------------ status badges (16 / 2)

test("2. status → tone: same meaning, same colour across the app", () => {
  assert.equal(SYNC_STATE_TONE.synced, "success");
  assert.equal(SYNC_STATE_TONE.syncing, "info");
  assert.equal(SYNC_STATE_TONE.retrying, "warning");
  assert.equal(SYNC_STATE_TONE.failed, "danger");
  assert.equal(SYNC_STATE_TONE.never, "neutral");
  assert.equal(SYNC_STATE_TONE.queued, "neutral");
  assert.equal(JOB_STATUS_TONE.success, "success");
  assert.equal(JOB_STATUS_TONE.failed, "danger");
  assert.equal(RECONCILIATION_TONE.matched, "success");
  assert.equal(RECONCILIATION_TONE.warning, "warning");
  assert.equal(RECONCILIATION_TONE.mismatch, "danger");
  assert.equal(READINESS_TONE.partial, "warning", "Partial / thiếu → warning");
  assert.equal(MAPPING_STATUS_TONE.unmapped, "neutral", "Chưa map is neutral by itself (not alarm red)");
  assert.equal(MAPPING_STATUS_TONE.mapping_conflict, "danger");
  assert.equal(ORDER_STATUS_TONE.COMPLETED, "success");
  assert.equal(FINANCIAL_STATUS_TONE.mismatch, "danger");
  assert.equal(toneOf(ORDER_STATUS_TONE, "SOME_NEW_STATUS"), "neutral", "unknown status never gets a scary colour");
  assert.equal(toneOf(JOB_STATUS_TONE, null), "neutral");
  // every sync display state has a label and a tone
  for (const state of Object.keys(SYNC_DISPLAY_LABELS)) assert.ok(SYNC_STATE_TONE[state], state);
});

test("21. financial colour semantics: profit success, loss danger, zero / unknown neutral", () => {
  assert.equal(profitTone(numericSign("150000")), "success");
  assert.equal(profitTone(numericSign("-200")), "danger");
  assert.equal(profitTone(numericSign("0.00")), "neutral");
  assert.equal(profitTone(numericSign(null)), "neutral");
});

test("badge classes use semantic tokens only (no raw palette colours)", () => {
  for (const cls of Object.values(TONE_BADGE_CLASS)) assert.doesNotMatch(cls, /(amber|emerald|green|red|yellow|orange|blue|sky|rose)-\d/);
});

// ------------------------------------------------------------ progress (18)

test("18. SyncProgress: known total → percent; unknown → null (indeterminate, no fake %)", () => {
  assert.equal(progressPercent(120, 350), 34);
  assert.equal(progressPercent(350, 350), 100);
  assert.equal(progressPercent(400, 350), 100, "never above 100");
  assert.equal(progressPercent(5, null), null);
  assert.equal(progressPercent(5, undefined), null);
  assert.equal(progressPercent(0, 0), null);
});

// ------------------------------------------------------------ list URL state (8 / 9 / 45 / 46)

test("8. filters + page + size live in the URL: clean, shareable hrefs", () => {
  const q = { status: "COMPLETED", sn: undefined, shop: "all", sku: "" };
  assert.equal(buildListHref("/shopee/orders", q), "/shopee/orders?status=COMPLETED");
  assert.equal(buildListHref("/shopee/orders", q, { page: 3 }), "/shopee/orders?status=COMPLETED&page=3");
  assert.equal(buildListHref("/shopee/orders", q, { page: 1, size: 25 }), "/shopee/orders?status=COMPLETED", "page 1 + default size omitted");
  assert.equal(buildListHref("/shopee/orders", q, { page: 2, size: 100 }), "/shopee/orders?status=COMPLETED&page=2&size=100");
  assert.equal(buildListHref("/x", {}), "/x");
  assert.equal(activeFilterCount({ status: "COMPLETED", shop: "all", sn: "", sku: undefined, from: "2026-10-01" }, ["status", "shop", "sn", "sku", "from"]), 2);
});

test("9. pagination: page / size parsing is defensive; range text", () => {
  assert.equal(parsePageSize("50"), 50);
  assert.equal(parsePageSize("1000"), 25, "only 25 / 50 / 100 — never fetch everything");
  assert.equal(parsePageSize(undefined), 25);
  assert.equal(parsePage("3"), 3);
  assert.equal(parsePage("-4"), 1);
  assert.equal(parsePage("abc"), 1);
  assert.equal(parsePage("9", 4), 4);
  assert.deepEqual(pageRange(2, 25, 1234), { from: 26, to: 50 });
  assert.deepEqual(pageRange(50, 25, 1234), { from: 1226, to: 1234 });
  assert.deepEqual(pageRange(1, 25, 0), { from: 0, to: 0 });
});

// ------------------------------------------------------------ toasts (6 / 7)

test("6 + 7. toast store: success / error / warning / info, auto-dismiss, capped, messages truncated", () => {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const store = createToastStore((fn, ms) => timers.push({ fn, ms }));
  let notified = 0;
  store.subscribe(() => notified++);
  const ok = store.add("success", "Đã tạo yêu cầu đồng bộ.");
  store.add("error", "Không thể đồng bộ sản phẩm.");
  assert.equal(store.getSnapshot().length, 2);
  assert.equal(timers[0].ms, TOAST_DURATION_MS.success);
  assert.ok(TOAST_DURATION_MS.error > TOAST_DURATION_MS.success, "errors stay longer");
  timers[0].fn();
  assert.deepEqual(store.getSnapshot().map((t) => t.tone), ["error"]);
  assert.ok(!store.getSnapshot().some((t) => t.id === ok));
  for (let i = 0; i < 10; i++) store.add("info", `m${i}`);
  assert.equal(store.getSnapshot().length, MAX_VISIBLE_TOASTS);
  assert.equal(store.add("warning", "x".repeat(1000)) > 0, true);
  assert.equal(store.getSnapshot().at(-1)!.message.length, 200);
  assert.ok(notified >= 13);
});

// ------------------------------------------------------------ async actions (1 / 11 / 12)

function recorder() {
  const calls: string[] = [];
  return { calls, notify: { success: (m: string) => calls.push(`success:${m}`), warning: (m: string) => calls.push(`warning:${m}`), error: (m: string) => calls.push(`error:${m}`) } };
}

test("1 + 11. async action: loading phase, a second click while in flight is ignored (no double submit)", async () => {
  const { calls, notify } = recorder();
  const runner = createActionRunner(notify);
  let resolve!: (v: ActionOutcome) => void;
  let executions = 0;
  const fn = () => {
    executions++;
    return new Promise<ActionOutcome>((r) => (resolve = r));
  };
  const first = runner.run(fn);
  assert.equal(runner.busy, true);
  assert.equal(phaseOf(runner.busy, null), "loading");
  const second = await runner.run(fn);
  assert.equal(second, null, "ignored while the first is in flight");
  resolve({ ok: true, message: "Đã thêm yêu cầu đồng bộ." });
  const outcome = await first;
  assert.equal(executions, 1);
  assert.equal(runner.busy, false);
  assert.equal(phaseOf(false, outcome), "success");
  assert.deepEqual(calls, ["success:Đã thêm yêu cầu đồng bộ."]);
  // after it settled, the button works again
  await runner.run(async () => ({ ok: true, message: "lại" }));
  assert.equal(calls.length, 2);
});

test("12. a thrown / malformed action never crashes the page: friendly error outcome + error toast (raw error hidden)", async () => {
  const { calls, notify } = recorder();
  const runner = createActionRunner(notify);
  const thrown = await runner.run(async () => {
    throw new Error("duplicate key value violates unique constraint \"secret_table_pkey\"");
  });
  assert.deepEqual(thrown, { ok: false, message: DEFAULT_ACTION_ERROR });
  assert.equal(phaseOf(false, thrown), "error");
  assert.ok(!calls.join("").includes("secret_table"), "raw DB error never shown");
  const custom = await runner.run(async () => undefined as unknown as ActionOutcome, { errorMessage: "Không thể đồng bộ sản phẩm." });
  assert.deepEqual(custom, { ok: false, message: "Không thể đồng bộ sản phẩm." });
  const warn = await runner.run(async () => ({ ok: true, warning: true, message: "Đồng bộ xong, có 3 bản ghi lỗi." }));
  assert.equal(warn!.ok, true);
  assert.deepEqual(calls, [`error:${DEFAULT_ACTION_ERROR}`, "error:Không thể đồng bộ sản phẩm.", "warning:Đồng bộ xong, có 3 bản ghi lỗi."]);
  // server said no → error toast, never an optimistic success
  await runner.run(async () => ({ ok: false, message: "Shop đang tạm ngưng." }));
  assert.equal(calls.at(-1), "error:Shop đang tạm ngưng.");
});

// ------------------------------------------------------------ navigation (25 / 26)

test("sidebar: exactly one active item (longest match); header title for nested routes", () => {
  const hrefs = ["/dashboard", "/receipts/new", "/receipts", "/shopee/orders", "/shopee/sync"];
  assert.equal(activeNavHref("/receipts/new", hrefs), "/receipts/new", "not also 'Lịch sử hàng về'");
  assert.equal(activeNavHref("/receipts/abc/edit", hrefs), "/receipts");
  assert.equal(activeNavHref("/shopee/orders/123", hrefs), "/shopee/orders");
  assert.equal(activeNavHref("/shopee/orderstuff", hrefs), null, "segment match only");
  assert.equal(pageTitleFor("/shopee/orders/9f0c", "BRAND"), "Đơn hàng Shopee");
  assert.equal(pageTitleFor("/inventory/costs/abc", "BRAND"), "Giá vốn");
  assert.equal(pageTitleFor("/unknown", "BRAND"), "BRAND");
});

// ------------------------------------------------------------ static guards

function filesUnder(rel: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (filter(p)) out.push(p);
    }
  };
  walk(rootPath(rel));
  return out;
}

test("UIUX-1 page loading: every priority data route has a loading.tsx (never a blank page)", () => {
  const routes = [
    "dashboard",
    "shopee/sync",
    "shopee/orders",
    "shopee/orders/[id]",
    "shopee/products",
    "inventory/costs",
    "inventory/costs/[productId]",
    "receipts",
    "invoices",
    "payments",
  ];
  for (const r of routes) assert.ok(existsSync(rootPath(`src/app/(authenticated)/${r}/loading.tsx`)), `${r}/loading.tsx`);
  assert.ok(existsSync(rootPath("src/app/(authenticated)/loading.tsx")), "group fallback skeleton");
  assert.ok(existsSync(rootPath("src/app/(authenticated)/error.tsx")), "group error boundary");
});

test("37. no raw palette colours in pages / components (semantic tokens only)", () => {
  const files = filesUnder("src", (p) => p.endsWith(".tsx"));
  const offenders = files.filter((f) => /\b(text|bg|border)-(amber|emerald|green|red|yellow|orange|sky|rose)-\d{2,3}\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("12 (static). error boundaries never render the raw error message or stack", () => {
  const boundaries = filesUnder("src/app", (p) => /error\.tsx$/.test(p));
  assert.ok(boundaries.length >= 4);
  for (const f of boundaries) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /error\.(message|stack)/, f);
    assert.match(src, /ErrorState/, f);
  }
});

test("54. UI primitives stay light: no animation / toast library dependency added", () => {
  const pkg = JSON.parse(readFileSync(rootPath("package.json"), "utf8")) as { dependencies: Record<string, string> };
  for (const heavy of ["framer-motion", "motion", "react-spring", "gsap", "sonner", "react-hot-toast", "react-toastify"]) assert.equal(pkg.dependencies[heavy], undefined, heavy);
});
