# Shopee return-logistics fixtures (SHOPEE-6B)

Hand-written from the **documented** field names of
`v2.returns.get_reverse_tracking_info`, `v2.logistics.get_tracking_number` and
`v2.logistics.get_tracking_info` — **not** captured from a real VN shop.
Status values (`LOGISTICS_DELIVERY_DONE`, `RETURNED`, …) are the documented enums
and are CANDIDATES until a real payload confirms them
(docs/shopee-return-operations.md §API validation). Replace / add real sanitized
payloads captured with `npm run shopee:live -- returns --save` / `failed --save`.

Loaded by `loadReturnLogisticsFixtures()` (fixture provider mode):
`reverse-tracking-<return_sn>.json` (by `response.return_sn`) and
`tracking-info-<order_sn>.json` (by `response.order_sn`; optional top-level
`tracking_number` feeds `get_tracking_number`).

| file | case |
|---|---|
| reverse-tracking-FIXTURE-RET-1.json | warehouse → seller (post-return) with a delivered event |
| reverse-tracking-FIXTURE-RET-2.json | post-return delivered status, no detailed event (fallback to update_time) |
| tracking-info-FIXTURE-FD-1.json | failed delivery → RETURNED to the seller |
