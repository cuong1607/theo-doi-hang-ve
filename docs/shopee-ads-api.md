# Shopee Ads API — verified inventory (SHOPEE-ADS-1)

> **Status 2026-10-28**
>
> - **Sandbox:** no Ads backend (see §2).
> - **Production:** probe run once, 2026-10-28 08:58 UTC, on shop "CTV Bedding & decor Store". It used 12 GET requests and the result was **Ads AVAILABLE**: all 9 endpoints `VERIFIED_PROD` (see §3).
> - Expansion probe (ADS-1A.1), 09:25 UTC, 12 GET requests: full campaign coverage (143), reconciliation, budget / status / field formulas (see §3.5).
> - ADS-1B builds on these facts: data model in [shopee-ads-data-model.md](shopee-ads-data-model.md), sync in [shopee-ads-sync.md](shopee-ads-sync.md).
>   - **Shop total ≠ Σ campaigns.**
>   - **Provider `cpc` ≠ click CPC.**
>   - **Broad / Direct** are Shopee attribution metrics.
>   - **Today is partial.**
>   - **The restatement overlap is a temporary 7 days.**
> - Fixtures: `src/lib/channels/shopee/ads/__fixtures__/provider/`.
> - Confidence labels used below:
>   - **VERIFIED**: proven by the payload or by arithmetic on it.
>   - **LIKELY**: consistent with the evidence but not proven.
>   - **UNKNOWN**: no evidence either way.

## 1. Production read-only probe (SHOPEE-ADS-1A)

The production partner key and encryption key exist only on Vercel ("Sensitive" env vars). The probe therefore runs **inside the app**.

**Page:** `/shopee/ads/probe`
- Admin only (`channel:manage`); staff and viewer are sent to `/forbidden`. Not linked from the navigation.
- The admin picks ONE connected live shop, types `READ-ONLY`, then presses "Chạy probe chỉ đọc".
- The browser never calls Shopee; every call is made by the server.
- The sanitized report comes back to the browser and is downloaded as JSON.
- **Nothing is written** (no Ads tables, no snapshots, no jobs). The only possible write is the normal token refresh of the app's existing token flow.

**Code:**

| file | role |
|---|---|
| `src/lib/channels/shopee/ads/probe.ts` | Pure core: allowlist, guard, runner, classification, fixture builder |
| `src/lib/channels/shopee/ads/probe-server.ts` | Server transport: `getShopee()` + `getValidAccessToken` + `client.signedUrl` + plain fetch |
| `src/app/(authenticated)/shopee/ads/probe/` | Admin page and server action |
| `src/lib/channels/shopee/ads/sanitize.ts` | Fixture sanitizer + `findFixtureSecrets` (review step) |

**Guards** (fail closed; tested in `probe.test.ts`):
- GET only, and only the 9 exact allowlisted paths (`ADS_PROBE_ENDPOINTS`). No caller-supplied path is accepted. Mutation-named paths and non-Ads paths are rejected before any request.
- Production needs explicit confirmation: the typed `READ-ONLY` in the UI, `confirmProduction` in the core, `--prod` in the CLI.
- At most **25 requests per run** (a hard ceiling that callers can only lower), sent sequentially with a 1 s gap.
- Circuit breaker: stops after 3 consecutive 5xx / rate-limit / unavailable / auth answers, or after 2 auth errors.
- Logs carry metadata only: shop id, endpoint label, method, status, latency, classification, provider error code, request id, record counts. They never contain the URL, a body, or a token or key.
- Each call is classified as `AVAILABLE`, `PERMISSION_DENIED`, `REAUTH_REQUIRED`, `SHOP_NOT_ELIGIBLE`, `ENDPOINT_UNAVAILABLE`, `PARAM_ERROR`, `PROVIDER_ERROR` or `UNKNOWN`, and keeps the exact HTTP status, provider error code and message.

