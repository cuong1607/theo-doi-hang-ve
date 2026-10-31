# Product Analytics architecture

Target: a user asks the Zalo OA "Tại sao sản phẩm ga chống thấm tuần này giảm doanh số?" and gets an evidence-based answer. **Phase SHOPEE-PRODUCT-ANALYTICS-1 builds only the foundation.** No canonical product analytics schema, no production AI diagnosis, no automatic alerts, no Shopee mutation.

## 1. Rules (permanent)

| Rule | Meaning |
|---|---|
| **SQL OWNS TRUTH** | Every number (sales, units, spend, ROAS, CPC, deltas, baselines) is computed in SQL / RPC from the canonical tables. The model never sums rows, never computes ROAS / CPC from raw rows, never decides which data is authoritative. |
| **CLAUDE OWNS INTERPRETATION** | The model only receives the aggregated `AnalystContext` (metrics, period comparisons, signals, data quality, metadata) and writes `AnalystOutput` (summary, findings with evidence, hypotheses, confidence, missing data, suggested checks). No `actions` field: analysis never changes anything. |
| **ZALO IS TRANSPORT** | The webhook verifies, parses, stores and dedupes. The conversation service authorizes and routes. The analyst returns generic content. Nothing analytical lives in `src/lib/zalo`. |
| READ ONLY | Shopee product / Ads access is read-only. Mutation permission is never inferred (`docs/shopee-ads-read-only-policy.md` still applies). |
| No raw SQL tool | No `execute_sql` / `raw_query`, no tool parameter that takes SQL or a free-form query (static guard in `conversation.test.ts`). |
| No raw data to the model | No raw order rows, hourly fact tables, API snapshots or SQL dumps. |
| Access re-checked by the backend | Every tool request carries `internal_user_id`, `shop_id` and `product_id`. The backend authorizes before any query; the model is not an authorization layer. |

## 2. Layers

```
Shopee APIs (READ ONLY)   Internal DB (orders, cost, stock)   Ads DB
            \                        |                         /
             └──────────── canonical metrics (future PA-2) ───┘
                                     │
                        SQL / RPC analysis layer (deltas, baselines)
                                     │
                     signal layer (rules, no AI): SALES_DOWN, CVR_DOWN …
                                     │
                     Product Analyst provider (future Claude)
                                     │
                     conversation service (authorize, context)
                                     │
                     Zalo OA transport (webhook + sendText)
```

What exists after phase 1:

| Layer | Status | Code |
|---|---|---|
| Product analytics discovery | Done. `get_item_extra_info` route verified; production values via the admin probe | `src/lib/channels/shopee/product-analytics/`, `/shopee/product-analytics/probe`, `scripts/shopee/product-analytics-discovery.ts` |
| Canonical metrics / signals | **Built (PA-2)**: sales facts, product identity, daily view, summary / list / daily / baseline RPCs, factual signals, data quality. See `docs/product-analytics-schema.md` and `docs/product-sales-facts-sync.md` | `supabase/migrations/00070_*`, `src/lib/product-analytics/` |
| Analyst provider | Interface + disabled provider (placeholder reply). No model call | `src/lib/product-analyst/provider.ts` |
| Conversation service | Done: dedupe, linking, shop authorization, context, deterministic router | `src/lib/conversation/` |
| Zalo transport | Done: signed webhook, outbound abstraction over `sendZaloTextMessage` | `src/lib/zalo/webhook*.ts`, `src/app/api/zalo/webhook/route.ts` |

## 3. Future tools (interfaces only)

`ANALYST_TOOL_DEFINITIONS`: `get_product_overview`, `compare_product_periods`, `get_product_sales_funnel`, `get_product_ads_performance`, `get_product_intraday`, `get_product_baseline`, `get_shop_baseline`, `get_product_cost_margin`. Each one:
- takes the scope (`internal_user_id`, `shop_id`, `product_id`) plus typed params only;
- returns aggregated JSON computed in SQL, with a `DataQuality` block (completeness, freshness per source, missing sources). The model must say so when data is incomplete.

