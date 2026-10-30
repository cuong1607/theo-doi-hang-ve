# Shopee Ads — product enrichment (SHOPEE-ADS-3A.2)

Gives the Ads campaign table the advertised product's **name, thumbnail, SKU and Shopee item status**.

It reads **only** the items that Ads campaigns already reference. It uses the canonical DB as a cache, so a product is re-read only when it is unknown, stale (older than the TTL) or an admin asks.

It does **not** rebuild the legacy product module. It does not scan the shop catalogue. It never writes to Shopee (see `shopee-ads-read-only-policy.md`).

## 1. Source discovery

Sources were checked in the order the spec requires.

| Order | Source | Result |
|---|---|---|
| A | Fields already in Ads payloads (`get_product_level_campaign_setting_info`, `get_recommended_item_list`) | Only `item_id` (plus `item_status_list` and `sku_tag_list` in the recommended list). There is no name, image or SKU. |
| B | A read endpoint already in the connector | `GET /api/v2/product/get_item_base_info` (legacy `product-provider.ts`). The production DB holds **657 real snapshots** of it from the legacy product sync. |

Evidence comes from those real snapshots. All checks were read-only SQL, and no new provider call was needed:

| Field | Type | Seen in production | Persisted as |
|---|---|---|---|
| `item_id` | number | always | `provider_item_id` (text) |
| `item_name` | string | always (93–120 characters) | `product_name` |
| `item_sku` | string | 162 / 657 non-empty | `item_sku` (empty → NULL; never invented) |
| `item_status` | string | `NORMAL` 527 · `UNLIST` 58 · `SELLER_DELETE` 72 | `provider_status` (raw) |
| `image.image_url_list[0]` | string | 657 / 657 = `https://cf.shopee.vn/file/<image_id_list[0]>`, never with a query string | `image_url` |
| `has_model` | boolean | `true` | not stored (campaigns advertise items, not models) |

Other facts about the endpoint:
- **Batching:** up to 50 ids per call, sent as a comma-separated `item_id_list`. The limit is documented, and multi-id calls are verified by the legacy sync.
- **Coverage:** for the three shops that have legacy snapshots (CTV, RUGLUX, carpet), **100 %** of Ads-referenced items are covered (355 / 355). That includes items that are `UNLIST` or `SELLER_DELETE`, so the endpoint does return deleted items.
- **Not yet observed:** congtrangbedding and HOMIES have never called this endpoint. The rollout verifies them.
- **Image semantics:**
  - The URL is unsigned and has no expiry parameters, and it is derived from a stable `image_id`.
  - Only `https://cf.shopee.vn/file/<id>` is persisted (`safeShopeeImageUrl`, plus a DB CHECK). Any other host, query or fragment → NULL.
- **Model / variation:** every campaign advertises exactly one item (ADS-1A), so model-level SKU is deferred.
- **Item ids that are not returned:** what absence means (deleted, other shop, temporary) is **not verified**. Such items are marked `not_returned` and are never deleted.

The test fixture `__fixtures__/provider/item-base-info.json` is a **sanitized projection** of those real snapshots:
- it covers the 101 Ads items of the ADS-1A shop;
- ids are remapped to the masked fixture ids;
- names, SKUs and image ids are placeholders;
- statuses, ratios and timestamps are untouched.

The scratchpad export of the raw rows was never committed.

## 2. Schema (migration 00068)

| Object | Purpose |
|---|---|
| `shopee_ads_products` | `shop_id` + `provider_item_id` (UNIQUE): `product_name`, `image_url` (CHECK on the shape), `item_sku`, `provider_status`, `enrichment_status` (`enriched` / `not_returned`), `last_enriched_at`, `last_checked_at` (drives the TTL). <br>RLS: active users SELECT. Writes only through `service_role`. Explicit grants. <br>No other index: the unique key serves both the join and per-shop scans. |
| `shopee_ads_shop_settings` + | `ads_product_enrichment_enabled` (default **false**), `product_enrichment_enabled_at`, `last_product_enrichment_slot_at` |
| `ads_product_enrichment_candidates(shop, stale_before, force, limit)` | Need-set: distinct referenced items that are missing or stale. Missing items come first. `STABLE` SQL. |
| `ads_product_enrichment_summary(shops[], stale_before)` | Per shop: referenced / enriched / not_returned / missing / stale / with image / with SKU. |
| `ads_dashboard_campaigns` | Now also returns `products jsonb` (`i, n, img, sku, st, es`). It is still one aggregated request with no N+1; the return type changed, so the function is dropped and recreated with the same grants. |
| `channel_sync_jobs` | Adds the sync type `ads_product_enrichment_read`, also accepted by `enqueue_ads_sync_job`. |

