# Shopee Ads — canonical data model (SHOPEE-ADS-1B)

**Migration:** `supabase/migrations/00064_shopee_ads_canonical.sql`. It is applied **locally only**; it is not on cloud.

**Source of truth for field meanings:** [shopee-ads-api.md](shopee-ads-api.md) §3 and §3.5, which are verified from production payloads.

> ## Three rules that must never be broken
> 1. **Shop total ≠ Σ campaigns.** The shop-level "all CPC ads" total is larger than the sum of all product campaigns. This was verified on 27/10 with full coverage of 143/143 campaigns: spend 1,104,162 vs 1,072,671. Shop facts therefore have their **own table**.
>    - The dashboard overview, previous period and trend read **only** the shop table.
>    - The campaign table reads **only** the campaign tables.
> 2. **Shopee's campaign `cpc` field is not cost per click.** It equals `expense / broad_order`. It is never stored and never shown. The UI CPC is always `Σ expense / Σ clicks`.
> 3. **Broad and Direct are Shopee's attribution metrics.** They are never "shop revenue" or "the shop's order count". Labels are always "Doanh số Broad", "Đơn Direct" and so on.

## Tables

### `shopee_ads_campaigns`
One row per (shop, provider campaign). Unique key: `(shop_id, provider_campaign_id)`.

| column | from (Shopee) | notes |
|---|---|---|
| `provider_campaign_id` text | `campaign_id` | 64-bit ids are kept as text, never as a JS number |
| `campaign_name` | `common_info.ad_name` | |
| `provider_status` | `common_info.campaign_status` | Raw value. Verified: `ongoing` / `paused` / `closed` / `ended`. Unknown future values are stored as-is. |
| `provider_ad_type` | `common_info.ad_type` | Raw (`manual`). |
| `provider_bidding_method` | `common_info.bidding_method` | `auto` / `manual`. |
| `provider_placement` | `common_info.campaign_placement` | `all` / `search` / `discovery`. |
| `daily_budget` numeric | `common_info.campaign_budget` | A **daily** cap (verified by behaviour). 0 is kept as-is; its meaning is unknown and the UI shows "—". |
| `roas_target` numeric | `auto_bidding_info.roas_target` | Only for auto bidding; NULL otherwise. The meaning of 0 is unknown and the UI shows "—". |
| `provider_start_at` / `provider_end_at` | `campaign_duration.start_time` / `end_time` | Epoch **seconds** (verified). `end_time` 0 is stored as NULL (no end date). Values that look like milliseconds are refused. |
| `last_synced_at` | — | When the read job wrote the row. |

Index: `(shop_id, provider_status)`. The unique key already covers `(shop_id, provider_campaign_id)`. There is also an extra unique `(id, shop_id)` that serves as the target of composite FKs.

### `shopee_ads_campaign_products`
Campaign ↔ advertised item, from `common_info.item_id_list`.
- Unique key: `(campaign_id, provider_item_id)`.
- Composite FK `(campaign_id, shop_id)` → `shopee_ads_campaigns`, so a link can never cross shops.
- `item_name_snapshot` stays NULL: the Ads API returns no item names. The legacy product sync is **not** used.
- Today every verified campaign has exactly 1 item; the table supports N.

### `shopee_ads_campaign_daily_performance`
Grain: **campaign × report_date**. Unique key: `(campaign_id, report_date)`; index `(shop_id, report_date)`. Composite FK to the campaign (same shop).

### `shopee_ads_shop_daily_performance`
Grain: **shop × report_date**, an independent fact. Unique key: `(shop_id, report_date)`.

### Primitive metrics (both fact tables)

| column | shop row (`get_all_cpc_ads_daily_performance`) | campaign row (`get_product_campaign_daily_performance`) |
|---|---|---|
| `report_date` date | `date` "DD-MM-YYYY" → DATE, parsed strictly, shop-local date as returned | same |
| `expense` numeric | `expense` (integer VND, rounded by Shopee) | `expense` |
| `impression` bigint | `impression` | `impression` |
| `clicks` bigint | `clicks` | `clicks` |
| `direct_order` / `broad_order` bigint | `direct_order` / `broad_order` | same |
| `direct_gmv` / `broad_gmv` numeric | `direct_gmv` / `broad_gmv` | same |
| `direct_item_sold` / `broad_item_sold` bigint | `direct_item_sold` / `broad_item_sold` | `direct_order_amount` / `broad_order_amount` (≈ units sold, LIKELY) |