The funnel tool may only expose stages the capability matrix marks VERIFIED or DERIVABLE (`docs/shopee-product-analytics-api.md` §8). Today that is sales / orders / units from internal orders and the Ads funnel; visitors, add-to-cart, product conversion and traffic source are Seller-Centre-only.

## 4. Output contract

`validateAnalystOutput()` enforces:
- `summary`;
- `findings[]`, each with **non-empty metric evidence** (e.g. `visitors -2%`, `orders -18%`, `CVR 3.8% → 3.1%`) and a confidence;
- `hypotheses[]` with a confidence;
- `evidence[]`, `confidence` (HIGH / MEDIUM / LOW), `missing_data[]`, `suggested_checks[]`;
- no other key (an `actions` field is rejected).

Hypotheses express correlation, never certain causation.

## 5. Cost and AI control (design)

- **Triggers:** user question, signal-triggered, or daily prioritized batch (≤ 20 products). Never "every N minutes, all 970 products" (`ANALYSIS_RUN_POLICY.scheduledFullCatalogueRuns = false`).
- **Usage tracking:** future `ai_usage_logs` rows shaped like `AiUsageRecord` (provider, model, input / output / cached tokens, estimated cost, duration, conversation id, analysis type). Not created yet.
- **Cache:** `analysisCacheKey(shop, product, intent, period, dataVersion, analysisVersion)`. `dataVersion` is a hash of the SQL-computed inputs, so unchanged metrics are not re-analysed.
- **Model:** configuration, not code. `AI_PRODUCT_ANALYST_PROVIDER=anthropic`, `AI_PRODUCT_ANALYST_MODEL=<configured>` (a Sonnet-class model is the intended default). `AI_PRODUCT_ANALYST_ENABLED` defaults to false. Even when set to true it only logs `enabled_but_not_implemented`, because no Claude provider exists in this phase.

## 6. PRODUCT-ANALYTICS-2 (built)

```
Shopee get_order_list / get_order_detail (READ ONLY, job product_sales_facts_read)
        ↓  whitelist projection (no buyer data, no raw payload stored)
shopee_product_sales_facts  (shop × order × line_item_id)
        ↓
shopee_product_daily_metrics (view: orders / units / sales GMV per VN day)
        ↑ shopee_ads_campaign_daily / hourly (single-item campaigns only)
        ↑ shopee_products (identity, independent of Ads) ← Ads enrichment, campaign links, order lines
        ↑ shopee_product_extra_snapshots (snapshot only, semantics UNKNOWN)
        ↓
product_analytics_summary / _list / _daily / _baseline / _freshness (RPC, service_role)
        ↓
/shopee/product-analytics (UI, DB only)   ·   agent-tools.ts (future analyst, not exposed)
```

Permanent rules added in this phase:
- **Attribution:** never `organic = total − broad Ads` (orders or GMV). `broad_gmv / sales_gmv` is exposed only as the "Ads attribution / total sales indicator", with a LOW semantic confidence. On real data it reaches 183% for one product, which shows it is not a share. A static test guards both rules.
- **Signals are facts:** `SALES_DOWN`, `ADS_SPEND_UP`, `DATA_STALE`, …; there is no rule that combines them into a cause. Thresholds live in `src/lib/product-analytics/config.ts` only.
- **Every metric carries metadata** (`PRODUCT_METRIC_META`): source, semantic confidence and a note. Sales GMV, orders, units and Ads metrics are HIGH; `views` / `sale` snapshots are UNKNOWN.
- **Agent tools** (`get_product_overview`, `compare_product_periods`, `get_product_sales_summary`, `get_product_ads_performance`, `get_product_baseline`) authorize in the backend: active profile + allowed role + explicit `ai_user_shop_access` grant + the product belongs to that shop. They return compact JSON (< 6 KB) with no order rows, no PII and no SQL. Claude is still disabled.
- The Zalo conversation resolves the product phrase against `shopee_products` of the authorized shop only (`resolveProductPhrase`, deterministic). It stores `ai_conversations.current_product_id`, which now has an FK to `shopee_products`.

## 7. Historical: PA-2 prerequisites (from Phase 1)