`shopee_ads_campaign_products` stays the only campaign ↔ item mapping. Its `item_name_snapshot` column stays unused, because the canonical current name lives in `shopee_ads_products.product_name`.

Raw answers are kept in `channel_api_snapshots` (entity `ads`) as a **projection** (`item_id, item_name, item_sku, item_status, image, has_model, update_time`). Descriptions, attributes and logistics data are not kept.

## 3. Sync

| Item | Value |
|---|---|
| Job type | `ads_product_enrichment_read`, lane `ads_meta`, strategy `enrichment` |
| Priority | 9: below every performance read (manual 1 · HOT 2–3 · hourly 4–5 · WARM 6 · metadata 7 · COLD / finalize 8). Backfill moved from 9 to 10. |
| When it is enqueued | 1. **Scheduler product slot** every 15 min (shop offset + 7 min): a DB-only check (`ads_product_enrichment_summary`). A job is created only when an item is missing or stale. A fresh cache consumes the slot with no job and no call. The slot is deferred while a daily HOT read of an earlier slot is still queued. <br>2. **New-item fast path**: an `ads_campaign_read` that inserted product links enqueues one right away. <br>3. **"Làm mới dữ liệu"**: only when something is missing or stale; not awaited by the button. <br>4. **Admin "Làm mới TT SP"**: scope `all` (every referenced item). |
| TTL | `ADS_PRODUCT_ENRICHMENT_TTL_HOURS`, default 24 (1–720) |
| Batching | ≤ 50 distinct ids per GET; ≤ `ADS_BATCHES_PER_SLICE` calls per slice, then the job yields; ids are frozen in the checkpoint; ≤ 1000 items per job, and the next slot continues |
| Dedupe | `enqueue_ads_sync_job` allows one active job per shop + type + lane. Scope `all` covers `stale`. |
| Metrics | In job metadata: `productScope {referenced, candidates, missing, stale, cacheHits, cacheHitRate, ttlHours}`; stats `itemsRequested / itemsReturned / itemsNotReturned / imagesRejected / productsRenamed`; `apiCalls`, `latencyMs` |
| Failure | The job retries through the existing policy. Daily, hourly, WARM and COLD jobs are separate, so they are never blocked. The dashboard keeps the cached names, or shows placeholders. |
| Switches | Global `ADS_PRODUCT_ENRICHMENT_ENABLED` (default **false**) **and** the per-shop `ads_product_enrichment_enabled`. A job queued before a switch-off finishes without calling Shopee. |

## 4. UI

Campaign table, first cell:
- A 36 px thumbnail: lazy, fixed square, `object-cover`.
- The name is the product name when it is enriched; otherwise it is the campaign name.
- The second line holds shop · type · SKU.
- A broken or missing image shows the neutral package icon in the same box.
- Plain `<img>`, so there is no Next image proxy and no remote-host wildcard.

Expanded row:
- a 48 px image, the name, the item ID, the SKU;
- a subtle status badge for anything other than `NORMAL`;
- "Đang chờ bổ sung thông tin sản phẩm" while pending;
- the campaign name when it differs from the product name.

Placeholder: **"Sản phẩm Shopee #<item id>"**. It never says "error", and real mode never uses fixture names.

Search covers campaign name, shop, product name, SKU and item id, with accents folded.

Admin panel shows a "Thông tin SP (đủ / tổng · chờ)" column, plus the buttons "Bật/Tắt TT SP" and "Làm mới TT SP". All of these are READ ONLY.

## 5. Capacity

Five shops, using real distinct item counts:

| Measure | Value |
|---|---|
| Distinct items per shop | 101 · 82 · 176 · 439 · 172 = **970** |
| Initial calls | Σ ⌈n / 50⌉ = **22** |
| Initial time in production | ≈ 11 s of provider time (≈ 1 s per call, 2 in flight) |
| Steady state | 0 calls while the TTL holds. When the TTL expires: 22 calls per 24 h. New items: one call per catalogue read that finds them. |
| HOT cycle with a full enrichment backlog queued first | Simulated: 984 → 983 ms. HOT calls unchanged; concurrency stays at 2. |

## 6. Rollout

1. Push migration 00068, then run `NOTIFY pgrst, 'reload schema'`. Deploy the code with `ADS_PRODUCT_ENRICHMENT_ENABLED=false`, and verify that daily and hourly jobs are unaffected.
2. Set `ADS_PRODUCT_ENRICHMENT_ENABLED=true` and press "Bật TT SP" for **CTV Bedding** only. Watch:
   - one job with 3 calls;
   - 101 rows;
   - the next slots are cache hits;
   - campaign table latency.
