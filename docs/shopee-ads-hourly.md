# Shopee Ads — hourly TODAY intraday analytics (SHOPEE-ADS-3A.1)

**READ ONLY.** Hourly reads are GET calls to two allowlisted read endpoints, made only by the queue worker. Nothing is written to Shopee. See [shopee-ads-read-only-policy.md](shopee-ads-read-only-policy.md).

Hourly data is an **extra layer** next to the daily pipeline. It does not replace or change it:

- HOT every 15 min, WARM hourly, COLD 2×/day and metadata every 6 h are unchanged.
- Daily facts stay canonical for every day, 7-day and 30-day number, and for the TODAY overview KPI.
- Hourly rows are for TODAY's intraday breakdown and for reconciling YESTERDAY.

## Grain and tables

Migration: `supabase/migrations/00067_shopee_ads_hourly.sql`. Applied **locally only** until the final report is reviewed.

| table | grain | unique key | indexes |
|---|---|---|---|
| `shopee_ads_shop_hourly_performance` | shop × report_date × hour | `(shop_id, report_date, report_hour)` | `(shop_id, report_date)` |
| `shopee_ads_campaign_hourly_performance` | campaign × report_date × hour | `(campaign_id, report_date, report_hour)` | `(shop_id, report_date)`, `(campaign_id, report_date)` |

- **Hour:** `report_hour` is a smallint with `CHECK 0–23`.
- **Shop isolation:** the campaign table has the composite FK `(campaign_id, shop_id)` → `shopee_ads_campaigns (id, shop_id)`, as in ADS-1B. An hourly row can never point at another shop's campaign.
- **Columns:** the same primitives as the daily tables (`expense`, `impression`, `clicks`, `direct_order`, `broad_order`, `direct_gmv`, `broad_gmv`, `direct_item_sold`, `broad_item_sold`) plus `last_synced_at`.
  - Campaign `*_item_sold` comes from `*_order_amount`, as in the daily table.
  - Provider ratios are **not** stored.
- **RLS:** active users can SELECT. There are no client writes. `service_role` has explicit grants.
- **Raw payloads:** stored in the existing `channel_api_snapshots` (entity `ads`) under the keys `shop_hourly:<date>` and `campaign_hourly:<date>:<first id>:<n>`. There is no separate hourly raw table.

## Provider endpoints (verified in production, ADS-1A)

| method | endpoint (GET) | params | limits |
|---|---|---|---|
| `getAllCpcAdsHourlyPerformance` | `/api/v2/ads/get_all_cpc_ads_hourly_performance` | `performance_date` DD-MM-YYYY | one date per call |
| `getProductCampaignHourlyPerformance` | `/api/v2/ads/get_product_campaign_hourly_performance` | `performance_date` + `campaign_id_list` | one date, ≤ 50 ids per call |

- **Captured shape:** for a completed day the shop endpoint returns 24 rows (`hour` 0–23). The campaign endpoint returns 24 `metrics_list` rows per campaign, zero hours included.
- **Mapper (`parseShopHourlyPerformance` / `parseCampaignHourlyPerformance`):**
  - Refuses an hour outside 0–23, a bad date, a duplicate (date, hour) and negative values.
  - Refuses daily rows, just as the daily parsers refuse hourly rows.
  - A bad campaign fails alone; the rest of the batch is kept.
- **Not seen yet in production:** what Shopee returns for TODAY's future hours. The sync never stores them (see below) and counts them in `stats.futureHours`. The first production runs will show whether they arrive as zero rows or are omitted.

## Jobs, cadence, priority

| job | strategy | when | range | campaigns | priority | lane |
|---|---|---|---|---|---|---|
| `ads_shop_hourly_read` | hot | every HOT slot (15 min) | today | — | 4 | `ads_hot` |
| `ads_campaign_hourly_read` | hot | every HOT slot | today | HOT candidates | 5 | `ads_hot` |
| both | manual | "Làm mới dữ liệu" | today | all | 2 (after every manual daily slice at 1) | `ads_hot` |
| both | finalize | once a day after `ADS_HOURLY_FINALIZE_TIME` (02:30, shop-local) | yesterday | **all** | 8 | `ads_warm` |

Full order: manual 1 · HOT shop 2 · HOT campaign 3 · hourly shop 4 · hourly campaign 5 · WARM 6 · metadata 7 · COLD 8 (finalize 8) · backfill 9.