1. Production T0 / T1 probe rounds (`docs/shopee-product-analytics-api.md` §6, §9), plus the 3–7 day follow-up if one interval is not conclusive (§10), to settle the `sale` / `views` semantics.
2. **Do NOT re-enable the legacy sync** (`SHOPEE_AUTO_SYNC_ENABLED` / `SHOPEE_LEGACY_MODULES_ENABLED` stay off: they would resurrect orders, escrow, returns, payout and legacy products). Sales facts come from the new minimal `product_sales_facts_read` concept instead (§11 of the API doc, recommended option A).
3. Then design the canonical daily product metrics (minimal sales facts + Ads + optional extra-info snapshot deltas) with an explicit `DataQuality` per source.

---

## PA-3: unified product intelligence + signal layer

```
shopee_product_sales_facts ─┐                     (order lines, HOT/COLD/backfill, read-only Shopee)
shopee_ads_campaign_*  ─────┤                     (Ads canonical daily / hourly, single-item campaigns)
shopee_products ────────────┤  product_intelligence_rows   ← SQL OWNS TRUTH
shopee_product_extra_snaps ─┤        │  metrics + deltas (ratio of sums) + coverage + freshness
product_analytics_baseline ─┘        ▼
                              pa_intelligence_eval (pure)  ← thresholds = p_cfg (config.ts)
                                     │  signals · data-quality signals · health · priority
                                     ▼
              product_intelligence_list ── page / filter / search / sort + summary (1 round trip)
              product_intelligence_detail ─ one product, every signal + shop context
              product_signal_summary ────── summary only (agent / digest)
                                     ▼
              Next.js server components (labels only)   ·   agent tools (JSON < 8 KB)
                                     ▼
                       future Claude Product Analyst (interpretation; NOT in PA-3)
```

### Layers

| layer | where | owns |
|---|---|---|
| Canonical facts | migrations 00064–00070 | order facts, Ads facts, product identity, snapshots |
| Intelligence | `00071_product_intelligence.sql` | per-product metrics for the period and the previous comparable period, sales coverage (mirrors `coverage.ts`), freshness, signals, health, priority, shop medians, hero totals |
| Config | `src/lib/product-analytics/config.ts` | every threshold, passed as `p_cfg`; the SQL refuses a missing key |
| Read model | `intelligence.ts`, `read-model.ts` | typed RPC calls; no business math |
| Wording | `signals.ts`, `display.ts` | Vietnamese labels, health reasons, priority explanation, "—" / "≥" rules |
| UI | `src/components/product-analytics/*`, `app/(authenticated)/shopee/product-analytics/*` | rendering in the Ads design language |
| Agent tools | `agent-tools.ts` | authorized, compact, typed outputs (incl. `get_product_signals`) |

### Unified model (`ProductIntelligence`)

* **identity:** id, shop, item id, name, SKU, image, status
* **period:** from / to; previous from / to; hour cutoff; partial today
* **sales:** gmv, orders, units (current + previous), gmv_pct, orders_pct
  * The values are NULL when the shop has no sales data.
  * The pct fields are set only when both periods are covered.
* **ads:** campaigns, shared campaigns, spend, impressions, clicks, broad / direct orders and GMV, broad ROAS (current + previous), spend_pct, roas_pct
* **coverage:** sales_state, covered_from, sales_exact, sales_comparable, ads_comparable
* **intel:** `pa_intelligence_eval`. It holds signals[], data_quality[], top_signals[], health, priority and needs_attention.
* **baseline:** `product_analytics_baseline` gives mean, median, p25, p75, stddev and CV over the 7 / 30 completed days before the period.
* **shop context:** shop medians of Δ sales and Broad ROAS, plus the product's distance from them.

The model is a set of read functions. No table duplicates the facts.

### Server-side list

`product_intelligence_list(shops, period…, cfg, q, ads, status, health, signal, sort, dir, page, page_size, with_summary, top)`
does everything in one round trip:

* builds the rows once (`MATERIALIZED`);
* filters:
  * accent-insensitive search (`pa_fold`: NFD, strip marks, đ→d) over name, SKU and item id;
  * Ads presence, status;
  * health (or `ATTENTION`), signal type;