3. Enable the second shop, then the remaining shops one at a time.

congtrangbedding and HOMIES are the first shops that will call this endpoint at all.

## 7. Tests

| File | Covers |
|---|---|
| `ads-product-enrichment.test.ts` | Fixture provenance; field-by-field mapper; image safety; batch limits; read-only policy for the single product path; snapshot projection; priority / lane / TTL; search; placeholder |
| `ads-product-enrichment.integration.test.ts` | Local DB: placeholders before enrichment; page load makes 0 calls and creates 0 jobs; enqueue switches and dedupe; initial 3 batched GETs; idempotency and rename; not-returned items; TTL; multi-shop isolation; new-item fast path; HOT / hourly / COLD before enrichment; failure isolation; scheduler cache hits; RPC latency; 5-shop capacity |
| `ads-product-delivery.test.ts` | ADS-3A.2.1: snapshot fingerprint (request_id / order / shipping warnings ignored; name, SKU, status, image, item set, other content counted; input untouched); thumbnail URL safety; load order; flag default |
| `scripts/e2e/shopee-ads-products.ts` | Browser: pending state → background enrichment → names / thumbnails (`_tn` → original → icon, 36 px, no repeated request) / SKU / search; page views make 0 calls; refresh dedupe; admin refresh; switch off |

## 8. Delivery optimisation (SHOPEE-ADS-3A.2.1)

### Snapshot dedupe

`saveAdsSnapshot` refreshes `synced_at` instead of inserting when the payload hash matches the latest snapshot of the same key. For `get_item_base_info` that never matched. On production (2026-10-30), re-reading the same 9 batches returned identical items, yet every raw hash differed:

| Field | Observed on identical re-reads |
|---|---|
| `request_id` | different on every call |
| `response.item_list` order | different order, not sorted by item id |
| `warning` | ~20 KB of `fail to get channel estimated_shipping_fee for channel [N];` lines; the set of lines differs between reads (a logistics estimate, not product data) |

`normalizeShopeeProductSnapshotForHash` (sync.ts) builds the **hash input only** for this endpoint. It drops `request_id`, sorts `item_list` by numeric item id, and removes exactly those shipping-fee warning lines.

Everything else still changes the hash: names, SKU, status, images, `update_time`, the returned item set, `error` / `message`, and any other warning line. Other Ads endpoints keep the raw hash.

The stored payload is unchanged: `request_id`, `warning` and the provider order are kept. A deduped snapshot keeps its first `request_id`, so the job metadata records the latest ones (`requestIds`, last 20) along with `stats.snapshotsInserted` / `snapshotsDeduped`.

Results:
- Against the real production pairs: 0 / 9 deduped before the change, 9 / 9 after.
- First run after deploy: hashes stored with the old formula never match, so each key inserts one more snapshot, then dedupes.

### Display thumbnail

The stored `image_url` (`https://cf.shopee.vn/file/<id>`) is canonical and never rewritten. With `ADS_PRODUCT_THUMBNAIL_TN_ENABLED=true`, the dashboard source derives `thumbnailUrl = <image_url>_tn` per row. This is a pure string step, with no extra query.

`adsProductThumbnailUrl` derives a thumbnail only for that exact shape (https, host `cf.shopee.vn`, path `/file/<[A-Za-z0-9-]+>`). It returns nothing (meaning: use the original) for:
- another host;
- `http`;
- query strings, signatures or credentials;
- other paths;
- an id that already carries a suffix;
- malformed values.

`AdsProductThumb` tries the thumbnail, then the original, then the icon. Each URL is tried once, so there is no retry loop. The box is the same fixed 36 / 48 px square, with lazy loading and explicit width / height.

Verification (read-only CDN GETs, no Shopee Partner API) used a deterministic sample of 60 production images: 12 per shop, all 5 shops, covering NORMAL / UNLIST / SELLER_DELETE.

| | Original | `_tn` |
|---|---|---|
| Success | 60 / 60 | 60 / 60 (`image/jpeg`, no redirect) |
| Dimensions | 750–1024 px | 320 px wide (58 × 320×320, 2 × 320×426/427); aspect ratio identical in 60 / 60 |
| Average size | 677,664 B | 46,157 B (−93.2 %, 14.7× smaller) |
| p50 / p95 | 717,403 / 1,178,063 B | 46,734 / 68,013 B |
| 50-row page | ~32 MB | ~2.2 MB |

Sameness check: both images were scaled to 16×16 grayscale and compared by mean absolute difference.
- Original vs its own `_tn`: average 5.1, maximum 8.4.
- Thumbnail vs a different product's original (control): average 50, minimum 28.

An unknown id answers 404 for both forms, so the fallback chain handles it.

