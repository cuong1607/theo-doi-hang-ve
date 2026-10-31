# Shopee Product Analytics API — discovery (SHOPEE-PRODUCT-ANALYTICS-1 / 1P)

Status 2026-10-30. **READ ONLY.** No canonical schema yet. No product, price, stock, listing or Ads write exists or is reachable (`src/lib/channels/shopee/product-analytics/read-only-policy.ts`, guarded by `product-analytics-discovery.test.ts`).

## 1. Summary

| Question | Answer (evidence level) |
|---|---|
| Is there a Shopee Open Platform v2 API for the product **traffic / funnel** of Seller Centre "Business Insights" (visitors, product impressions, add-to-cart, conversion, traffic source)? | **No evidence of one.** Not in our code, not in any Shopee module index we could reach, not in secondary references. Classified `SELLER_CENTRE_ONLY`. Absence is not proven: the official doc site could not be fetched from this environment. |
| Which product performance read **does** exist? | `GET /api/v2/product/get_item_extra_info`. **Route and shape verified** on the real Shopee gateway (sandbox, 2026-10-30): HTTP 200, `item_id`, `sale`, `views`, `likes`, `rating_star`, `comment_count`. **Production values pending the T0 / T1 probe** (§6, §9). |
| Sales (GMV / orders / units) per item per day? | `DERIVABLE` from internal orders (`channel_orders` / `channel_order_items`, synced from `get_order_list` + `get_order_detail`). **Historical only**: the legacy order sync is retired and the data stops on 2026-10-28 (§11). |
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

## 6. Production probe (Phase 1P: T0 / T1)

The production partner key lives only on Vercel. A pulled env file has it masked, so the local tool cannot sign production calls. The probe therefore runs **inside the app** (deployed with `d7f3065`):

1. Open `/shopee/product-analytics/probe` (admin, `channel:manage`, not in the navigation).
2. For each shop, paste that shop's ids from the table below and type `READ-ONLY`. Each run makes 2 GET calls (control + one `get_item_extra_info`) and stores one `channel_api_snapshots` row (`entity_type = 'product_analytics_probe'`).
3. **T0** = the first round (all 5 shops). **T1** = the same ids, same shops, after at least one VN calendar-day boundary (ideally ~24 h later). Optional T2…T6 = the multi-day follow-up (§10).
4. Locally, SELECT only:
   - `node --env-file=.env.cloud.local scripts/shopee/product-analytics-discovery.ts import-cloud` → sanitized `item-extra-info-*-prod-N.json` / `comparison-prod-N.json`.
   - `node --env-file=.env.cloud.local scripts/shopee/product-analytics-discovery.ts semantics <scratchpad-dir> --save` → raw T0/T1 report (real ids) in the scratchpad, sanitized `counter-semantics-prod.json` in the fixtures.

Deterministic sample (Phase 1P, 31 items, ≤ 10 per shop). Ads units = `direct_item_sold`, last 7 completed days 23–29/10, single-item campaigns only.

| Shop | Paste these ids | Why |
|---|---|---|
| congtrang carpet | `24740290518, 41630539392, 57166544274, 42561665440, 26712881612, 25236431835, 19683010672` | 3 documented + 2 steady Ads sellers (89 / 64 units) + UNLIST + SELLER_DELETE |
| congtrangbedding | `836784995, 17299424702, 29404533381, 1929607586, 1044744057, 1029794465` | top 4 Ads sellers (404 / 188 / 95 / 87 units, no internal orders) + UNLIST + SELLER_DELETE |
| CTV Bedding & decor Store | `26579209054, 29081317054, 43354039352, 28537487950, 25593260335, 26928860868` | 2 documented + 2 Ads sellers + UNLIST + SELLER_DELETE |
| HOMIES Bedding & Décor Store | `18517610369, 10096389022, 25892862147, 26177218303, 19206953794, 14579028831` | 1 documented + 3 top Ads sellers (542 / 136 / 132) + UNLIST + SELLER_DELETE |
| RUGLUX | `41273005603, 28843986313, 41715153913, 45859329555, 40430027131, 25497238258` | 2 documented + 2 Ads sellers + UNLIST + SELLER_DELETE |

Every NORMAL item above is the **only** item of its Ads campaign(s), so its hourly Ads `direct_item_sold` is a lower bound on its real units. UNLIST / SELLER_DELETE status comes from the Ads enrichment (`shopee_ads_products.provider_status`, ADS-3A.2).

What the comparison decides (`counter-semantics.ts`, pure, tested):