**Sanitizer**, applied to every saved body:
- Drops credential-like keys (token / secret / password / authorization / cookie / sign / headers) and shop / partner ids.
- Replaces names (campaign / item / keyword …) and provider ids with **stable placeholders**: the same real value always gets the same placeholder within one run, so relationships across endpoints survive. Types are kept (a number id stays a number).
- Leaves metrics, money, statuses and dates untouched.
- Arrays are cut to 50 items, and the cut is noted in the output.

**Probe sequence.** Dates are in the shop timezone. The `DD-MM-YYYY` format and the params come from the v2 Ads module listing; a provider parameter error is recorded, never brute-forced.

| # | endpoint | params | purpose |
|---|---|---|---|
| 1 | `get_shop_toggle_info` | — | Ads available? token permission, shop Ads state |
| 2 | `get_total_balance` | — | account / money representation |
| 3 | `get_product_level_campaign_id_list` | `ad_type=all, offset=0, limit=50` | entity ids, pagination hints |
| 4 | `get_product_level_campaign_setting_info` | `info_type_list=1,2,3,4`, ≤5 real ids from #3 | status / budget / bid / schedule / type / products |
| 5 | `get_all_cpc_ads_daily_performance` | yesterday → yesterday | shop-level daily metrics |
| 6 | `get_product_campaign_daily_performance` | yesterday, ids | campaign daily metrics |
| 7 | `get_all_cpc_ads_daily_performance` | D-3 → D-1 | row grain over a range |
| 8 | `get_all_cpc_ads_daily_performance` | yesterday again | stability (`identicalTo`) |
| 9 | `get_all_cpc_ads_hourly_performance` | yesterday | hourly grain (only if daily works) |
| 10 | `get_product_campaign_hourly_performance` | yesterday, ids | hourly grain per campaign |
| 11 | `get_all_cpc_ads_daily_performance` | today | is today partial? |
| 12 | `get_recommended_item_list` | — | product relation |

**After a run:**
1. Download the report from the page.
2. `npm run shopee:ads -- import <ads-probe-report.json>`. The import runs a secret scan and refuses to write if anything is flagged. It then writes `src/lib/channels/shopee/ads/__fixtures__/provider/_probe-report.json` plus one `<endpoint>.json` per successful call.
3. Review the files, then commit them. This is the human review checkpoint before ADS-1B.

**CLI** (`scripts/shopee/ads-discovery.ts`): `survey` runs the same core with a local or `--prod` (read-only token) transport. `probe <path>` allows any `get_*` path locally, but with `--prod` only allowlisted paths.

**Local verification** (sandbox shop, `next dev`, Playwright, 17/17):
- The admin run stopped with the circuit breaker after 3 × `ENDPOINT_UNAVAILABLE`.
- Staff and viewer were sent to `/forbidden`.
- The downloaded report contained no token, signature or shop id.
- Sync job count, snapshot count and tables were unchanged; there was no browser request to Shopee.

### 1.1 Expansion probe (SHOPEE-ADS-1A.1)

The same page offers a "Loại probe" choice: **Mở rộng (ADS-1A.1)**. In code it is `runAdsProbeExpansion`; in the CLI it is `survey --expansion`. It uses the same policy, allowlist, transport guard, breaker and sanitizer, sends GET only, and is capped at **30 requests**.

| # | calls | purpose |
|---|---|---|
| 1 | `get_product_level_campaign_id_list` with `limit=100` (one test of a larger page; on `PARAM_ERROR` it falls back to the verified 50), walking `offset` | Stops at `has_next_page=false`, 5 pages, or 250 campaigns. `coverageComplete` = the last page said `has_next_page=false`. |
| 2 | `get_product_campaign_daily_performance` for **every** scanned campaign, yesterday, ≤50 ids per call (one fallback to 20) | Σ campaigns vs shop daily, giving exact deltas (`summary.reconciliation`) |
| 3 | `get_product_level_campaign_setting_info` for every scanned campaign | Distribution of status / type / bidding / budget (0 vs >0) / roas_target (0 vs >0) |
| 4 | Top ≤5 spending campaigns: campaign daily for 7 days, plus 1 campaign hourly | Non-zero campaign payloads; 7-day range of the campaign endpoint |
| 5 | `get_all_cpc_ads_daily_performance` for D-7 → D-1 | Restatement: re-reads the days of the first probe; 7-day range |
| 6 | `get_all_cpc_ads_daily_performance` for D-30 → D-1 | 30-day range (dashboard preset). No further escalation. |

