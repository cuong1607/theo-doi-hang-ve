# Shopee Ads API — verified inventory (SHOPEE-ADS-1)

> **Status 2026-10-28**
>
> - **Sandbox:** no Ads backend (see §2).
> - **Production:** the read-only probe (ADS-1A, §1) is built and deployable, but it has **not been run yet**. Every production endpoint is `NOT_TESTED`.
> - Nothing below is a verified fact unless it is marked ✅ or `VERIFIED_PROD`.

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

## 3. Field inventory

_Empty on purpose: no verified payload yet._ The ADS-1 spec forbids documenting guessed fields as facts. The inventory columns (provider field, type, nullable, meaning, example, canonical destination, notes) will be filled from the first production fixtures.

## 4. Open questions the first real payloads must answer

1. Grain of the shop-level and campaign-level performance: is it day, hour, campaign+day, or something else?
2. Campaign identity and hierarchy: is the product-level campaign the entity, and are there ads/keywords/placements under it?
3. Money fields: integer minor units, decimal or string; which currency; is spend reported as "expense" or "cost"?
4. Revenue/orders semantics: direct vs broad GMV and orders; what attribution window applies?
5. Status and type enums (raw values), and budget fields (daily or total; 0 = unlimited?).
6. Date parameter format, maximum range, whether today's data is partial, and how late a day keeps changing.
7. Whether the provider also returns ROAS/CTR/CPC, and whether those match ratio-of-sums.
