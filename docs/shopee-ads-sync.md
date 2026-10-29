# Shopee Ads — READ-ONLY background sync (SHOPEE-ADS-1B / ADS-2)

The Ads sync **only reads** from Shopee: GET requests to allowlisted read endpoints, enforced by `read-only-policy.ts`. Nothing is ever written to Shopee. See [shopee-ads-read-only-policy.md](shopee-ads-read-only-policy.md).

```
pg_cron (every minute) → /api/internal/shopee/sync-scheduler → Ads scheduler (due work per shop)
  → channel_sync_jobs (dedupe / coalescing) → worker bursts (after()) → Shopee Ads GET
  → canonical Ads tables → /shopee/ads (DB only)
```

Opening the dashboard never calls Shopee and never enqueues anything.

## Switches

| env | default | effect |
|---|---|---|
| `SHOPEE_ADS_DATA_SOURCE` | `fixture` | `real` → dashboard reads the canonical tables **and** the worker may claim Ads read jobs. With `fixture` no Ads job is created or run. |
| `SHOPEE_ADS_PROVIDER` | `live` | `fixture` → replay the sanitized production payloads (local dev / tests). Refused in production unless `ENABLE_SHOPEE_FIXTURE_MODE=true`. |
| `ADS_AUTO_SYNC_ENABLED` | `false` | Global scheduler switch. Also requires the shop's `shopee_ads_shop_settings.ads_sync_enabled` (admin panel "Bật tự động"). |
| `ADS_HOT_INTERVAL_MINUTES` | `15` | HOT shop total (min 10: no point polling faster than Shopee updates). |
| `ADS_CAMPAIGN_HOT_INTERVAL_MINUTES` | `15` | HOT campaign performance. |
| `ADS_WARM_INTERVAL_MINUTES` | `60` | WARM restatement. |
| `ADS_WARM_RESTATEMENT_DAYS` | `3` | WARM = yesterday back N completed days (0 = off). |
| `ADS_COLD_RESTATEMENT_TIMES` | `03:00,15:00` | COLD times in `ADS_COLD_TIMEZONE` (default `Asia/Ho_Chi_Minh`). |
| `ADS_PERFORMANCE_RESTATEMENT_DAYS` | `7` | COLD = N completed days + today. **Provisional.** |
| `ADS_CAMPAIGN_METADATA_INTERVAL_MINUTES` | `360` | Campaign catalogue. |
| `ADS_CAMPAIGN_METADATA_STALE_MINUTES` | `480` | HOT may skip non-active campaigns only while the catalogue is newer than this. |
| `ADS_INITIAL_BACKFILL_DAYS` | `30` | First sync of a shop. |
| `ADS_GLOBAL_API_CONCURRENCY` | `2` | Max running Ads jobs across all shops (= concurrent Ads calls). 1 for `SHOPEE_SYNC_RATE_LIMIT_COOLDOWN_MINUTES` after a rate limit. |
| `ADS_PER_SHOP_API_CONCURRENCY` | `1` | Documented; enforced by the claim's per-shop cap (`SHOPEE_SYNC_MAX_RUNNING_PER_SHOP=1`). |
| `ADS_BATCHES_PER_SLICE` | `3` | Campaign batches per slice before the job rotates to the back of its line. |
| `ADS_SCHEDULER_JITTER_SECONDS` | `20` | Deterministic start offset per shop and tick. |
| `ADS_MANUAL_DEDUPE_MINUTES` | `5` | Manual refresh right after a HOT read → "Dữ liệu vừa được đồng bộ". |
| `ADS_HOT_RECENT_STATUS_HOURS` | `36` | Campaigns whose status changed / ended within this stay HOT candidates. |

## Strategies

