# Product intelligence — signals, health, attention priority

PRODUCT-ANALYTICS-3. The engine is SQL (`pa_intelligence_eval`, migration
`00071_product_intelligence.sql`). Every number it uses comes from
`PRODUCT_INTELLIGENCE_CONFIG` in `src/lib/product-analytics/config.ts`, sent to
the RPCs as `p_cfg`. If a key is missing, the SQL refuses the config, so there are no
magic numbers in SQL. Wording (Vietnamese labels, reasons, priority explanation) lives in
`src/lib/product-analytics/signals.ts`.

## 1. Principles

* **Signals are observations, not causes.** For example, `SALES_DOWN −32 %`. No rule maps a
  combination of signals to a cause such as "sales down + Ads down → cause = Ads". A later
  Claude analyst will interpret combinations.
* **Missing data is not zero.** Sales signals fire only when both periods are fully covered
  by the sales facts (`coverage.ts`, mirrored in SQL). Uncovered data gets a
  data-quality signal instead of `+500 %`.
* **Small moves on a small base are not important.** Every movement needs a real previous
  base. A WARNING also needs a major move on a product with real business scale.
* **Broad Ads GMV is attribution.** It is never subtracted from sales and never called a
  share. The only allowed ratio is the "Ads attribution / total sales indicator".

## 2. Source / trust metadata

| metric | source | semantic confidence |
|---|---|---|
| Sales GMV, orders, units | `shopee_product_sales_facts` (get_order_detail) | HIGH |
| Ads spend, impressions, clicks, CPC, CTR | `shopee_ads_campaign_*_performance` (single-item campaigns) | HIGH |
| Broad / direct GMV, ROAS, CVR | Shopee Ads report, `semantic_type = ATTRIBUTION` | HIGH (as attribution) |
| Attribution indicator (broad GMV ÷ sales) | two sources with different attribution windows | LOW |
| Snapshot views / sale / likes / rating / comments | `get_item_extra_info` | UNKNOWN / LOW: snapshot only, no trend |

`PRODUCT_METRIC_META` in `data-quality.ts` holds the same table. Agent tools send it as
`metric_meta`.

## 3. Signals

The engine compares the current period with the previous comparable one, built in
`periods.ts`:

* 7d is compared with the previous 7 days.
* 30d is compared only when the previous 30 days are covered; until the backfill is
  60 days old, it never is.
* Today uses the same completed hour on both days. Sales use orders created before HH:00;
  Ads use hourly rows with hour < HH.

| signal | metric | min. base (config) | Δ% thresholds | meaning of UP |
|---|---|---|---|---|
| `SALES_UP / SALES_DOWN / SALES_STABLE` | sales GMV | prev ≥ `minSalesGmv` (500 k) | minor 15 / major 30 | positive |
| `ORDERS_UP / ORDERS_DOWN` | distinct orders | prev ≥ `minOrders` (5) | 15 / 30 | positive |
| `UNITS_UP / UNITS_DOWN` | units | prev ≥ `minUnits` (5) | 15 / 30 | positive |
| `ADS_SPEND_UP / _DOWN` | spend | prev ≥ `minAdsSpend` (100 k) | volume 20 / 50 | **neutral** (context-dependent) |
| `ADS_IMPRESSIONS_UP / _DOWN` | impressions | prev ≥ `minImpressions` (1 000) | 20 / 50 | positive |
| `ADS_CLICKS_UP / _DOWN` | clicks | prev ≥ `minClicks` (50) | 20 / 50 | positive |
| `ADS_ROAS_UP / _DOWN` | Σ broad GMV / Σ spend | spend ≥ `minAdsSpend` in **both** periods | 15 / 30 | positive |
| `ADS_CPC_UP / _DOWN` | Σ spend / Σ clicks | spend ≥ min and clicks ≥ `minClicks`, both periods | 15 / 30 | **negative** (CPC up is bad) |
| `ADS_CVR_UP / _DOWN` | Σ broad orders / Σ clicks | clicks ≥ `minRatioClicks` (100), both periods | 15 / 30 | positive |

Every ratio is a ratio of sums, never an average of daily ratios. Ads signals need at
least one single-item campaign. A shared campaign's spend cannot be split per item.

### Severity

| polarity of the move | severity |
|---|---|
| favourable or neutral | `INFO` |
| unfavourable, \|Δ%\| ≥ major **and** product is large (sales ≥ `scaleLargeGmv` 5 M; Ads spend ≥ `scaleLargeSpend` 500 k) | `WARNING` |
| unfavourable otherwise | `NOTICE` |

There is no CRITICAL level. For example, ROAS 0.1 → 0.2 (or −80 %) on 150 k spend is at most
a NOTICE.

### Confidence

Each signal starts at `HIGH` and drops one level for each of:

* **small sample:**
  * sales: orders (current + previous) < `highConfOrders` (30);
  * Ads ratios: clicks < `highConfClicks` (300) in either period;
* **stale source:** sales > 120 min, Ads > 90 min;
* **partial day.**

The floor is `LOW`. Every metric the engine uses has HIGH semantic confidence.

### Evidence (every signal)