- **No new scheduler.** The hourly slot (`last_hot_hourly_slot_at`) uses the same 15-minute boundary and stagger offset as HOT. The finalize slot is `last_hourly_finalize_slot_at`.
- **Daily first:**
  - Hourly jobs rank below both daily HOT jobs.
  - While a daily HOT read from an **earlier** slot is still active, the hourly slot is left unclaimed (`hourlyDeferred` in the tick result) and the next heartbeat retries it.
- **HOT candidates:** the same DB rule as the daily HOT read (ongoing, + status changed or ended within 36 h, + non-zero today). If the catalogue is older than 8 h, all campaigns are read.
  - **Accuracy pass:** the daily finalize reads **all** campaigns for yesterday.
- **Catalogue first:** campaign hourly waits for the first complete catalogue (`ads_campaigns_pending`, retry) and drops "not a product-ads campaign" ids, exactly like the daily read.
- **Switches:** all three are needed.
  - `ADS_HOURLY_SYNC_ENABLED` (global, default **false**).
  - `shopee_ads_shop_settings.ads_hourly_enabled` (per shop, default **false**; admin panel "Bật theo giờ").
  - The existing `ADS_AUTO_SYNC_ENABLED` + `ads_sync_enabled` for the scheduler.
- **Manual refresh:** also enqueues today's hourly reads, but only when both switches are on and today's hourly rows are older than `ADS_MANUAL_DEDUPE_MINUTES`. The button does not wait for them.

## TODAY semantics

- **Date and hour:** the shop's timezone (`Asia/Ho_Chi_Minh`), the provider's reporting date and hour. Never derived from UTC.
- **Current hour:** partial. It is upserted on every read; earlier hours of the day may be restated too. The chart marks it "Đang diễn ra" with a dashed band and a dashed last segment.
- **Future hours:** never stored (dropped and counted) and never drawn. The x-axis runs 00h → current hour.
- **Missing hour:** a gap. The line breaks and the table shows "Chưa có số liệu". It is never filled with 0 and never synthesized from daily data.
- **All shops:** shop primitives are summed per (date, hour) and ratios derived afterwards. An hour that only some shops have so far is flagged in the tooltip ("Mới có x/y shop"). Mixed regions are refused, as on the rest of the dashboard.
- **Ratios:** ratio-of-sums (`deriveMetrics`).
  - CPC = spend / clicks. Shopee's campaign `cpc` is expense / broad_order and is never used.
  - CTR = clicks / impressions.
  - ROAS / ACOS / CVR are each computed separately for Broad and Direct.
- **Same-hour yesterday:** today 00h → the last **completed** hour vs the same hours of yesterday. It is shown only when yesterday has every one of those hours, and its colouring is neutral (no good / bad).
- **Peaks** ("Khung giờ … cao nhất") are observational:
  - completed hours only, ≥ 3 completed hours required;
  - the ROAS peak needs ≥ 10 % of the spend so far and ≥ 10 clicks;
  - no action is ever suggested.
- **Freshness:** "Cập nhật theo giờ X phút trước" is the oldest latest write among the selected shops with rows today. Target ≤ `ADS_HOURLY_FRESH_TARGET_MINUTES` (25); stale after `ADS_HOURLY_STALE_MINUTES` (35).
- **Empty states:** hourly not enabled for the selected shop(s), no rows yet today, or not readable. "Not readable" covers e.g. code deployed before the migration: the rest of the dashboard keeps working.

## Reconciliation (hourly Σ vs daily)

RPC `ads_dashboard_hourly_reconciliation(shop_ids, from, to)` returns, per shop × date:

- Σ hourly shop primitives next to the daily shop row;
- a campaign comparison: Σ hourly per campaign vs its daily row, for campaigns that have hourly rows that day.

The status is decided by `adsHourlyReconciliation` (strictest first):

| status | rule |
|---|---|
| `IN_PROGRESS` | the date is today. The day is not over and the endpoints refresh at different moments, so this is never an anomaly. |
| `MISMATCH` | any count or GMV differs (shop or any campaign), or \|Δ expense\| > 24 đ |
| `INSUFFICIENT_DATA` | no daily row, < 24 shop hours, or a campaign with < 24 hours |
| `ROUNDING_DIFFERENCE` | only expense differs, within 24 đ |
| `MATCH` | identical |

