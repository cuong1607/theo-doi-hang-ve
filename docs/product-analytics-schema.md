# Product analytics schema (PRODUCT-ANALYTICS-2, migration 00070)

**SQL owns truth, AI owns interpretation.** This schema holds trusted product-level facts. It contains no diagnosis logic and makes no model call.

## 1. Tables

| Table | Grain / unique key | Written by | Notes |
|---|---|---|---|
| `shopee_products` | `(shop_id, provider_item_id)` | triggers + sales-facts RPC | Canonical identity, **independent of Ads**. `metadata_source`: `ads_enrichment` (current, from `get_item_base_info`) wins over `order_line` (the name as sold). Seeded non-destructively from `shopee_ads_products` and `shopee_ads_campaign_products`. Triggers keep it in sync. |
| `shopee_product_sales_facts` | `(shop_id, provider_order_id, provider_line_item_id)` | `upsert_shopee_product_sales_facts` | One row per **order line**. See §2. |
| `shopee_product_extra_snapshots` | `(shop_id, provider_item_id, captured_at)` | job `product_extra_info_read` | `sale`, `views`, `likes`, `rating_star`, `comment_count` exactly as returned. **Snapshot only**: semantics UNKNOWN (Phase 1P), never turned into daily facts, no period delta. Retention 90 days. |
| `product_analytics_shop_settings` | `shop_id` | admin actions, scheduler | `sales_sync_enabled` / `extra_info_enabled` (default **false**), `sales_backfill_done_at`, slot bookkeeping. |

**RLS:** all four tables have RLS on. `authenticated` users can SELECT only when `is_active_user()`. Only `service_role` writes. `anon` has no access. Grants are explicit, because cloud has no default grants.

**Indexes:**
- facts: the unique key (which also serves `provider_order_id` lookups per shop), `(shop_id, provider_item_id, report_date)`, `(shop_id, report_date)`;
- products and snapshots: their unique keys only.

These were measured before adding anything else (§5).

## 2. Sales fact semantics (verified on real payloads)

Basis: 7 492 stored production `get_order_detail` payloads (2 121 orders, 2026-10-01 → 10-28, 3 shops), analysed SELECT-only, then mapped by the new mapper. Result: 2 121 / 2 121 mapped, 0 issues, 0 PII keys.

| Column | Meaning |
|---|---|
| `provider_line_item_id` | `line_item_id`, unique inside an order (0 duplicates). `(order, item, model)` is **not** unique (11 cases: gift / add-on lines of the same model), and `order_item_id` is shared by bundle lines (221 cases). |
| `provider_model_id` | NULL when the item has no variation (`model_id` 0 / missing). |
| `order_status`, `status_class`, `is_cancelled`, `is_completed`, `is_valid_for_sales` | From `classifyProductSalesOrderStatus()`, see §3. |
| `order_created_at` / `report_date` | `create_time`. `report_date` = VN business date (`Asia/Ho_Chi_Minh` = UTC+7, same as Asia/Bangkok), computed in SQL. |
| `quantity`, `cancelled_qty`, `returned_qty` | `model_quantity_purchased`, `cancelled_qty` and `returned_qty` of the line. |
| `unit_original_price`, `unit_discounted_price` | NUMERIC, exactly as returned. `model_discounted_price` is a **unit** price: with qty > 1 it never exceeds the original unit price. |
| `gross_amount` | `unit_discounted_price × quantity`, i.e. the **item subtotal before shop / platform vouchers and shipping**. It is not the amount the buyer actually paid. |
| `is_free_gift` | `promotion_type = add_on_free_gift_sub` (42 real lines, usually 0 VND). |
| `valid_quantity`, `valid_amount` | What the metrics add up: `quantity − cancelled_qty` and its amount when the line is valid for sales and not a free gift, otherwise 0. |
| `source_updated_at` | Order `update_time`. An upsert only applies when it is ≥ the stored one, so an old read never overwrites a newer one. |

**Money:**
- Values are NUMERIC end to end.
- The mapper passes decimal **strings** (`toDecimalString`), and the database does every multiplication and sum.
- JS never aggregates money. A test proves a NUMERIC sum of 0.1 + 0.2 gives 0.3, while a JS float sum would not.

