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

## 6. Retention

- Sales facts: long term.
- Extra-info snapshots: 90 days (pruned by the job).
- No raw order snapshot is written by this flow.
