# Product sales facts sync (PRODUCT-ANALYTICS-2)

New **isolated READ-ONLY** flow. The legacy order module is NOT revived:
- `SHOPEE_AUTO_SYNC_ENABLED` and `SHOPEE_LEGACY_MODULES_ENABLED` stay **off**;
- the legacy `order` / `product` / escrow / returns / income / payout jobs stay retired and are never enqueued;
- the legacy Orders UI stays hidden.

## 1. Jobs

| Job type | Lane | Priority | What |
|---|---|---|---|
| `product_sales_facts_read` (backfill) | `pa_backfill` | 10 | orders **created** in the last 30 completed days + today |
| `product_sales_facts_read` (hot) | `pa_hot` | 6 | orders **updated** in the last 48 h, every 30 min |
| `product_sales_facts_read` (cold) | `pa_cold` | 8 | orders **updated** in the last 8 days, 04:00 / 16:00 VN |
| `product_sales_facts_read` (manual "Làm mới đơn") | `pa_hot` | 6 | = hot, `mode=manual` |
| `product_extra_info_read` | `pa_extra` | 9 | `get_item_extra_info` for every known product, 06:00 / 18:00 VN |

Every priority is **below** the Ads daily and hourly HOT reads (2–5). The shared queue, worker, retry policy, circuit breaker, rate-limit cooldown, `ShopeeClient` transport and signing are reused. Global provider concurrency is **unchanged**.

The work is bounded: at most 20 provider calls per slice. After that the job yields and goes back to `pending`, so Ads jobs claim the worker between slices.

**Adaptation of the spec's HOT / WARM / COLD:** `get_order_list` filters by `update_time`, and every status change bumps `update_time`. So the 48 h HOT window already re-reads any order that changed, whatever its create date. That is the mandatory restatement overlap. A separate WARM pass would only repeat it; COLD is the outage safety net.

## 2. Endpoints

Not guessed: both order reads ran in production from SHOPEE-3 until the legacy retirement.

| Endpoint | Use | Params |
|---|---|---|
| `GET /api/v2/order/get_order_list` | discovery | `time_range_field`, ≤ 15-day windows, `page_size=100`, cursor |
| `GET /api/v2/order/get_order_detail` | facts | ≤ 50 `order_sn`, `response_optional_fields=item_list,pay_time` only |
| `GET /api/v2/product/get_item_extra_info` | snapshots | ≤ 50 item ids |

Allowlist: `PRODUCT_SALES_READ_ENDPOINTS`, enforced with `assertProductSalesReadRequest` (GET only) before every call. The reader is `src/lib/channels/shopee/product-analytics/sales-reader.ts`, which is not the legacy order provider.

Rate limits: no production rate-limit evidence exists for this flow yet. To be observed in the pilot (§5).

## 3. Resumability (checkpoint)

The checkpoint is saved after **every** provider call: `{ strategy, field, windows, windowIndex, cursor, pending order_sn[], pages }`.
- A timeout or crash resumes at the same page or detail batch; it never restarts from zero.
- A repeated or empty cursor while `more=true` fails the job, which is retried later.
- An order with one unusable line is reported (`partial`) and not stored half.
- `sales_backfill_done_at` is set only after a backfill finished with no failure. Until then, BACKFILL replaces COLD.

**Calls per shop:**
- backfill: windows (3) × pages (orders / 100) + details (orders / 50). For CTV, about 1 000 orders/month, that is about 30 calls.
- hot run: typically 1 list + 1–3 detail calls.

## 4. Configuration

| Env / setting | Default | Effect |
|---|---|---|
| `PRODUCT_SALES_SYNC_ENABLED` | false | Scheduler plans and the worker claims `product_sales_facts_read`. |
| `PRODUCT_EXTRA_INFO_SYNC_ENABLED` | false | Same for `product_extra_info_read`. |
| `product_analytics_shop_settings.sales_sync_enabled` / `extra_info_enabled` | false | Per-shop rollout switches (admin, `/shopee/product-analytics`). |

Opening `/shopee/product-analytics` or a product detail page makes **0 Shopee calls**: it reads the database only (verified: 0 `shopee_api_call` log lines during the E2E). "Làm mới" only **queues** a job.

## 5. Production pilot (not run yet: needs the user)

1. `supabase db push` (00070), then `NOTIFY pgrst, 'reload schema'`.
2. Deploy, then set `PRODUCT_SALES_SYNC_ENABLED=true` on Vercel and redeploy.
3. `/shopee/product-analytics` → "Bật đơn hàng" for **CTV Bedding** only. Watch the backfill job (calls, duration, rate-limit hits), fact rows and freshness.
4. Then one smaller shop (RUGLUX), then all 5.
5. Observe: `channel_sync_jobs` metadata (`apiCalls`, `rateLimitHits`, `durationMs`), table sizes, query latency on cloud.
6. Optionally `PRODUCT_EXTRA_INFO_SYNC_ENABLED=true` (twice a day) to start the 90-day snapshot history for a future semantics study.