**Not stored** (they remain available in the raw snapshots): every provider ratio, i.e. `ctr`, `*_roas`, `*_conversions`, `cost_per_conversion`, `*_roi`, `*_cir`, `cr`, `direct_cr`, `cpc`, `cpdc`. They are all derivable from the primitives and are rounded by Shopee.

**Money:** NUMERIC(18,2), integer VND (đồng). There is no currency column: Shopee returns none. Currency is inferred from `shops.region = VN`. The dashboard refuses to add up shops from different regions.

## ADS-2 additions (migration `00065_shopee_ads_scheduler.sql`, local only until reviewed)
- **`shopee_ads_campaigns.status_changed_at`:** set by a trigger when `provider_status` changes. It stays NULL on first sight, because the onboarding backfill already covers today. It keeps recently paused / ended campaigns in the HOT / WARM candidate sets.
- **`shopee_ads_shop_settings`** (one row per shop) holds scheduler configuration only, no Ads data:
  - `ads_sync_enabled` (default false)
  - optional `sync_slot` (0–9)
  - the scheduler's slot bookkeeping `last_{hot_shop,hot_campaign,warm,cold,metadata}_slot_at`
- **`channel_sync_jobs.lane`** (generated) makes the active-job unique key shop + sync_type + lane.
- **RPCs** (all `service_role` only):

  | RPC | access | purpose |
  |---|---|---|
  | `enqueue_ads_sync_job` | writes `channel_sync_jobs` only | enqueue with dedupe + coalescing |
  | `claim_next_sync_job` v3 | — | gains `p_max_running_ads` |
  | `ads_sync_freshness` | read | dashboard freshness |
  | `get_ads_sync_metrics` | read | SLA metrics |

## ADS-2.1 additions (migration `00066_shopee_ads_backfill_markers.sql`)
- **`shopee_ads_shop_settings.shop_backfill_completed_at` / `campaign_backfill_completed_at`:** set when a BACKFILL job of that type finishes. The scheduler and the manual refresh re-run the 30-day backfill until the marker is set. A later HOT success no longer counts as a backfill: that bug left congtrangbedding without campaign data for 6–25/10. The migration seeds the markers from successful backfill jobs, or from stored data covering ≥ 28 days.
- **`shopee_ads_campaigns.performance_unsupported_at`:** Shopee rejects a whole performance batch when one id is not a product-ads campaign. Seen 2026-10-29 on campaign 20932764, the only `ad_type = auto` campaign of 1135. The runner drops such ids, re-reads the batch and records them here; later jobs never send them again.
- **Dashboard RPCs are read in ordered pages of 1000.** PostgREST caps every response at 1000 rows, RPCs included. With five shops (~1,900 campaigns) the campaign table was silently truncated, and "Ngoài chiến dịch sản phẩm" was inflated.

## Raw snapshots
- Stored in the existing `channel_api_snapshots` with `entity_type = 'ads'` and `api_name` = the endpoint path.
- The key is the request shape (e.g. `campaign_daily:2026-10-21:2026-10-27:<first id>:<n>`).
- An identical payload only refreshes `synced_at`.
- Retention follows the existing `prune_channel_api_snapshots` (latest kept, history pruned after the default period).
- Payloads go through `sanitizeAdsPayload`, which drops credential-like keys.

## RLS / grants
The access model matches the other channel tables:
- RLS is enabled.
- `authenticated`: SELECT only, with policy `is_active_user()`.
- `anon`: nothing.
- `service_role`: full access, granted explicitly because cloud has no default grants.

Writes come only from the read-only sync worker (service role).

## Dashboard RPCs (server-side aggregation)
Both RPCs exist because PostgREST caps responses at 1000 rows. EXECUTE is granted to `service_role` only.

| RPC | returns |
|---|---|
| `ads_dashboard_shop_daily(shop_ids[], from, to)` | Shop primitives per day, summed across the selected shops |
| `ads_dashboard_campaigns(shop_ids[], from, to)` | Every campaign of the selected shops with summed primitives, its daily spend / broad GMV series, and its item ids |

## Derived metrics (always ratio-of-sums: `deriveMetrics` on summed primitives)

| UI | formula |
|---|---|
| CTR | clicks / impressions |
| CPC | expense / clicks |
| ROAS Broad / Direct | broad_gmv / expense, direct_gmv / expense |
| ACOS Broad / Direct | expense / broad_gmv, expense / direct_gmv |
| CVR Broad / Direct | broad_order / clicks, direct_order / clicks |
| Ngoài chiến dịch sản phẩm | shop primitives − Σ campaign primitives (same range) |

A ratio with a denominator of 0 is null and shown as "—". Row-level ratios are never averaged. All-shop views sum the shop primitives first and derive afterwards.