| strategy | when | range | campaigns | priority | lane |
|---|---|---|---|---|---|
| manual | "Làm mới dữ liệu" | today | all | 1 | `ads_hot` |
| hot (shop) | every 15 min | **today only** | — | 2 | `ads_hot` |
| metadata (first) | every 15 min until the catalogue exists | — | all | 2 | `ads_meta` |
| hot (campaign) | every 15 min | **today only** | active candidates | 3 | `ads_hot` |
| repair | a performance answer names an unknown campaign | — | all | 3 | `ads_meta` |
| warm | hourly | yesterday … −3 days | recent-activity candidates | 4 | `ads_warm` |
| metadata | every 6 h | — | all | 5 | `ads_meta` |
| cold | 03:00 & 15:00 VN | 7 completed days + today | **all** | 6 | `ads_cold` |
| backfill | first sync (replaces WARM/COLD until it succeeds) | 30 days + today | all | 7 | `ads_backfill` |

**Campaign candidates** are derived from the DB before any call:
- **HOT:** `provider_status = ongoing`, + `status_changed_at` / `provider_end_at` within 36 h, + campaigns already non-zero today.
  - If the catalogue is older than 8 h, HOT reads **all** campaigns (`campaignScope.fallback = metadata_stale`).
- **WARM:** ongoing, + status changed / ended since the window start, + non-zero stored performance in the window.
- **COLD:** reads every campaign, so the HOT/WARM optimization never costs long-term accuracy.

**Calls per HOT cycle:** 1 (shop) + ⌈candidates / 50⌉. For the pilot shop: 43 ongoing of 143 → **2 calls** (vs 4 for all campaigns).

## Scheduler
- **Heartbeat ≠ cadence.** pg_cron calls the scheduler every minute. For each enabled, active, connected, not-paused shop, the scheduler plans what is due (pure `planAdsShop`).
- **Slot claim:** each due slot is claimed with a conditional `UPDATE … WHERE last_x_slot_at IS NULL OR < slot` on `shopee_ads_shop_settings` *before* enqueueing. Overlapping or repeated ticks therefore never schedule a slot twice.
- **Staggering:**
  - Every shop has a minute offset (0–9) inside each 15-minute window: the explicit `sync_slot`, else `(rank × 2) mod 10` among enabled shops sorted by id → `:00 :02 :04 :06 :08`.
  - WARM runs at offset + 5 min, metadata at offset + 10 min, COLD at its time + 2 × offset.
- **Jitter:** one deterministic 0–20 s offset per shop and tick, shared by all that shop's jobs, so priority decides their order.
  - The worker burst waits for jobs due within the jitter (`idleWaitMs`), so the jitter costs seconds, not a scheduler minute.

## Queue
- **Identity:** shop + sync_type + lane (generated column `channel_sync_jobs.lane`), with range / scope in metadata.
- **`enqueue_ads_sync_job`** (one advisory-locked step):
  1. A covering active job (range ⊇, scope all or equal) that is **running**, or **queued at the same / a more urgent priority**, is reused.
  2. Otherwise insert into the lane.
  3. If the same lane is busy, not covering and not started, it is widened (union of ranges).
  - A queued COLD / backfill is never promoted to HOT priority; HOT gets its own small job.
- **Claim:** priority, then longest-waiting (round robin across shops); ≤ 1 running job per shop; ≤ `ADS_GLOBAL_API_CONCURRENCY` running Ads jobs; paused / disabled shops are skipped (manual jobs still run).
- **Checkpoint:**
  - Campaign ids are frozen on the first slice; the window index and batch index are saved after every batch.
  - After `ADS_BATCHES_PER_SLICE` batches the job goes back to pending at the end of its priority line. A 1000-campaign shop takes 7 slices, and other shops run in between.
  - Stale running jobs are recovered by the existing `recover_stale_sync_jobs` and resume from their checkpoint.
- **Isolation:**
  - A failing batch fails only its own job; it is retried from its checkpoint.
  - A failing shop never blocks the others. The circuit breaker pauses that shop's automatic jobs.

