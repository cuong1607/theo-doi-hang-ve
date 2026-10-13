# Shopee order fixtures (SHOPEE-3)

Hand-written from the **documented** examples of `v2.order.get_order_list` and
`v2.order.get_order_detail` — **not** captured from a real Go-Live shop.
Item / model ids reuse the SHOPEE-2 product fixtures (`../product`) so a fixture
product sync followed by a fixture order sync maps end-to-end.

Only fields the Financial Core needs are present; recipient address, phone and
buyer identity are intentionally absent (they are never requested in live mode).

| order_sn | status | case |
|---|---|---|
| 251013NORMAL01 | READY_TO_SHIP | 1 line, variation-less item (`model_id: 0`) |
| 251013MULTI002 | PROCESSED | 3 lines: no-model item, kit item, blank item SKU |
| 251013MODELS03 | SHIPPED | 3 variations of one item, one with blank `model_sku` |
| 251013UNMAP004 | READY_TO_SHIP | SKU not in internal catalog + item missing from the Shopee catalog |
| 251013CANCEL05 | CANCELLED | cancelled order still synced |
| 251013COMPLT06 | COMPLETED | completed → eligible for financial sync later |
| 251013BUNDLE07 | READY_TO_SHIP | **synthetic**: bundle deal sharing one `order_item_id`, add-on line repeating the same model (unverified provider behaviour) |

`get-order-list-page-1.json` → `next_cursor: "fixture-cursor-2"` → `get-order-list-page-2.json` (`more: false`).