| Observation | Meaning |
|---|---|
| `sale` decreased between T0 and T1 | not a lifetime counter → `LIKELY_ROLLING` |
| `sale` below units already recorded in our orders for the item | not a lifetime counter → `LIKELY_ROLLING` |
| Δ`sale` < Ads `direct_item_sold` over the VN hours wholly inside [T0, T1] | lagging or differently defined → `LIKELY_OTHER` |
| Δ`sale` ≥ that lower bound, > 0, for ≥ 3 items, no contradiction | `LIKELY_CUMULATIVE` (LOW confidence with one interval) |
| no known sale in the interval | `INSUFFICIENT_EVIDENCE` |
| `views`: increase / flat / decrease / reset (≥ 100 → ≤ 10 %) | `MONOTONIC_SO_FAR` or `NON_MONOTONIC`; never "lifetime" from one interval |
| Item `returned` false at T0 / T1 | recorded as is (UNLIST / SELLER_DELETE behaviour). Omission never deletes anything. |

`sale` is never called daily units sold, and organic is never `sale − Ads`.

## 7. Data quality found during discovery (production, read-only)

- **Order data is a frozen history, not current truth (§11).** Only 3 of 5 shops ever had orders, and the last order sync ran 2026-10-28 ~04:10 UTC.
- **The stop is intentional (correction of the Phase 1 report).** `SHOPEE_AUTO_SYNC_ENABLED` only lets the scheduler enqueue the eight legacy job types (`order, product, escrow, return, return_logistics, failed_delivery, income, payout`, `sync-service.ts` `SCHEDULED_TYPES`). With `SHOPEE_LEGACY_MODULES_ENABLED=false` (the SHOPEE-ADS-0 retirement) `activeSyncTypes()` is empty anyway. Turning both on would resurrect orders, escrow, returns, payout and legacy products. **Keep both OFF.** Product Analytics needs its own minimal sales facts (§11), not the legacy sync.
- **Join key (2026-10-30, SELECT only):** distinct ordered items vs Ads items per shop.
  - congtrang carpet: 75 / 85.
  - CTV: 54 / 66.
  - RUGLUX: 51 / 66.

  Across the three shops, 180 / 217 ordered items exactly equal `shopee_ads_campaign_products.provider_item_id` and `shopee_ads_products.provider_item_id` (identical counts). There are 0 non-numeric ids and 0 cross-shop matches. The other 37 items have no Ads campaign row.
- `get_item_base_info` (production) returns `has_model, image, item_id, item_name, item_sku, item_status, update_time`, so **no `category_id`** in the current payload. Category is UNKNOWN; it would need a separately verified optional field.

## 8. Capability matrix

Structure and semantics are separate states and are never collapsed: **STRUCTURE VERIFIED** (field exists, type known), **SEMANTICS VERIFIED** (meaning proven over the multi-day follow-up), **SEMANTICS UNKNOWN**.

| Metric | API field / source | Grain | Status | Notes |
|---|---|---|---|---|
| Sales value | internal orders (`get_order_detail`) | order line → item / model / VN day | DERIVABLE **historically only** | No current source: legacy order sync retired (§11) |
| GMV (order) | `channel_orders.channel_total_amount` | order / day | DERIVABLE historically only | Order-level only |
| Orders | internal orders | item / day | DERIVABLE historically only | Paid / confirmed statuses (§4) |
| Units | internal orders | item / model / day | DERIVABLE historically only | |
| `sale` counter | `get_item_extra_info.sale` | item, snapshot | STRUCTURE VERIFIED (sandbox; production after T0) · **SEMANTICS UNKNOWN** | §6 / §9 |
| `views` counter | `get_item_extra_info.views` | item, snapshot | STRUCTURE VERIFIED (sandbox; production after T0) · **SEMANTICS UNKNOWN** | Daily values only by differencing, if proven monotonic |
| Buyers | — | — | NOT AVAILABLE | No buyer identity stored (PII) |
| Visitors | — | — | SELLER_CENTRE_ONLY | |
| Impressions (all) | — | — | SELLER_CENTRE_ONLY | |
| Impressions (Ads) | Ads daily / hourly | campaign × day / hour | VERIFIED_API | |
| Clicks (Ads) | Ads daily / hourly | campaign × day / hour | VERIFIED_API | |
| Ads units / orders | Ads `direct_item_sold` / `direct_order` | campaign × day / hour | VERIFIED_API | Attributed only: a lower bound, never total |
| Add to cart | — | — | SELLER_CENTRE_ONLY | |
| Conversion (product) | — | — | SELLER_CENTRE_ONLY | Ads-only ratio derivable, not product CVR |
| Traffic source | — | — | SELLER_CENTRE_ONLY | No "organic" derivation |
| Likes / rating / reviews | `get_item_extra_info` | item, snapshot | STRUCTURE VERIFIED | |
| Product status | `get_item_base_info.item_status` | item | VERIFIED_API | NORMAL / UNLIST / SELLER_DELETE seen |
| Category | — | — | UNKNOWN | Not in the current base-info payload |
| Model-level sales | `channel_order_items.external_model_id` | model / day | DERIVABLE historically only | |
| Hourly sales | `created_at_channel` | order / hour | DERIVABLE historically only | |