## Accuracy
- **Today is partial.** HOT upserts the same rows repeatedly, and the dashboard warns "Hôm nay — dữ liệu có thể chưa hoàn tất".
- **Completed days are never treated as immutable.** WARM re-reads them hourly and COLD twice a day.
- **Restatement log:**
  - When a completed day's stored value was read **after** that day ended and now differs, the job counts it in `stats.restatedRows`.
  - Up to 5 samples are kept in `metadata.restatedSamples` (old → new per field).
  - This is the evidence for tuning `ADS_WARM_RESTATEMENT_DAYS` / `ADS_PERFORMANCE_RESTATEMENT_DAYS`.
- **Anomalies** are counted, never refused, in `stats.anomalies`:
  - `broad_order_lt_direct`
  - `broad_gmv_lt_direct`
  - `order_without_gmv`
  - Negative values are refused by the mapper.
- **Shop total vs campaigns:** shop totals stay their own fact, and "Ngoài chiến dịch sản phẩm" is informational only.

## Freshness (dashboard, DB only)
`ads_sync_freshness(shop_ids)` returns the latest successful read that **includes today**. WARM never counts toward it.

| part | target | stale after |
|---|---|---|
| Tổng shop hôm nay | 20 min | 25 min |
| Chiến dịch hôm nay | 25 min | 35 min |
| Danh mục chiến dịch | 6 h | 8 h |

While the page is open and visible, it polls this stamp every 90 s through `adsFreshnessAction` and re-renders when a background read has landed. That is a DB read only.

## Manual refresh
- **Same queue, priority 1.**
  - Never synced → metadata + 30-day backfill.
  - Today read < 5 min ago → nothing is enqueued and the UI says "Dữ liệu vừa được đồng bộ" (`force` overrides this for `channel:manage`).
  - Otherwise → today (shop + all campaigns), metadata when stale, plus a background WARM catch-up when no WARM ran within the hour.
- The button polls only its own jobs.

## SLA metrics
`get_ads_sync_metrics(hours)` reports, per shop × type × strategy:
- job count, successes, failures, active jobs
- avg / p95 **queue wait** (`started_at − max(created_at, notBefore)`), **execution** and **total** latency
- records written and API calls

Per-endpoint latency stays in the existing `get_sync_api_stats`. The admin panel shows the HOT figures per shop.

## Token keepalive
The ADS-0 daily keepalive is **kept**. With HOT every 15 minutes, every Ads-enabled shop refreshes its token on demand (`getValidAccessToken`). Review after 24–48 h of production scheduling; the keepalive is redundant only for shops that are Ads-enabled.

## Rollout
1. Push migrations 00064 + 00065 to cloud, then `NOTIFY pgrst, 'reload schema'` (new / changed RPC signatures).
2. Deploy with `SHOPEE_ADS_DATA_SOURCE=real` and `ADS_AUTO_SYNC_ENABLED=false`. Run "Làm mới dữ liệu" on CTV Bedding and reconcile with Shopee Seller Centre.
3. Admin panel: "Bật tự động" for CTV Bedding only. Then set `ADS_AUTO_SYNC_ENABLED=true` and redeploy.
4. Observe several HOT cycles:
   - queue drained before the next cycle
   - no stuck job, no rate limit
   - freshness < target
   - no-browser proof: close the dashboard for > 15 min, then check that `last_read_at` advanced
5. Enable the next shop, check capacity (HOT p95 total < 10 min), and continue.

## Tests
- `ads-schedule.test.ts` (pure): slot maths, 5-shop stagger over simulated minutes, COLD times, HOT = today only, jitter, priorities, new-shop plan.
- `ads-scheduler.integration.test.ts` (local DB):
  - no-browser flow
  - HOT active filter + metadata fallback
  - coalescing / widening, priority
  - 1000-campaign checkpoint + fairness, stale recovery, metadata repair
  - failure isolation, idle wait
  - page load = 0 jobs / 0 calls
  - 5-shop load simulation
- `ads-sync.integration.test.ts`: canonical reconciliation (27/10 regression), manual dedupe, COLD restatement detection.
- `scripts/e2e/shopee-ads-scheduler.ts`: browser + scheduler endpoint (no-browser proof locally).
- `scripts/e2e/shopee-ads-real.ts`: dashboard in real mode.
