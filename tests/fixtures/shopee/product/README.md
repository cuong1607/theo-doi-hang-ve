# Shopee product fixtures (SHOPEE-2)

Hand-written from the **documented** response examples of
`v2.product.get_item_list`, `v2.product.get_item_base_info` and
`v2.product.get_model_list` — **not** captured from a real Go-Live shop.
They exercise our parsing/mapping; they do not prove Shopee's real shape.
Replace/extend with sanitized real payloads once the app is live
(docs/shopee-financial-core.md → "Product real-payload validation").

Used only by tests and by the local fixture provider (fixture shops,
`shops.data_source = 'fixture'`). Never loaded in production.

| item_id | status | has_model | case covered |
|---|---|---|---|
| 800000101 | NORMAL | no | item SKU in UPPERCASE vs internal lowercase SKU (case-insensitive exact match) |
| 800000102 | NORMAL | yes (3) | model SKU exact match, SKU with outer spaces, blank model SKU |
| 800000103 | NORMAL | no | blank item_sku |
| 800000104 | UNLIST | no | SKU not in the internal catalog |
| 800000105 | SELLER_DELETE | yes (1) | deleted listing still synced |
| 800000106 | NORMAL | no | kit / bundle (`tag.kit = true`) |
