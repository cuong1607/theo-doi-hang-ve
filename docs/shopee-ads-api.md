# Shopee Ads API — verified inventory (SHOPEE-ADS-1)

> Status 2026-10-28: **discovery BLOCKED in the local environment.** The local
> connection is the Shopee **sandbox** (test partner 1247294, shop 227974291),
> and the sandbox has **no Ads service behind its gateway**. No Ads payload has
> been seen yet, so this file records route-level evidence only. No field,
> unit, grain, enum or semantic below is a verified fact unless it is marked ✅.

## 1. How to discover (tool)

`scripts/shopee/ads-discovery.ts` (`npm run shopee:ads -- …`, Git Bash: prefix
`MSYS_NO_PATHCONV=1`):

| command | what it does |
|---|---|
| `shops [--prod]` | lists connected live shops |
| `probe <path> ['{json}'] [--save name]` | one signed GET; prints HTTP status, latency, request id, provider error, raw body if not JSON, sanitized payload |
| `survey [--save] [--days N]` | control path + every candidate below with the smallest safe params; chains **real** campaign ids from the list into setting / performance calls; summary table |

Safety rules:
- Only `GET /api/v2/ads/get_*` can be called. Create, edit, status, bid, budget and delete endpoints are refused before any request is sent; this was checked with `create_manual_product_ads` and a non-Ads path.
- No retries, and at most one call per second.
- The signed URL is never printed. Token and partner key are scrubbed from response text. Secret-looking keys, and the shop and partner ids, are dropped from saved fixtures.
- Default mode uses the **local** connection only.
- `--prod` reads production tokens from the cloud DB **read-only** and never refreshes them, the same as `npm run shopee:live`. It refuses a sandbox host.

Fixtures go to `src/lib/channels/shopee/ads/__fixtures__/provider/<name>.json`, holding `_meta` (endpoint, params, environment, latency) plus the sanitized response. Only successful answers are saved.

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
