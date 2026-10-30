# Shopee Product Analytics API — discovery (SHOPEE-PRODUCT-ANALYTICS-1)

Status 2026-10-30. **READ ONLY.** No canonical schema yet. No product, price, stock, listing or Ads write exists or is reachable (`src/lib/channels/shopee/product-analytics/read-only-policy.ts`, guarded by `product-analytics-discovery.test.ts`).

## 1. Summary

| Question | Answer (evidence level) |
|---|---|
| Is there a Shopee Open Platform v2 API for the product **traffic / funnel** of Seller Centre "Business Insights" (visitors, product impressions, add-to-cart, conversion, traffic source)? | **No evidence of one.** Not in our code, not in any Shopee module index we could reach, not in secondary references. Classified `SELLER_CENTRE_ONLY`. Absence is not proven: the official doc site could not be fetched from this environment. |
| Which product performance read **does** exist? | `GET /api/v2/product/get_item_extra_info`. **Route and shape verified** on the real Shopee gateway (sandbox, 2026-10-30): HTTP 200, `item_id`, `sale`, `views`, `likes`, `rating_star`, `comment_count`. **Production values not yet read** (see §6). |
| Sales (GMV / orders / units) per item per day? | `DERIVABLE` from internal orders (`channel_orders` / `channel_order_items`, synced from `get_order_list` + `get_order_detail`). Subject to order-sync coverage (§7). |
| Join key Product ↔ Ads | Shopee `item_id`. Internal orders `channel_order_items.external_item_id`, Ads `shopee_ads_campaign_products.provider_item_id` and `shopee_ads_products.provider_item_id` are all the same decimal text of `item_id`. **Verified on production** (§7): 180 / 217 ordered items match an Ads item exactly as text, within the same shop. The probe also checks it per item. |

## 2. Endpoint evidence policy

Endpoint names are never guessed. Each candidate carries its evidence in `PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES`:

| Path | Method | Evidence | Result |
|---|---|---|---|
| `/api/v2/product/get_item_extra_info` | GET | Shopee v2 Product module reference (secondary snapshot 2026-09-06: `item_id_list` ≤ 50 → sale / views / likes / rating_star / comment_count) | **200 OK** (sandbox), 4 / 4 items returned, 110–280 ms |
| `/api/v2/product/get_this_endpoint_does_not_exist` (control) | GET | Must not exist | **404 `error_not_found`** (sandbox), so a candidate's 200 is meaningful |

The policy has no POST reads (`PRODUCT_ANALYTICS_APPROVED_POST_READS = []`). If an analytics read ever turns out to be POST, the rule is: stop, document it, and review it separately.

Not called, on purpose: `get_item_list` (catalogue scan), `get_model_list`, every write endpoint.

## 3. `get_item_extra_info`

| | |
|---|---|
| Method | GET (signed shop-level call, the same connector / signing / token flow as everything else) |
| Params | `item_id_list`: comma-joined item ids; documented max 50 per call (not exercised beyond 4) |
| Item filtering | **Yes, explicit item ids.** It is not a shop-wide report. Sync cost is about ⌈items / 50⌉ calls per refresh. |
| Pagination | None (bounded by `item_id_list`) |
| Date window | **None.** No date parameter exists, so each call is a point-in-time counter snapshot. Day / 7-day values can only come from **differencing our own daily snapshots**, and only if the counters prove to be cumulative and monotonic (§6). |
| Timezone | n/a (no date) |
| Missing ids | Unknown for this endpoint. `get_item_base_info` omits unknown ids silently (ADS-3A.2), and the probe reports `returned=false` per requested item. |
| Restatement | UNKNOWN |

### Field inventory (sandbox payload; production pending)

| Provider field | Type | Example (sanitized) | Grain | Unit | Nullable | Semantic confidence |
|---|---|---|---|---|---|---|
| `response.item_list[].item_id` | number (int64) | 900000001 (placeholder) | item | id | no | HIGH: same id as orders and Ads |
| `response.item_list[].sale` | number | 0 | item, point in time | count (units? orders?) | no | **LOW**: cumulative "sold" counter suspected, not proven (§6) |
| `response.item_list[].views` | number | 0 | item, point in time | count | no | **LOW**: cumulative product page views suspected, not proven |
| `response.item_list[].likes` | number | 0 | item, point in time | count | no | MEDIUM: favourite count |
| `response.item_list[].rating_star` | number | 0 | item, point in time | 0–5 | no | MEDIUM: average rating |
| `response.item_list[].comment_count` | number | 0 | item, point in time | count | no | MEDIUM: review count |
| `error`, `message`, `warning`, `debug_message`, `request_id` | string | "" | envelope | | no | HIGH |