* sorts by priority, gmv, gmv_pct, orders, units, spend, broad_roas, roas_pct or name;
  nulls go last and ties are stable;
* clamps the page to the last page, and the page size to 100;
* returns 50 rows by default.

The summary comes from the same CTE:

* health counts, plus sales-declining / sales-growing / Ads-efficiency-declining counts;
* top attention products and per-shop medians;
* **hero totals at shop level:** DISTINCT orders across products, and Ads from the shop-level
  table. Shops without any sales data are left out of the sales totals and named in a notice.

#### Performance (local replica of production: 5 shops, 1 087 products, 31.9 k fact lines)

| read | before (PA-2) | PA-3 |
|---|---|---|
| list RPC, all shops | 705 KB, 1 153 rows (filtered in JS) | page 1 + summary ≈ 114 KB, 50 rows |
| list page 1 + summary | — | ≈ 350 ms (local Docker) |
| list page 2 (no summary) | — | ≈ 310 ms |
| detail page reads (4 RPCs in parallel) | — | ≈ 200 ms |

The engine went from about 0.22 to about 0.15 ms per product, after its tallies moved from SPI queries to in-memory loops.

### Agent readiness

| tool | answers |
|---|---|
| `get_product_overview` | what the product did (+ health, top signals) |
| `compare_product_periods` | which metrics changed, with evidence |
| `get_product_signals` | how significant (severity, priority), how sure (confidence, data-quality signals), shop context |
| `get_product_sales_summary` / `get_product_ads_performance` | the numbers + semantics + attribution warning |
| `get_product_baseline` | is this move unusual vs history (median, CV) |

Each tool output stays under 6 KB. Overview + compare + signals together stay under 8 KB.
Outputs contain no raw fact rows, no PII and no SQL. No Claude call exists in PA-3, and the
Zalo agent stays off.

### HOT sync optimisation — discovery only (spec §71–72)

**Current production load** (2026-10-31, after all 5 shops were enabled):

| shop | orders updated in 48 h | in last 90 min | calls / HOT cycle (list + detail) | reread rows unchanged |
|---|---|---|---|---|
| HOMIES | 1 246 | 66 | 38.5 | 96.0 % |
| congtrangbedding | 1 196 | 80 | 36.6 | 95.6 % |
| congtrang carpet | 377 | 23 | 12.0 | 96.1 % |
| CTV | 206 | 17 | 8.0 | 95.8 % |
| RUGLUX | 172 | 13 | 6.0 | 95.5 % |

That is about 101 calls per round of 5 shops and about 4 850 calls a day at 48 rounds. Rate limits from product sync: 0.

**Can `get_order_list` skip unnecessary details?** Not by itself.

* The reader requests only `order_sn`.
* The documented optional field of `get_order_list` is `order_status`, not `update_time`
  or item data.
* A status-unchanged filter would miss quantity / cancellation changes that keep the same
  status, so it is unproven and unsafe.

**Promising option: an incremental HOT window.**

* Every 30 min, read `update_time ∈ [last successful HOT window end − overlap, now]` instead of the last 48 h.
* The list already filters on `update_time`, so every order changed since the last run still appears.
* `channel_sync_states.last_window_to` already exists as the watermark.
* With a 60 min overlap the window is about 90 min. That is 13–80 orders per shop, so 1 list call + 1–2 detail calls per shop: about 12 calls per round instead of about 101 (**−88 %**, about 580 calls a day).

**Risks:**

* A failed or skipped run leaves a gap. The fix is to advance the watermark only on success and widen the next window.
* Shopee `update_time` might lag the change. The fix is the overlap.
* Clock skew.
* COLD (8 days, twice a day) stays as the safety net and catches anything missed.

**Proof required before changing production:**

1. A shadow run for ≥ 3 days: compute the incremental window's order set next to the current 48 h set and confirm that every fact change the 48 h read produced is covered.
2. A replay test of the watermark under failure, retry and long gaps.
3. A unit test on window planning.

Until then, the production algorithm is unchanged. Ads HOT priority (2–5) stays above product HOT (6); global concurrency is unchanged; the freshness target stays < 45 min (observed: 7–32 min).