**Unsupported, not faked:**
- refund / voucher-adjusted **net sales**: `total_amount` (it includes shipping and vouchers) is not allocated per item by the endpoint, and there is no `net_amount` column;
- returns are not netted, because the legacy returns module stays retired.

**Privacy:**
- The mapper is a whitelist (`PRODUCT_SALES_FACT_KEYS`).
- `message_to_seller` and any buyer, recipient or phone field are dropped.
- No raw order payload is stored by this flow.

## 3. Status semantics (`src/lib/product-analytics/sales-status.ts`)

| Status | Class | Counts toward orders / units / GMV |
|---|---|---|
| READY_TO_SHIP, PROCESSED, RETRY_SHIP, SHIPPED, TO_CONFIRM_RECEIVE | open | yes |
| COMPLETED | completed | yes |
| TO_RETURN | return_in_progress | yes (gross: the return is not netted) |
| UNPAID | pending_payment | no |
| IN_CANCEL | cancel_pending | no (conservative) |
| CANCELLED | cancelled | no, but the row is **kept**; `cancelled_orders` is reported separately |
| anything else | unknown | no |

`pay_time` is not used as a criterion: COD orders never pass through UNPAID (477 real orders have no `pay_time`).

## 4. Views and RPCs

| Object | Purpose |
|---|---|
| `shopee_product_daily_metrics` (view) | shop × item × report date: `orders` = COUNT DISTINCT order with a counted line, `units_sold` = Σ `valid_quantity`, `sales_gmv` = Σ `valid_amount`, plus `cancelled_orders`. |
| `shopee_product_campaign_links` (view) | campaign ↔ item, with `single_item`. **Product Ads = single-item campaigns only**. A shared campaign's spend cannot be split per item from campaign reports, so it is counted in `shared_campaigns_excluded`. Production: 1 927 / 1 928 campaigns are single-item, carrying 100% of spend. |
| `product_analytics_summary(shop, item, from, to, prev_from, prev_to, hour_cutoff)` | jsonb: identity, sales and Ads deltas (`current`, `previous`, `abs`, `pct`, all in SQL), ratio-of-sums CPC / CTR / direct + broad ROAS / CVR, the attribution indicator, and the latest snapshot. `hour_cutoff` = same-time comparison: orders created before HH:00, and Ads from the hourly table with hour < HH. |
| `product_analytics_list(shops, from, to, prev_from, prev_to)` | One jsonb array of every product with sales or Ads in either period, or with a current single-item campaign. Never subject to the 1000-row cap. |
| `product_analytics_daily(shop, item, from, to)` | Every day of the range (zero-filled): sales and Ads. |
| `product_analytics_baseline(shop, item, from, to)` | mean / median / p25 / p75 / total per metric (percentiles in SQL). |
| `product_analytics_freshness(shops)` | sales last success, backfill marker, active jobs, fact coverage, extra-info freshness. |
| `upsert_shopee_product_sales_facts(shop, rows)` | Idempotent fact upsert plus order-line identity. |

All RPCs are `service_role` only. The **server authorizes before calling**:
- pages require `channel:view`;
- agent tools check the internal user, role, `ai_user_shop_access` and that the product belongs to the shop.

A `shop_id` coming from the frontend is never trusted on its own. Identity is always `shop_id + provider_item_id`: the same item id in two shops is two products, and nothing joins across shops (tested).

**No organic metric exists:** `total − broad Ads` is never computed (static test).

## 5. Performance (local replica of real production data)

The replica holds 5 shops, 1 004 listed products, 62 k Ads daily rows, 99 k hourly rows and 2 641 fact lines. Median of 5 runs:

| Read | Measured | Target |
|---|---|---|
| single product summary, 30 d | 16 ms | < 200 ms |
| daily, 30 d | 9 ms | — |
| shop list, CTV, 30 d | 91 ms | < 500 ms |
| list of all 5 shops, 30 d | 248 ms | < 1 s |

Cloud adds network latency. No extra index was needed.