### 5.1 Pilot log (PRODUCT-ANALYTICS-2P, started 2026-10-31)

State on 2026-10-31 08:30 VN:
- commit `336c55b` deployed;
- 00070 on cloud;
- `PRODUCT_SALES_SYNC_ENABLED=true`;
- **no shop switch on yet**, so no backfill / hot / cold job has been planned (only 4 admin "Làm mới đơn" jobs ran).

Checks are reproducible, read only: `scripts/shopee/product-analytics-pilot-check.ts` (latency, agent tools) and the SQL listed in the 2P report.

| Check (3 shops, 2 299 lines from the manual 48 h reads) | Result |
|---|---|
| Duplicate `(order, line_item_id)` | 0. A second HOMIES read of the same window: 1 549 / 1 551 lines `skipped_stale`, 0 new rows. |
| Cancelled lines counted in sales | 0 (148 cancelled lines stored, `is_valid_for_sales=false`). |
| `valid_amount = unit_discounted_price × (qty − cancelled)` | 0 mismatches. |
| Σ facts = Σ `shopee_product_daily_metrics` (GMV, units) | equal to the đồng, all 3 shops. |
| `report_date` = Asia/Bangkok date of `create_time` | 0 mismatches. 308 lines have a different UTC date; 426 lines fall between 22:00 and 02:00 VN. |
| Cross-check vs frozen legacy orders (CTV + carpet, 275 overlapping orders) | 275 / 275 same line count, quantity and item value. 268 changed status since the freeze (restatement source). 245 have `total_amount ≠ Σ items`, which confirms no per-item allocation. |
| Multi-item orders | 142. Each line keeps its own `unit × qty`; nothing is allocated. |
| Identity | 0 fact lines without `shopee_products`; 0 item ids shared across shops. |
| Broad Ads GMV ÷ product sales GMV (29–30/10, 86 products) | median 1.00, p90 2.00, p95 2.75, max 5.15; 36 products > 100 %. Not a share. |
| Provider (4 manual jobs) | 33 list + 65 detail calls, 0 rate limits, 0 retries. list p50 ≈ 1.7 s / max 2.8 s, detail p50 ≈ 2.4 s / max 3.8 s, from iad1. |
| Agent tools on prod DB (HOMIES grant) | 5 / 5 OK, 0.7–2.8 KB, no forbidden key. Denials: unknown user, other shop, other shop's product, non-uuid. |
| Read latency (from a VN client, network included) | list 30d of one shop p50 0.3–0.46 s; all 5 shops p50 0.73–1.12 s; detail p50 0.3 s; baseline p50 0.24–0.28 s. Server-side list RPC for all shops ≈ 250 ms warm (1.3 s cold). |

### 5.2 2P-FINAL check (2026-10-31 ~09:15–10:30 VN)

**State found:** `product_analytics_shop_settings` has **0 rows**. No shop's "Bật đơn hàng" switch was ever saved; only "Làm mới đơn" was used.

The 6 jobs are all `mode=manual` 48 h reads:
- CTV, carpet, congtrangbedding, RUGLUX: 1 each;
- HOMIES: 2.

So no backfill, HOT or COLD job ever ran: the scheduler only plans for shops with `sales_sync_enabled=true`.

**Integrity (all 5 shops, 4 226 lines):**
- duplicates 0;
- negative or inconsistent quantities 0;
- cancelled lines stored and excluded (279 lines);
- Σ facts = Σ view exactly;
- timezone mismatches 0;
- 0 order ids and 0 item ids shared across shops;
- 0 lines without identity;
- 1 multi-product campaign excluded (1 927 / 1 928 single-item).

**Defect found and fixed:** missing data was shown as data.
- **Problem:** the list showed facts of non-backfilled shops as complete sales, with Δ % against an almost empty previous period. Signals and agent tools did the same: SALES_UP from missing data, and a 0 baseline.
- **The 30-day case:** the "30 ngày" preset always compares with days older than the 30-day backfill, so it would have stayed wrong after the backfill too.
- **Fix:** `src/lib/product-analytics/coverage.ts`. A period is `covered` only from `backfill day − 30`. Otherwise:
  - the UI shows "≥ x" or "—" with a callout and no Δ;
  - the chart leaves a gap;
  - signals are suppressed;
  - tools return `availability: lower_bound | no_data` with previous / pct null and `sales_baseline_complete=false`.

## 6. Retention

- Sales facts: long term.
- Extra-info snapshots: 90 days (pruned by the job).
- No raw order snapshot is written by this flow.
