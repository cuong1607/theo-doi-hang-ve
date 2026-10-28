# Shopee Ads — READ-ONLY sync (SHOPEE-ADS-1B)

The Ads sync **only reads** from Shopee: GET requests to allowlisted read endpoints, enforced by `read-only-policy.ts`. Nothing is ever written to Shopee. See [shopee-ads-read-only-policy.md](shopee-ads-read-only-policy.md).

## Switches

| env | default | effect |
|---|---|---|
| `SHOPEE_ADS_DATA_SOURCE` | `fixture` | `real` → the dashboard reads the canonical tables **and** the worker may claim the Ads read jobs. With `fixture` (the production default), no Ads job is ever created or run. |
| `SHOPEE_ADS_PROVIDER` | `live` | `fixture` → the jobs replay the sanitized production payloads (`ads/__fixtures__/provider`). Use it for local dev and tests, because the sandbox has no Ads backend. It is refused in production unless `ENABLE_SHOPEE_FIXTURE_MODE=true`. |
| `ADS_PERFORMANCE_RESTATEMENT_DAYS` | `7` | Completed days re-read by every performance refresh. **Provisional**; see below. |
| `ADS_INITIAL_BACKFILL_DAYS` | `30` | First performance sync of a shop. |
| `ADS_CAMPAIGN_STALE_MINUTES` | `360` | "Làm mới" re-reads campaign metadata only when it is older than this. |

**Local real mode:**

```
SHOPEE_ADS_DATA_SOURCE=real SHOPEE_ADS_PROVIDER=fixture npx next dev
```

## Job types
All jobs run in the existing queue, `channel_sync_jobs`, with claim, lease, checkpoint, retry/backoff, stale recovery and the circuit breaker. No new worker was added.

| job | lane priority (manual) | flow |
|---|---|---|
| `ads_campaign_read` | 5 | `get_product_level_campaign_id_list` (limit 100, `offset` += page length until `has_next_page=false`) → `get_product_level_campaign_setting_info` (≤50 ids) → snapshot → upsert campaigns → reconcile product links |
| `ads_campaign_performance_read` | 6 | `metadata.adsRange` split into **≤7-day** windows × campaign batches of **≤50 ids** → `get_product_campaign_daily_performance` → snapshot → upsert `(campaign_id, report_date)` |
| `ads_shop_performance_read` | 6 | `metadata.adsRange` split into **≤30-day** windows → `get_all_cpc_ads_daily_performance` → snapshot → upsert `(shop_id, report_date)` |

**Common behaviour:**
- Every slice checks the API-call / time budget before each call and checkpoints after each batch: `metadata.checkpoint` = window index + batch index, or offset + phase.
- An answer with a problem fails only its own rows: they are counted and the log status becomes `partial`. An unparseable payload is a fatal job error (`provider_parse_error`); it is not retried.
- **Dependency:** if campaign performance runs before any campaign exists for the shop, it throws `ads_campaigns_pending`. That error is retryable with backoff and makes **no** provider call. Priority 5 < 6 means metadata normally runs first.
- **Product links:** only the links of campaigns whose settings parsed completely are reconciled (missing links inserted, links no longer listed removed). A campaign that failed to parse keeps its links.
- **Sync state:** `channel_sync_states` holds one row per shop × job. `last_success_at` is the time the read finished, which drives freshness. The latest report date is read directly from the fact table.

## Manual refresh ("Làm mới dữ liệu", real mode)
1. `refreshAdsDataAction` (permission `channel:sync`) runs per selected shop, each one independently, so a failing shop never blocks the others. It enqueues:
   - `ads_campaign_read`, only when metadata is stale or was never read;
   - `ads_campaign_performance_read` and `ads_shop_performance_read` for the window, which is the initial backfill on the first sync.
2. The worker is kicked after the response with `after()`.
3. The browser polls `adsRefreshStatusAction` every 2.5 s, for at most 3 min. The status action kicks the worker again if work is waiting and nothing is running.
4. When no job is active: `router.refresh()`, then a success toast, or an error toast with the job error.
5. The old dashboard stays visible, dimmed, the whole time. The page render itself reads **only the DB**.

## Windows and overlap
- **Refresh window:** today + the previous `ADS_PERFORMANCE_RESTATEMENT_DAYS` (7) completed days, in the shop's timezone (`shops.timezone`).
- **First sync:** `ADS_INITIAL_BACKFILL_DAYS` (30) + today. That is 5 campaign windows of ≤7 days and 2 shop windows (30 + 1).
- **The 7-day overlap is provisional.** Same-day re-reads of 25–27/10 were identical, 27 minutes apart, but cross-day restatement is **not proven**. Adjust the env value once a later probe compares the stored days.
- **Today is partial.** The dashboard shows "Hôm nay — dữ liệu có thể chưa hoàn tất" whenever the range includes today. The "Hôm nay" preset has no comparison, because no hourly data is stored and a full yesterday would mislead.

## Scheduler
**There is no Ads schedule.** The scheduler does not enqueue Ads jobs; they come only from the manual refresh. The worker bursts started by the scheduler or the kick claim Ads jobs only in real mode.

The production auto-sync cadence belongs to a later phase. Suggested cadence:

| what | how often |
|---|---|
| shop performance | every 30–60 min during the day |
| campaign performance | hourly |
| campaign metadata | every 6 h |

With 143 campaigns that is about 3 + 3 + 1 calls per cycle per shop.

## Token keepalive
The ADS-0 daily keepalive is **kept**. Ads reads refresh tokens on demand through `getValidAccessToken`, but there is no automatic Ads cadence yet. Re-evaluate the keepalive once the scheduled Ads sync exists.

## Tests
- `src/lib/channels/shopee/ads/ads-mapper.test.ts` (pure, on the real fixtures): mapping, the `cpc` regression, dates, epoch unit, money, unknown/null/zero/abnormal rows, window planning.
- `src/lib/channels/shopee/ads/ads-sync.integration.test.ts` (local DB): queue → worker → DB → real dashboard source; raw→DB reconciliation; the 27/10 shop-vs-campaign regression; idempotency; late updates; multi-shop isolation; dependency retry; zero range.
- `scripts/e2e/shopee-ads-real.ts`: browser test in real mode against the local DB.