- Fixtures are prefixed `exp-`, and the report is saved as `_probe-report-expansion.json`, so the baseline fixtures are never overwritten.
- ID masking is consistent **within** one run only, not across runs.

## 2. Evidence collected (sandbox, 2026-10-28)

Host `openplatform.sandbox.test-stable.shopee.sg`, shop `227974291` (VN, `NORMAL`), signed with the same code as production.

| path (GET) | params | HTTP | body | latency |
|---|---|---|---|---|
| `/api/v2/ads/get_this_endpoint_does_not_exist` (control) | — | **404** | JSON `error_not_found` | 60–190 ms |
| `/api/v2/ads/get_total_balance` | — | **503** | `"ERROR_SP_SERVICE_NOT_FOUND"` | 62–226 ms |
| `/api/v2/ads/get_shop_toggle_info` | — | 503 | same | ~63 ms |
| `/api/v2/ads/get_recommended_item_list` | — | 503 | same | ~67 ms |
| `/api/v2/ads/get_all_cpc_ads_daily_performance` | `start_date`, `end_date` (DD-MM-YYYY) | 503 | same | ~65 ms |
| `/api/v2/ads/get_all_cpc_ads_hourly_performance` | `performance_date` | 503 | same | ~67 ms |
| `/api/v2/ads/get_product_level_campaign_id_list` | `ad_type=all`, `offset`, `limit` | 503 | same | ~70 ms |
| `/api/v2/ads/get_product_level_campaign_setting_info` | `info_type_list`, `campaign_id_list` | 503 | same | ~65 ms |
| `/api/v2/ads/get_product_campaign_daily_performance` | range + `campaign_id_list` | 503 | same | ~66 ms |
| `/api/v2/ads/get_product_campaign_hourly_performance` | date + `campaign_id_list` | 503 | same | ~65 ms |
| control (non-Ads): `/api/v2/shop/get_shop_info` | — | 200 | normal envelope | 313 ms |

How to read this:
- ✅ The 9 candidate paths are **registered routes** on the Shopee gateway. An unknown path gets a JSON 404 `error_not_found`; these get a 503 from the routing layer saying the backing service ("SP service") is not deployed.
- ✅ Signing, token and shop auth work on the same host: shop API 200, and the token was refreshed by the normal service.
- ✅ The sandbox environment has **no Ads backend**. This is not a permission error, which would come back as a JSON `error_permission` or similar.
- ❌ Not verified: required/optional params, the date format, pagination, response shape, field names, money units, report grain, status/type enums, attribution, data delay, timezone, and rate limits.

## 3. Production endpoint inventory (probe 2026-10-28, shop CTV Bedding)

**Sandbox vs production:**
- Sandbox: HTTP 503 `ERROR_SP_SERVICE_NOT_FOUND` on every Ads path.
- Production: **HTTP 200 with a normal envelope on all 9 paths**.

So the Ads backend exists in production, the app's token is permitted, no reconnect is needed, and there was no permission error.

**Envelope:** `{ response, request_id, error: "", message: "", warning: "" }`. The `response` root is an object or an array depending on the endpoint (see the table).