Sanitized fixtures are in `src/lib/channels/shopee/product-analytics/__fixtures__/provider/`: `sandbox-item-extra-info.json` and `sandbox-control-not-found.json`. Production fixtures are added by `import-cloud` (§6).

## 4. Sales semantics (internal orders)

The definitions come from the analytics read model (`00059`), not from new code:

| Term | Exact meaning |
|---|---|
| Order counted as a sale | `analytics_is_sales_status(order_status)`: READY_TO_SHIP, PROCESSED, RETRY_SHIP, SHIPPED, TO_CONFIRM_RECEIVE, COMPLETED, TO_RETURN. **Paid / confirmed orders**, excluding UNPAID, CANCELLED and IN_CANCEL. Not "completed only". |
| Business date | `created_at_channel` (order **placed** time) in Asia/Ho_Chi_Minh |
| Units | `sum(channel_order_items.quantity)` |
| Orders (item) | Distinct orders containing the item |
| Item sales value | `discounted_unit_price × quantity` (the buyer-facing item price after seller discounts, before platform vouchers / fees) |
| GMV (order) | `channel_orders.channel_total_amount`. Never summed across lines. |
| Buyers | **Not derivable.** Buyer identity is deliberately not stored (PII). Unique buyers would need a separate privacy decision (for example a salted buyer hash). |
| Returns | `channel_returns` / `channel_return_items`, separate from sales |

## 5. Traffic and funnel semantics

| Term | Available as | Notes |
|---|---|---|
| Product impressions (all traffic) | SELLER_CENTRE_ONLY | No API evidence |
| Ads impressions | VERIFIED_API (Ads) | `shopee_ads_campaign_daily_performance.impression`, campaign × day. A product campaign usually has one item, but the grain is the **campaign**. |
| Product page views | `get_item_extra_info.views`, point-in-time counter | Semantics pending (§6). Not the same thing as visitors. |
| Visitors (unique) | SELLER_CENTRE_ONLY | No API evidence |
| Clicks | Ads clicks only (VERIFIED_API) | Organic clicks: SELLER_CENTRE_ONLY |
| Add to cart / ATC users / ATC rate | SELLER_CENTRE_ONLY | |
| Conversion | SELLER_CENTRE_ONLY (product funnel) | An Ads-only ratio (broad orders / ad clicks) is derivable for Ads traffic. It is **not** product conversion. |
| Traffic source (Ads / Search / Recommendation / Shop / External) | SELLER_CENTRE_ONLY | "Organic" is never derived. |

**Attribution rule (permanent):** never compute organic GMV = total GMV − Ads GMV, nor organic orders = total − Ads orders. Ads direct / broad attribution overlaps with every other source.

## 6. Production probe (pending one admin run)

The production partner key lives only on Vercel. A pulled env file has it masked, so the local tool cannot sign production calls. The probe therefore runs **inside the app**:

1. Deploy, then open `/shopee/product-analytics/probe` (admin, `channel:manage`, not in the navigation).
2. For each shop, paste the sample item ids and type `READ-ONLY`. Each run makes 2 GET calls (control + one `get_item_extra_info`).
3. The page shows provider counters next to internal sales (lifetime-in-DB + last 7 completed days) and Ads 7-day impressions / clicks for the **same items**, plus the per-item Ads join check. It stores one `channel_api_snapshots` row (`entity_type = 'product_analytics_probe'`).
4. Locally: `node --env-file=.env.local scripts/shopee/product-analytics-discovery.ts import-cloud` (SELECT only) writes sanitized fixtures `item-extra-info-*-prod-N.json` and `comparison-prod-N.json`.

Recommended sample: 8 items, 4 shops, chosen from the last 7 completed days (23–29/10) of internal sales and Ads spend.

