# Shopee Ads — Read-only policy

> **Standing rule from 2026-10-28.** It applies to the whole Ads roadmap until the user explicitly writes **"cho phép sửa campaign"**. Even then, write access needs its own mutation-safety phase.
>
> Write access is never inferred from words like "optimization", "recommendation", "budget analysis" or "campaign management".

## 1. What is allowed and forbidden

| Allowed (READ) | Forbidden (WRITE) |
|---|---|
| Campaigns and their status | Creating, editing, renaming or deleting a campaign |
| Budget and bid values | Pausing, resuming or stopping a campaign; changing its status |
| Performance: spend, impressions, clicks, orders, sales/GMV | Changing budget, bid, bidding strategy, target ROAS or schedule |
| Ads settings | Changing advertised products, keywords, keyword bids or placement |
| Product ↔ ad relationships | Changing Ads settings; calling any mutation endpoint |
| Metadata (name / SKU / image / status) of items **already referenced by Ads campaigns** — ADS-3A.2, one exact path | Any product / listing write: name, price, stock, image, SKU, model, unlist / publish, delete; any catalogue scan |

## 2. How each layer enforces it

| Layer | Enforcement |
|---|---|
| Policy (single source) | `src/lib/channels/shopee/ads/read-only-policy.ts`: <br>• `ADS_ALLOWED_HTTP_METHODS = ["GET"]` <br>• `ADS_APPROVED_POST_READ_ENDPOINTS = []` <br>• `isAdsReadOnlyPath` requires `/api/v2/ads/get_*` with no write token (create/edit/update/set/pause/resume/stop/delete/bid/…), or one EXACT path of `ADS_PRODUCT_READ_ENDPOINTS` (ADS-3A.2: only `/api/v2/product/get_item_base_info`; `get_item_list`, `get_model_list` and every product write stay refused) <br>• `assertAdsReadOnlyRequest` <br>• `isAdsReadJobType` <br>• `ADS_FORBIDDEN_IDENTIFIERS` |
| Provider | `ads/provider.ts` exposes read methods only (`get…` / `list…`). A real implementation must call `assertAdsReadOnlyRequest` before every request. |
| Endpoint allowlist | `ADS_PROBE_ENDPOINTS` in `ads/probe.ts`: 9 exact GET paths. No arbitrary path, no path built from user input, no generic raw request. |
| Probe / transports | `assertAdsProbeRequest` checks the policy and the allowlist. The server transport (`probe-server.ts`) and the CLI transport (`ads-discovery.ts`) call `assertAdsReadOnlyRequest` again before fetching. |
| Discovery CLI | `probe <path>` is refused unless `isAdsReadOnlyPath` passes; with `--prod`, the path must also be allowlisted. |
| Server actions | The only Ads action is `runAdsProbeAction`: admin only, typed `READ-ONLY`, and it calls the allowlisted probe only. |
| Jobs | Current types are `ads_campaign_read`, `ads_campaign_performance_read`, `ads_shop_performance_read`, `ads_shop_hourly_read` and `ads_campaign_hourly_read` (ADS-3A.1), `ads_product_enrichment_read` (ADS-3A.2), all `ads_<what>_read`. Types like `*_update`, `*_set`, budget, bid or status are never allowed. |
| UI | No Edit / Pause / Resume / Stop / Delete / Change budget / Change bid / Optimize / Apply buttons. <br>• "Cấu hình" opens the internal connection settings (`/settings/shopee`). <br>• The future "Cài đặt" tab is for internal dashboard settings only. <br>• Insights are advisory text. |
| Tests | `ads/read-only-guard.test.ts`, part of `npm test`; see §3. |

## 3. Guard tests (`read-only-guard.test.ts`)

The test fails if any of these happens:
- the policy accepts a non-GET method or a known or hypothetical write endpoint;
- the allowlist contains a non-read endpoint;
- a POST read exception is added without a review entry in §4 of this file;
- the provider declares or implements a method that is not `get…` / `list…`;
- Ads code contains `method: "POST" | "PUT" | "PATCH" | "DELETE"` (or any non-GET method);
- any `ADS_FORBIDDEN_IDENTIFIERS` entry (`createCampaign`, `setBudget`, `updateBid`, `changeStatus`, and since ADS-3A.2 `updateItem`, `updatePrice`, `updateStock`, `unlistItem`, …) appears in the Ads namespace. This needs a review; there is no auto-ignore;
- an Ads server action has a write-like name, or calls `/api/v2/ads/` directly;
- the UI renders a campaign mutation label in Vietnamese or English;
- an Ads job type (in code or migrations) contains a write token.

## 4. Reviewed exceptions

_None._ A Shopee read endpoint that uses POST would be listed here with:
- evidence that it is read-only (docs and a real payload);
- the reviewer's name and the date.

Only after that may it be added to `ADS_APPROVED_POST_READ_ENDPOINTS`.

## 5. Report requirement

Every Ads phase report ends with an **ADS WRITE SAFETY** section confirming:
- campaign mutations implemented: NO
- campaign mutations called: NO
- product mutations implemented / called: NO (since ADS-3A.2)
- budget mutations called: NO
- bid mutations called: NO
- status mutations called: NO
- Ads API mode: READ ONLY