| endpoint (GET) | status | params actually sent | `response` root | pagination / grain | latency |
|---|---|---|---|---|---|
| `/api/v2/ads/get_shop_toggle_info` | VERIFIED_PROD | — | object `{data_timestamp, auto_top_up, campaign_surge}` | none | 778 ms (first call) |
| `/api/v2/ads/get_total_balance` | VERIFIED_PROD | — | object `{data_timestamp, total_balance}` | none | 284 ms |
| `/api/v2/ads/get_product_level_campaign_id_list` | VERIFIED_PROD | `ad_type=all, offset=0, limit=50` | object `{shop_id, region, has_next_page, campaign_list[{ad_type, campaign_id}]}` | **offset/limit + `has_next_page`**. 50 returned with `has_next_page: true`, so the shop has more than 50 campaigns. The next page, max limit and order were not tested. | 313 ms |
| `/api/v2/ads/get_product_level_campaign_setting_info` | VERIFIED_PROD | `info_type_list=1,2,3,4`, `campaign_id_list` = 5 ids, comma-separated | object `{shop_id, region, campaign_list[]}` | per campaign; max ids per call UNKNOWN | 302 ms |
| `/api/v2/ads/get_all_cpc_ads_daily_performance` | VERIFIED_PROD | `start_date`, `end_date` **DD-MM-YYYY** | **array**, one row per day | **shop × date**. A 3-day range gave 3 rows. Max range UNKNOWN. | 310–364 ms |
| `/api/v2/ads/get_all_cpc_ads_hourly_performance` | VERIFIED_PROD | `performance_date` DD-MM-YYYY | **array**, 24 rows (`hour` 0–23) | **shop × date × hour** | 319 ms |
| `/api/v2/ads/get_product_campaign_daily_performance` | VERIFIED_PROD | range + `campaign_id_list` | object `{shop_id, region, campaign_list[{campaign_id, ad_type, campaign_placement, ad_name, metrics_list[]}]}` | **campaign × date** | 347 ms |
| `/api/v2/ads/get_product_campaign_hourly_performance` | VERIFIED_PROD | `performance_date` + `campaign_id_list` | same shape, 24 `metrics_list` rows with `hour` | **campaign × date × hour** | 354 ms |
| `/api/v2/ads/get_recommended_item_list` | VERIFIED_PROD | — | **array** of 20 `{item_id, item_status_list[], sku_tag_list[], ongoing_ad_type_list[]}` | none observed | 376 ms |

- **Rate limit:** none encountered. 12 sequential calls with a 1 s gap took 20.5 s; there were no 429 or `error_*` answers.
- **Not tested:** any further `campaign_id_list` page; date ranges longer than 3 days; maximum ids per call.

### 3.1 Hierarchy and identity

Hierarchy observed: **shop → product-level campaign (`campaign_id`) → advertised item(s)** (`common_info.item_id_list`).
- Shopee calls the entity "product level campaign".
- There is no ad-group level.
- Keywords and placements were not seen: `campaign_placement` is an attribute, not a child entity.

| field | type | example (sanitized) | confidence | notes |
|---|---|---|---|---|
| `campaign_id` | integer | 900000001 | VERIFIED | Stable provider id. Identity = (shop, `campaign_id`). The real value is masked in fixtures. |
| `ad_type` | string | `manual` | VERIFIED (raw) | Only `manual` was seen in the first 50. `auto` is UNKNOWN. |
| `common_info.ad_name` | string | "Ad #1" (masked) | VERIFIED | Campaign name (placeholder in fixtures). |
| `common_info.campaign_status` | string | `ended` | VERIFIED (raw) | Only `ended` was seen (the 5 oldest campaigns). Other values UNKNOWN. |
| `common_info.bidding_method` | string | `auto` | VERIFIED (raw) | |
| `common_info.campaign_placement` | string | `all` | VERIFIED (raw) | |
| `common_info.campaign_budget` | integer | 10000 | LIKELY VND | Daily vs total and the meaning of 0 are UNKNOWN. |
| `common_info.campaign_duration.start_time` / `end_time` | integer epoch seconds | 1743354000 | VERIFIED | 1743354000 = 2025-03-31 00:00 in VN. |
| `common_info.item_id_list` | integer[] | [900000051] | VERIFIED | Advertised item ids. The same masked id appears in `get_recommended_item_list`, so the relation is preserved. |
| `auto_bidding_info.roas_target` | number | 0 | VERIFIED (raw) | Meaning of 0 UNKNOWN (no target?). |
| `manual_bidding_info`, `auto_product_ads_info` | null | null | VERIFIED nullable | Shape when non-null is UNKNOWN. |
| `shop_toggle_info.auto_top_up` / `campaign_surge` | boolean | true / false | VERIFIED (raw) | Shop-level Ads settings, read only. |
| `total_balance` | integer | 89446 | LIKELY VND | Ads account balance. |
| `data_timestamp` | integer epoch seconds | 1793177923 | VERIFIED | Equals the time of the call (2026-10-28 08:58:43 UTC), i.e. a snapshot time. |
| `region` | string | `VN` | VERIFIED | **No explicit currency field anywhere.** |
| recommended `item_status_list` / `ongoing_ad_type_list` | string[] | `normal` / `product_ads`, `no_ongoing_promotion` | VERIFIED (raw) | |