| Shop | Item | Why |
|---|---|---|
| congtrang carpet | 24740290518 | #1 sales, heavy Ads |
| congtrang carpet | 41630539392 | sells, no Ads |
| congtrang carpet | 57166544274 | Ads spend, 1 sale |
| CTV Bedding & decor Store | 26579209054 | high sales, Ads |
| CTV Bedding & decor Store | 29081317054 | sells, no Ads |
| RUGLUX | 41273005603 | high sales, Ads |
| RUGLUX | 28843986313 | sells, no Ads |
| HOMIES Bedding & Décor Store | 18517610369 | Ads clicks + 5 broad orders, no internal orders (shop not order-synced) |

What the run decides:
- `sale` ≥ internal units since the first synced order means cumulative (lifetime).
- `views` ≫ Ads clicks means page views across all traffic.
- A second run a day later shows whether the counters are monotonic. If they are, daily deltas become `DERIVABLE`.

## 7. Data quality found during discovery (production, read-only)

- **Order sync coverage:** only 3 of the 5 live shops have orders (congtrang carpet since 2026-10-16, CTV since 2026-10-01, RUGLUX since 2026-10-16). congtrangbedding and HOMIES have **0 orders** but active Ads (HOMIES: 5 broad orders in 7 days), so their sales are not derivable today.
- **Core sync stopped:** every non-Ads sync job (order, escrow, return, product …) was last created at **2026-10-28 04:10 UTC**. The scheduler answers `"autoSyncDisabled": true`, which means `SHOPEE_AUTO_SYNC_ENABLED=false` on Vercel. Ads sync is unaffected. Until it is re-enabled, internal sales for 28/10 onward are incomplete. Not changed in this phase.
- **Join key (2026-10-30, SELECT only):** distinct ordered items vs Ads items per shop.
  - congtrang carpet: 75 / 85.
  - CTV: 54 / 66.
  - RUGLUX: 51 / 66.

  Across the three shops, 180 / 217 ordered items exactly equal `shopee_ads_campaign_products.provider_item_id` and `shopee_ads_products.provider_item_id` (identical counts). There are 0 non-numeric ids and 0 cross-shop matches. The other 37 items have no Ads campaign row.
- `get_item_base_info` (production) returns `has_model, image, item_id, item_name, item_sku, item_status, update_time`, so **no `category_id`** in the current payload. Category is UNKNOWN; it would need a separately verified optional field.

## 8. Capability matrix

| Metric | API field / source | Grain | Status | Notes |
|---|---|---|---|---|
| Sales value | `channel_order_items` (`get_order_detail`) | order line → item / model / VN day | DERIVABLE | Coverage §7 |
| GMV (order) | `channel_orders.channel_total_amount` | order / day | DERIVABLE | Order-level only |
| Orders | internal orders | item / day | DERIVABLE | Paid / confirmed statuses (§4) |
| Units | internal orders | item / model / day | DERIVABLE | |
| Lifetime sold counter | `get_item_extra_info.sale` | item, snapshot | VERIFIED_API (shape) | Semantics pending §6 |
| Buyers | — | — | NOT AVAILABLE | No buyer identity stored (PII) |
| Views | `get_item_extra_info.views` | item, snapshot | VERIFIED_API (shape) | Daily only by differencing, if monotonic |
| Visitors | — | — | SELLER_CENTRE_ONLY | |
| Impressions (all) | — | — | SELLER_CENTRE_ONLY | |
| Impressions (Ads) | Ads daily / hourly | campaign × day / hour | VERIFIED_API | |
| Clicks (Ads) | Ads daily / hourly | campaign × day / hour | VERIFIED_API | |
| Add to cart | — | — | SELLER_CENTRE_ONLY | |
| Conversion (product) | — | — | SELLER_CENTRE_ONLY | Ads-only ratio derivable, not product CVR |
| Traffic source | — | — | SELLER_CENTRE_ONLY | No "organic" derivation |
| Likes / rating / reviews | `get_item_extra_info` | item, snapshot | VERIFIED_API (shape) | |
| Product status | `get_item_base_info.item_status` | item | VERIFIED_API | NORMAL / UNLIST / SELLER_DELETE seen |
| Category | — | — | UNKNOWN | Not in the current base-info payload |
| Model-level sales | `channel_order_items.external_model_id` | model / day | DERIVABLE | |
| Hourly sales | `created_at_channel` | order / hour | DERIVABLE | Timestamp precision; same coverage caveats |

Period support (1 / 3 / 7 / 30 days / custom): any window is computable for DERIVABLE metrics (VN days). `get_item_extra_info` has no window, so periods require stored daily snapshots.
