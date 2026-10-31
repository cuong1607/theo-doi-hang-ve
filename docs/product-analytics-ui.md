# Product analytics: UI (PA-3)

`/shopee/product-analytics` and `/shopee/product-analytics/[productId]` are the same product as
the Shopee Ads dashboard. They reuse:

* the `components/ads/*` pieces: `AdsSection`, `AdsSegmented`, `AdsEmptyState`, `AdsSkeletonBlock`,
  `AdsProductThumb`, `AnimatedNumber`, `METRIC_STYLE`, `DELTA_CLASS`, `INSIGHT_STYLE`;
* the Ads tokens (`--ads-*`, `--metric-*`, success / warning / danger / info soft);
* the `ads-card`, `animate-ads-*`, `ads-gradient-*` and shimmer utilities.

The product-specific pieces live in `src/components/product-analytics/`.

## List page (top → bottom)

1. **Hero header** (`pa-page-header`): the Ads wash and glow, the period segmented control
   (Hôm nay / Hôm qua / 7 ngày / 30 ngày), and chips for:
   * the range and the comparison range;
   * the shop scope;
   * data freshness, which turns warning-coloured when stale;
   * the partial-today indicator.

   A sub-nav links Sản phẩm and Quảng cáo.
2. **Filters** (`pa-filter-bar`): a plain GET form, so the URL can be shared and the form works
   without JS. It has search, shop, health (including "Cần chú ý"), signal, Ads, status and sort.
   A custom date range sits in a disclosure.
3. **Notices** (`pa-notice`): shops without sales data, pending backfill, previous period not
   covered, stale data.
4. **Hero metrics:**
   * a gradient Sales GMV card;
   * Orders (DISTINCT, shop level), Units, Ads spend (shop), Broad ROAS (shop).

   Sales cards show "—" for no data and "≥" for a lower bound. They show a Δ only when it is
   valid, and otherwise say why there is none.
5. **Sức khỏe sản phẩm:** five cards (Tốt / Ổn định / Cần theo dõi / Yếu / Chưa đủ dữ liệu) with
   count and %. Clicking one filters the list. Below them: counts of declining sales and
   declining Ads efficiency, and a shop-only note about similar declines.
6. **Sản phẩm cần chú ý:** up to 6 cards sorted by priority. Each card has the image, name,
   sales / orders / ROAS with Δ chips, a health badge, a priority pill, the top 2 signals and
   the health reason.
7. **Danh sách sản phẩm:**
   * desktop: a card/table hybrid with four groups — SẢN PHẨM (thumb, name, SKU, shop, status) ·
     DOANH SỐ (GMV, orders · units, Δ chip) · QUẢNG CÁO (spend · ROAS, clicks · Broad GMV, Δ ROAS) ·
     SỨC KHỎE (health, priority, 1–2 signals, data-quality chips);
   * under `md`: stacked cards;
   * server-side pagination with 25 / 50 / 100 rows.
8. **Đồng bộ dữ liệu sản phẩm:** per-shop cards with the admin switches.

## Detail page

1. The header contains the image, name, health badge, priority, shop, item, SKU and status.
2. Five KPI cards: Sales, Orders, Units, Ads spend, Broad ROAS.
3. **Tín hiệu đáng chú ý:**
   * the health reason, its confidence and the priority formula;
   * every signal with previous → current, severity and confidence;
   * the shop baseline line.
4. **Xu hướng theo ngày** (`pa-trend-chart`):
   * the "Doanh số & Ads" mode shows sales (solid), Ads spend (solid) and Broad GMV
     (dashed, "attribution"). All are VND on one axis, and each series can be toggled.
   * The "Đơn & SL" mode has its own axis; so does "Hiệu quả Ads" (ROAS).
   * Uncovered days are gaps. A data table is available.
5. **Doanh số so với nền lịch sử:** cancelled orders plus a baseline table (median · mean · CV of the 7 / 30 days before).
6. **Quảng cáo:** a 12-tile grid, plus the **attribution indicator**. It carries the label
   "Ads attribution / total sales indicator" (Vietnamese text on screen, the English label for
   screen readers) and the spec tooltip. It is hidden when sales are a lower bound.
7. **Ảnh chụp hiện tại từ Shopee:** snapshot values, no trend, a semantics note.
8. **Chất lượng dữ liệu:** five friendly items (sales freshness, Ads freshness, comparison
   coverage, today, snapshot confidence). Raw codes appear only under "Chi tiết kỹ thuật".

## Rules

* **Semantic colour** (`deltaTone`, `signalTone`): sales↓ / ROAS↓ / CVR↓ / CPC↑ are bad;
  CPC↓ is good; spend is neutral. Each chip has an arrow, a sign and words, so colour is never
  the only signal.
* **Missing data is not zero:** `display.ts` (`formatSalesValue`, `salesAvailability`) and the
  SQL NULLs.
* **No false causality:** the copy says "cùng xảy ra" / "đồng thời", never "do quảng cáo".
  Shop comparisons say "so sánh trong shop — không phải thị trường".
* **Dark mode:** every colour is a token. Chart strokes use `var(--metric-*)`.
* **Motion:** entrances play once (`animate-ads-rise`, staggered with `--ads-delay`); there is no
  looping animation except the shimmer. `prefers-reduced-motion` collapses all durations
  (globals.css).
* **Accessibility:** focus rings on every link and button; a radiogroup with arrow keys for the
  period; `aria-pressed` on health cards and chart toggles; an `img` label on the chart plus a
  data table; `sr-only` tone words.
* **Loading:** `loading.tsx` for the list and the detail (`pa-skeleton`, Ads shimmer, the same grid).
* **Empty states** (`AdsEmptyState`): no shop, no products in the period, no filter match,
  no attention items, no campaign.

## Verification

`scripts/e2e/product-analytics-3-ui.ts`, run with Playwright on the local replica of
production, covers:

* list sections, pagination, health filter, accent-insensitive search, sort;
* detail KPIs, signals, chart toggle, indicator wording, data-quality panel;
* keyboard focus and the arrow-key period switch;
* 390 px stacked cards with 0 px overflow;
* dark mode (dark page and card backgrounds) and reduced motion;
* zero provider calls while browsing (0 new jobs, 0 snapshots, 0 `shopee_api_call` in the server log).