### 3.2 Performance fields

Shop-level rows (`get_all_cpc_ads_*`) and campaign-level rows (`metrics_list`) use **different field sets**.

| field | shop daily/hourly | campaign daily/hourly | type | meaning | confidence |
|---|---|---|---|---|---|
| `date` | ✓ | ✓ | string DD-MM-YYYY | report date | VERIFIED format; timezone LIKELY shop-local (VN): today's row appears for the VN date |
| `hour` | hourly only | hourly only | integer 0–23 | hour of day | VERIFIED |
| `impression` | ✓ | ✓ | integer | impressions | VERIFIED (Σ hourly = daily exactly) |
| `clicks` | ✓ | ✓ | integer | clicks | VERIFIED (Σ hourly = daily) |
| `expense` | ✓ | ✓ | integer | **spend**, VND, **rounded to a whole đồng** (`cost_per_conversion × broad_order` gives 41623.46 vs `expense` 41623) | VERIFIED unit / rounding; Σ hourly = daily ±1 đồng |
| `direct_order` / `broad_order` | ✓ | ✓ | integer | attributed orders, direct ≤ broad | VERIFIED arithmetic; attribution semantics UNKNOWN |
| `direct_item_sold` / `broad_item_sold` | ✓ | — | integer | attributed units | VERIFIED (Σ hourly = daily) |
| `direct_gmv` / `broad_gmv` | ✓ | ✓ | integer | attributed sales, VND, direct ≤ broad | VERIFIED arithmetic; semantics UNKNOWN (see §3.3) |
| `ctr` | ✓ | ✓ | number (4 dp) | clicks / impression | VERIFIED (4 days) |
| `direct_conversions` / `broad_conversions` | ✓ | — | number (4 dp) | direct_order / clicks, broad_order / clicks | VERIFIED |
| `direct_roas` / `broad_roas` | ✓ | — | number (2 dp) | gmv / expense | VERIFIED; ratio-of-sums of hourly = provider daily (10.367 vs 10.37); the average of hourly ratios (9.376) is wrong |
| `cost_per_conversion` | ✓ | — | number (2 dp) | expense / **broad**_order (computed on the unrounded expense) | VERIFIED |
| `broad_order_amount`, `direct_order_amount` | — | ✓ | integer | units sold (≥ orders on every row; Σ campaigns 51 / 42 vs shop `*_item_sold` 54 / 43, the same gap as orders) | LIKELY (1A.1) |
| `broad_roi`, `direct_roi` | — | ✓ | number (2 dp) | round2(gmv / expense) = ROAS | VERIFIED 99/99 rows (1A.1) |
| `broad_cir`, `direct_cir` | — | ✓ | number (2 dp) | round2(expense / gmv) = ACOS, too coarse to keep | VERIFIED 100/100 (1A.1) |
| `cr`, `direct_cr` | — | ✓ | number (4 dp) | broad_order / clicks, direct_order / clicks | VERIFIED 100/100 (1A.1) |
| `cpc` | — | ✓ | number | **expense / broad_order** (cost per broad conversion; 0 when there are no orders). **It is NOT cost per click**, despite the name. | VERIFIED 100/100 (1A.1) |
| `cpdc` | — | ✓ | number | expense / direct_order (cost per direct conversion) | VERIFIED 100/100 (1A.1) |

**Provider ratio vs derived ratio.** At shop level all 5 ratios equal the derived value to the provider's rounding, on all 4 days. A future sync should store the primitives (impression, clicks, expense, orders, gmv) and derive ratios as ratio-of-sums. Provider ratios are rounded and must never be averaged.

