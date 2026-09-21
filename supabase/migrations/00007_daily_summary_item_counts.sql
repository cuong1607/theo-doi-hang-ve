-- ============================================================
-- PHASE 9: distinguish "no activity this shift" from "activity with 0 qty"
-- A receipt_item can legitimately have delivered_qty = received_qty = 0
-- (e.g. a line the supplier failed to deliver at all). Filtering Bảng 1/2
-- by qty > 0 would wrongly hide that row from its shift's table. Add an
-- explicit item count per shift so the app can filter on "was there a
-- receipt_item this shift" instead of guessing from quantities.
-- ============================================================
CREATE OR REPLACE VIEW public.v_daily_receipt_product_summary AS
SELECT
  r.receipt_date,
  r.supplier_id,
  ri.product_id,
  p.sku,
  p.name AS product_name,
  p.unit,
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'morning'), 0) AS morning_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'morning'), 0) AS morning_received_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'morning'), 0) AS morning_line_total,
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_received_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_line_total,
  COALESCE(SUM(ri.delivered_qty),  0) AS total_delivered_qty,
  COALESCE(SUM(ri.received_qty),   0) AS total_received_qty,
  COALESCE(SUM(ri.difference_qty), 0) AS total_difference_qty,
  COALESCE(SUM(ri.line_total),     0) AS total_line_total,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'morning'), 0)
    - COALESCE(SUM(ri.delivered_qty) FILTER (WHERE r.shift = 'morning'), 0) AS morning_difference_qty,
  ARRAY_REMOVE(ARRAY_AGG(DISTINCT ri.unit_price) FILTER (WHERE r.shift = 'morning'), NULL) AS morning_unit_prices,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'afternoon'), 0)
    - COALESCE(SUM(ri.delivered_qty) FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_difference_qty,
  ARRAY_REMOVE(ARRAY_AGG(DISTINCT ri.unit_price) FILTER (WHERE r.shift = 'afternoon'), NULL) AS afternoon_unit_prices,
  ARRAY_AGG(DISTINCT ri.unit_price) AS total_unit_prices,
  COUNT(ri.id) FILTER (WHERE r.shift = 'morning')   AS morning_item_count,
  COUNT(ri.id) FILTER (WHERE r.shift = 'afternoon') AS afternoon_item_count

FROM public.receipts r
JOIN public.receipt_items ri ON ri.receipt_id = r.id
JOIN public.products p       ON p.id = ri.product_id
GROUP BY r.receipt_date, r.supplier_id, ri.product_id, p.sku, p.name, p.unit;