```json
{ "type": "ADS_ROAS_DOWN", "family": "ads", "metric": "ads_broad_roas", "direction": "down",
  "polarity": "negative", "severity": "WARNING", "confidence": "HIGH",
  "current": 6.1, "previous": 9.4, "abs_change": -3.3, "change_pct": -35.1 }
```

### Data-quality signals (not performance problems)

* `SALES_DATA_MISSING`: the shop has never been read. Sales values are NULL, never 0.
* `SALES_INCOMPLETE`: the shop is not backfilled, or the period starts before `covered_from`. Values are a lower bound.
* `COMPARISON_UNAVAILABLE`, with one of three scopes:
  * `sales`: the previous period is not covered;
  * `period`: today has no completed hour yet;
  * `ads`: no previous hourly Ads rows.
* `PARTIAL_TODAY`: the period contains today.
* `DATA_STALE`: the sales or Ads read is older than the threshold.
* `ADS_DATA_MISSING`: the product has campaigns, but the shop has never had an Ads read.
* `SNAPSHOT_SEMANTICS_UNKNOWN`: a provider snapshot exists. Its meaning is unverified.

## 4. Product health

Health is a descriptive classification computed from the signals. It is not an ML score.
The first rule that applies wins:

| label (vi) | rule code | condition |
|---|---|---|
| INSUFFICIENT_DATA (Chưa đủ dữ liệu) | `no_comparable_data` | no sales comparison **and** no usable Ads comparison (spend ≥ min) |
| INSUFFICIENT_DATA | `low_volume` | sales < `minSalesGmv` **and** spend < `minAdsSpend` in both periods |
| WEAK (Yếu) | `sales_and_efficiency_down` | SALES_DOWN or ORDERS_DOWN at WARNING **and** ROAS↓ / CVR↓ / CPC↑ |
| WEAK | `sales_down_sharply` | SALES_DOWN WARNING with Δ ≤ −2 × major (−60 %) |
| WATCH (Cần theo dõi) | `warning_signals` | ≥ 1 unfavourable WARNING |
| WATCH | `multiple_notices` | ≥ 2 unfavourable NOTICEs |
| GOOD (Tốt) | `sales_growing` | SALES_UP or ORDERS_UP, no warning |
| STABLE (Ổn định) | `no_significant_change` | otherwise |

Each health output contains:

* `label`, `severity` (WEAK = WARNING, WATCH = NOTICE, others INFO);
* `confidence`: LOW without a sales comparison, otherwise the weakest of the top signals;
* `rule`, `basis` (`sales_and_ads` | `sales` | `ads` | `none`);
* counts of unfavourable warnings and notices;
* `top_signals`: up to 3 signals, unfavourable first, then by severity, then by |Δ%|.

The wording stays descriptive. It says "Doanh số/đơn giảm mạnh, đồng thời hiệu quả Ads
cũng kém đi", never "Ads caused the decline".

## 5. Attention priority (ranking for review)

```
signal_points = min(cap 60, 20 × unfavourable WARNINGs + 8 × unfavourable NOTICEs)
scale_points  = round(10 · log10(1 + (max sales + max Ads spend of the two periods) / 1 000 000))
score         = round(signal_points × (1 + scale_points / 10) × confidence factor)
                confidence factor: HIGH 1 · MEDIUM 0.75 · LOW 0.5
level         = HIGH ≥ 80 · MEDIUM ≥ 40 · LOW > 0 · NONE = 0
needs_attention = health ∈ {WATCH, WEAK} and score ≥ attentionMinScore (20)
```

The UI always shows the level in words. The full formula is available as a tooltip, for
example "76 điểm = 28 điểm tín hiệu bất lợi × (1 + 17/10 quy mô) × 1". The score is
never shown alone.

**Worked example (spec §28):**

* A product with 100 k sales and ROAS −80 % on 150 k spend has 1 NOTICE (8 points) and scale ≈ 1, at MEDIUM confidence. Score ≈ 7, so it does not need attention.
* A product with 50 M sales, orders −25 % (NOTICE) and ROAS −30 % (WARNING) has 28 points or more and scale ≈ 17. Score ≈ 76–123, so it needs attention.

## 6. Shop baseline context (not market claims)

For each shop and period, the engine computes:

* the median sales Δ% over sales-comparable products (prev ≥ min);
* the median Broad ROAS over products with spend ≥ min;
* how many comparable products have `SALES_DOWN`.

Product detail shows "product Δ − shop median" in percentage points and "product ROAS vs
shop median". The list page notes a shop-wide pattern only when ≥ 30 % of at least 5
comparable products declined, and it says so as a comparison within the shop. Nothing
mentions a market or demand.

## 7. Tests

* `product-intelligence.integration.test.ts` (local DB) covers:
  * §75 every signal case;
  * §76 every health label with rule, confidence and signals;
  * §77 a 500 % attribution case;
  * §28 priority ordering;
  * a config key missing → refused;
  * pagination, search, sort, filter and authorization;
  * shop with no sales → NULL;
  * the SQL coverage matches `coverage.ts`;
  * reads write nothing.
* `product-analytics.test.ts` covers:
  * the wording guards (no causal or market words, no forbidden attribution terms);
  * semantic tones (CPC↓ good, spend neutral);
  * every SQL-required config key present in `config.ts`;
  * no magic threshold inside `pa_intelligence_eval`.