**Campaign-level values: verified in 1A.1.** The test covered 100 non-zero rows: 43 campaigns for 27/10, a 7-day sample of 5 campaigns, and 24 hourly rows. Σ hourly = daily for one campaign, exactly except `expense` (−2 đ, rounding). Σ campaigns ≠ shop total; see §3.5.

### 3.3 Money, currency, attribution, delay

- **Money: VERIFIED integer VND, major unit (đồng).**
  - Magnitudes are consistent: CPC ≈ 1,060 đ; about 270k đ per order.
  - The shop's own orders on the same days are in the same millions range (§3.4). Minor units would be 100× too small.
  - `expense` is rounded to a whole đồng by the provider.
- **Currency:** no field exists. It is inferred from `region: "VN"` and the shop currency, so the schema must not assume one silently.
- **Attribution: UNKNOWN.**
  - `direct_*` ≤ `broad_*` on every row. On 28/10 (partial day) direct equals broad.
  - No attribution window is exposed.
  - Ads orders are **not** the shop's orders of that date: on 26/10 Ads `broad_order` was 46 while the shop had 38 orders that day (cancelled ones included). Ads orders are therefore counted by a rule other than "order created that day"; possibly they are attributed to the click date or counted per item.
- **Today is partial: VERIFIED.** 28/10 at 15:58 VN showed 21,175 impressions, against ≈28–38k for a full day.
- **Delay and restatement: UNKNOWN.** The same completed day was read twice about 1 s apart with identical results, which is no evidence of later restatement. A re-read of 25–27/10 on a later day is needed.

### 3.4 Cross-check against the shop's own orders (cloud DB, read-only)

CTV Bedding, orders by `created_at_channel` (VN date):

| date | all orders (amount) | excl. cancelled | Ads `broad_order` / `broad_gmv` | Ads `direct_order` / `direct_gmv` |
|---|---|---|---|---|
| 25/10 | 44 (6,171,622) | 33 (4,092,909) | 44 / 7,310,650 | 38 / 6,708,090 |
| 26/10 | 38 (7,600,533) | 34 (6,777,477) | 46 / 9,596,330 | 35 / 8,691,680 |
| 27/10 | 45 (9,595,336) | 33 (7,505,752) | 52 / 11,447,308 | 41 / 10,966,208 |

The units agree, but the Ads numbers are not a subset of the same-day shop orders. Label the metrics with Shopee's own terms (direct/broad) and never present them as "the shop's revenue".

## 3.5 Expansion probe findings (ADS-1A.1, 2026-10-28 09:25 UTC, CTV Bedding, 12 GET requests)

Fixtures: `exp-*.json` and `_probe-report-expansion.json`.

**Pagination: VERIFIED.**
- `limit=100` is accepted. Page 1 returned 100 rows with `has_next_page: true`; `offset=100` returned 43 rows with `has_next_page: false`.
- Termination is `has_next_page=false`. The shop has **143 campaigns**.
- The maximum `limit` is UNKNOWN; 100 is verified. Up to 50 ids per `campaign_id_list` call is verified for both setting and performance.

**Date ranges: VERIFIED.**
- Shop daily: 7 days gave 7 rows, 30 days gave 30 rows. 30 days covers the dashboard preset.
- Campaign daily: 7 days gave 7 rows per campaign.
- Longer ranges were not tested.

**Campaign vs shop reconciliation (27/10, FULL coverage: 143/143 campaigns, `has_next_page=false`):**

| metric | shop `get_all_cpc_ads_daily_performance` | Σ 143 product campaigns | delta (shop − Σ) |
|---|---|---|---|
| expense | 1,104,162 | 1,072,671 | **31,491** (2.9 %) |
| impression | 36,145 | 29,727 | **6,418** (17.8 %) |
| clicks | 1,042 | 960 | **82** (7.9 %) |
| direct_order | 41 | 40 | 1 |
| broad_order | 52 | 49 | 3 |
| direct_gmv | 10,966,208 | 10,921,748 | 44,460 |
| broad_gmv | 11,447,308 | 11,140,148 | 307,160 |

