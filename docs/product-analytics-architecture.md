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