**Expense tolerance: 24 đ.**
- Shopee rounds `expense` to a whole đồng per row, so Σ 24 rounded hours may differ from the rounded day by less than 24 × 1 đ.
- Verified on 27/10 with production fixtures: shop Σ hourly 1,104,161 vs daily 1,104,162 (−1 đ); campaign 900000040 299,998 vs 300,000 (−2 đ). Counts and GMV were exact.
- Anything above the tolerance is reported, never hidden.

**Where the status appears:**
- the finalize job's `metadata.reconciliation` and `stats.reconciliation.<STATUS>`;
- the admin panel ("Đối chiếu hôm qua");
- the dashboard footnote.

> Late attribution can change yesterday's daily row (WARM re-reads it every hour) after finalize has read the hourly rows. A later `MISMATCH` on counts can therefore mean "the daily row was restated after finalize". Check the WARM restatement log before suspecting the hourly data.

## Retention

- `prune_shopee_ads_hourly(retention_days, limit)` is called by the existing retention run (`pruneRetention`, every scheduler tick).
- It removes rows whose report date is older than `ADS_HOURLY_RETENTION_DAYS` (default 14), up to 5,000 rows per table per call.
- The retention is clamped to ≥ 2 days, so today and yesterday are never deleted.
- The worker itself never deletes hourly rows.

## Capacity

**Measured in the 5-shop simulation** (`ads-hourly.integration.test.ts`):
- Production campaign profile: 143 / 108 / 246 / 1135 / 294 campaigns, 30 % ongoing.
- Ads concurrency unchanged at 2.

| | daily HOT | hourly | total |
|---|---|---|---|
| calls per 15-min cycle | 18 | 18 | 36 |

- The daily HOT cycle was not slower with hourly queued: about 1.8 s → 1.5 s at 60 ms per simulated call. The run-to-run difference is noise; the point is that hourly does not delay daily.
- A few hourly jobs start before the last daily HOT job ends. They only use a slot that a shop's per-shop cap would otherwise leave idle, and never delay a daily read.

**Production (cloud, read-only measurement 2026-10-29).** Ongoing campaigns: CTV 44, RUGLUX 45, HOMIES 72, congtrangbedding 176, carpet 46.
- Daily HOT today is 14 calls per cycle; hourly adds ≈ 14 more (5 shop + 9 campaign batches).
- Per-job execution is 4–8 s (46 s for congtrangbedding's 4-batch campaign job).
- The whole cycle grows from ≈ 1 to ≈ 2 minutes of worker time inside the 15-minute window. That is a comfortable margin; concurrency does not need to change.

## Rollout

1. Push migration 00067 to cloud (00066 is already there, checked 2026-10-29). Then run `NOTIFY pgrst, 'reload schema'`: there are new tables, new RPCs and a replaced `enqueue_ads_sync_job`.
2. Deploy with `ADS_HOURLY_SYNC_ENABLED=false` and check that the daily system is unchanged.
3. Set `ADS_HOURLY_SYNC_ENABLED=true` and enable "Theo giờ" for **CTV Bedding** only. Observe several cycles:
   - hourly freshness ≤ 25 min;
   - daily HOT p95 unchanged (admin panel);
   - `stats.futureHours` / `missingHours`;
   - the next day's reconciliation.
4. Enable a second shop, then the rest — not all at once.

## Tests

- **`ads-hourly.test.ts`** (pure): mapper on the production fixtures, hour / date parsing, future hours, gaps, zero hours, CPC regression, ratio-of-sums, reconciliation statuses and tolerance, same-hour yesterday, peaks, scheduler plan, priorities, config, provider limits.
- **`ads-hourly.integration.test.ts`** (local DB):
  - idempotency and current-hour updates (same row), batching (no per-campaign loop), multi-shop isolation + composite FK;
  - finalize + reconciliation on 27/10;
  - no-browser scheduler → worker → dashboard, page load = 0 calls / 0 jobs;
  - backlog deferral, queue priority, manual dedupe, retention, 5-shop capacity.
- **`scripts/e2e/shopee-ads-hourly.ts`:** browser + scheduler endpoint (admin switch, no-browser sync, chart, tooltip, CPC, views, mobile, page-load safety, dedupe, switch off).