**Conclusion: VERIFIED that the shop-level "all CPC ads" total is larger than the sum of product-level campaigns.** Coverage is complete, so the gap is not a pagination problem. What the remainder is remains UNKNOWN: other CPC ad types such as shop/search ads, or deleted campaigns. Consequences:
- **Shop totals must be stored separately** and never derived from campaign sums.
- Campaign rows are a **breakdown**, not a partition, of the shop total.

**Status: VERIFIED raw values** `ongoing` (43), `paused` (57), `closed` (17), `ended` (26).
- All 43 `ongoing` campaigns spent on 27/10, and **no campaign with another status spent**. So `ongoing` means running.
- `ended`: `end_time` is always set and in the past, so it LIKELY means the end date passed.
- `closed`: 12 have `end_time` = 0 and 5 have it set. How `closed` differs from `paused` is UNKNOWN.
- `end_time` = 0 means no end date (VERIFIED on all `ongoing` and `paused`).

**Type, bidding, placement (raw values):**
- `ad_type`: only `manual` (143/143).
- `bidding_method`: `auto` (126) or `manual` (17).
- `campaign_placement`: `all`, `search` or `discovery`. Search/discovery appear only with manual bidding.

**Budget:**
- **`campaign_budget` is a DAILY cap (VERIFIED by behaviour).** Campaign #40 (budget 300,000) spent exactly 300,000 on 26/10 and on 27/10, while its 7-day spend is 1,036,190, more than the budget, so the budget is not a lifetime total.
- All running campaigns have a budget > 0. `campaign_budget = 0` appears only on paused/closed/ended campaigns (16); its meaning (unlimited?) is UNKNOWN.

**`roas_target`:**
- Present only when `bidding_method = auto` (`auto_bidding_info`). With manual bidding, `auto_bidding_info` is null.
- 0 appears only on the 5 oldest auto campaigns (2025-03); its meaning is UNKNOWN.
- Achieved ROAS is often below the target, so the target does not bind the reported values.

**Manual bidding details (read-only):**
- `manual_bidding_info.selected_keywords[]` with `{keyword, status active|deleted, match_type exact|broad, bid_price_per_click}`.
- `discovery_ads_locations[]` with `{location daily_discover|you_may_also_like, status active|inactive, bid_price}`.
- `enhanced_cpc` (only false was seen).
- Bids are integers, VND by consistency.
- Keyword text is masked in fixtures. These are child settings of a campaign, not performance entities.

**Products:** every campaign has exactly **1** item (`item_id_list` length is always 1). 101 distinct items; 29 items are advertised by more than one campaign.

**Anomaly:** one campaign row has `broad_order = 1` with `broad_gmv = 0`. The row is still valid (orders without GMV); the reason is UNKNOWN.

**Restatement:** 25, 26 and 27/10 are **UNCHANGED** between 08:58 and 09:25 UTC (27 min) on every primitive field and ratio. Both reads were made on the same day, so this is **INSUFFICIENT_EVIDENCE** for cross-day restatement. 22–27/10 also match across the 7- and 30-day calls.

**Latency / rate limit:** 300–800 ms per call (the first call ~800 ms). 12 sequential calls took 22 s with no throttling.

## 4. Unknowns still open (for ADS-1B)

1. Attribution window and attribution date (click date?). Whether cancelled or unpaid orders are counted.
2. Cross-day restatement: run the expansion probe again on a later day and compare 21–27/10 with the `exp-` fixtures. Until then, the **temporary** overlap policy is to re-fetch D-7 … D-1 on every sync.
3. What makes up the shop-minus-campaigns remainder (§3.5).
4. `closed` vs `paused`; `campaign_budget = 0`; `roas_target = 0`; whether `ad_type = auto` campaigns exist anywhere.
5. Maximum `limit`, maximum ids per call, maximum date range beyond 30 days.
6. Rate limits: none observed in 24 calls across both probes.