Period support (1 / 3 / 7 / 30 days / custom): any window is computable for DERIVABLE metrics (VN days) where data exists. `get_item_extra_info` has no window, so periods require stored daily snapshots.

## 9. T0 / T1 evidence (production)

_Pending: no production probe run yet (cloud `channel_api_snapshots` has 0 `product_analytics_probe` rows on 2026-10-30)._ This section is filled from `counter-semantics-prod.json` once T0 and T1 exist: per item `sale` / `views` / `likes` / `rating_star` / `comment_count` at T0 and T1, deltas, the Ads lower bound, the UNLIST / SELLER_DELETE behaviour, and the shop-wide verdict with its confidence.

## 10. Multi-day follow-up (design, if one interval is not enough)

- Same 31 ids, same admin page, **one round per day at roughly the same time, for 3–7 days** (5 × 2 GET calls per round).
- Same `semantics` command: it pairs consecutive runs per shop automatically. A verdict reaches MEDIUM confidence from 3 intervals.
- `SEMANTICS VERIFIED` only when every interval agrees, with ≥ 3 items per interval whose growth covered their Ads units (cumulative), or a consistent drop-off pattern (rolling window).
- Storage stays `channel_api_snapshots` (one row per run) plus fixtures: no canonical table and no scheduler. If PA-2 adopts the counters, a proper snapshot table is designed there.

## 11. Order data gap and `product_sales_facts_read` (concept only)

| Shop | Orders in DB | First order | Last order placed | Last order sync | Status |
|---|---|---|---|---|---|
| congtrang carpet | 843 | 2026-10-16 | 2026-10-28 04:06 UTC | 2026-10-28 04:10 UTC | **stale** (frozen history, 12 days) |
| CTV Bedding & decor Store | 953 | 2026-10-01 | 2026-10-28 03:36 UTC | 2026-10-28 04:09 UTC | **stale** (frozen history, 27 days) |
| RUGLUX | 327 | 2026-10-16 | 2026-10-28 04:00 UTC | 2026-10-28 04:08 UTC | **stale** (frozen history, 12 days) |
| congtrangbedding | 0 | — | — | never | **no data** |
| HOMIES Bedding & Décor Store | 0 | — | — | never | **no data** |

No shop has current-enough order data. Historical intervals stay usable as historical facts (e.g. "`sale` below units we already recorded"), never as current truth.

**Do not reactivate the legacy order sync** (§7). Future concept for PA-2, not implemented:

`product_sales_facts_read`: the minimal read-only product-level sales facts Product Analytics needs.
- Grain: shop × `item_id` × `model_id` × VN day (optionally hour). Columns: orders, units, item sales value, status bucket (paid / cancelled). No buyer identity, no address, no escrow / fee / payout, no returns.
- Source: a new, narrow sync job (its own type, not one of the eight legacy types) reading `get_order_list` (by `create_time` / `update_time` window) + `get_order_detail` (item lines only), through the read-only allowlist. No Orders UI, no escrow, no returns, no payout.
- Restatement: re-read the trailing N days (status changes, cancellations).

Source options for PA-2:

| Option | For | Against |
|---|---|---|
| **A.** Minimal read-only order API sync | Exact per-item / per-day / per-hour units, orders, value; proven endpoints (used before); covers all 5 shops | New job + table; PII must be dropped at mapping time; ~2 calls per order page |
| **B.** `get_item_extra_info` counters only | Cheap (⌈items / 50⌉ calls per day), no PII | Semantics unknown; no value / orders; snapshot only (no hour, no model); can't backfill |
| **C.** A + B | A is the truth for sales; B adds views / likes / rating where the semantics are proven | Two sources to keep consistent |

**Recommendation from current evidence: A (with B added later only if §9 / §10 prove its semantics → C).** The `sale` counter can at best yield daily units by differencing, with no value and no backfill, so it cannot replace order facts. `views` is the only traffic signal outside Seller Centre, which is why B is worth keeping if it proves monotonic.
