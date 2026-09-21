-- ============================================================
-- PHASE 9: Daily receipt detail (date + supplier) data layer
-- ============================================================
-- Both views back the /receipts/daily/[date]/[supplierId] screen. All
-- aggregation (SUM/GROUP BY, distinct-price detection) lives here so the
-- app layer only ever reads already-aggregated rows — no per-row math in
-- React, and a single filtered SELECT per view (no N+1).

-- ------------------------------------------------------------
-- 1. v_daily_receipt_product_summary: add per-shift difference_qty
--    (existing morning/afternoon columns only had delivered/received/line_total)
--    and distinct unit_price arrays so the UI can detect "one price" vs
--    "nhiều mức giá" without assuming all snapshots agree.
--    CREATE OR REPLACE VIEW only appends columns — existing consumers of the
--    prior columns are unaffected.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_daily_receipt_product_summary AS
SELECT
  r.receipt_date,
  r.supplier_id,
  ri.product_id,
  p.sku,
  p.name AS product_name,
  p.unit,

  -- Sáng (original columns, unchanged order)
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'morning'), 0) AS morning_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'morning'), 0) AS morning_received_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'morning'), 0) AS morning_line_total,

  -- Chiều (original columns, unchanged order)
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_received_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_line_total,

  -- Cả ngày (original columns, unchanged order)
  COALESCE(SUM(ri.delivered_qty),  0) AS total_delivered_qty,
  COALESCE(SUM(ri.received_qty),   0) AS total_received_qty,
  COALESCE(SUM(ri.difference_qty), 0) AS total_difference_qty,
  COALESCE(SUM(ri.line_total),     0) AS total_line_total,

  -- New columns for Phase 9 — appended at the end; CREATE OR REPLACE VIEW
  -- cannot reorder or insert among existing columns, only append.
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'morning'), 0)
    - COALESCE(SUM(ri.delivered_qty) FILTER (WHERE r.shift = 'morning'), 0) AS morning_difference_qty,
  ARRAY_REMOVE(ARRAY_AGG(DISTINCT ri.unit_price) FILTER (WHERE r.shift = 'morning'), NULL) AS morning_unit_prices,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'afternoon'), 0)
    - COALESCE(SUM(ri.delivered_qty) FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_difference_qty,
  ARRAY_REMOVE(ARRAY_AGG(DISTINCT ri.unit_price) FILTER (WHERE r.shift = 'afternoon'), NULL) AS afternoon_unit_prices,
  ARRAY_AGG(DISTINCT ri.unit_price) AS total_unit_prices

FROM public.receipts r
JOIN public.receipt_items ri ON ri.receipt_id = r.id
JOIN public.products p       ON p.id = ri.product_id
GROUP BY r.receipt_date, r.supplier_id, ri.product_id, p.sku, p.name, p.unit;

-- ------------------------------------------------------------
-- 2. v_receipt_summary: one row per receipt with its own item count and
--    total amount, for the "Phiếu nguồn" table and the per-shift receipt
--    lists (mã phiếu / người nhận / giờ tạo).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_receipt_summary AS
SELECT
  r.id AS receipt_id,
  r.receipt_no,
  r.receipt_date,
  r.shift,
  r.supplier_id,
  r.receiver_name,
  r.note,
  r.created_at,
  COUNT(ri.id) AS sku_count,
  COALESCE(SUM(ri.line_total), 0) AS total_amount
FROM public.receipts r
LEFT JOIN public.receipt_items ri ON ri.receipt_id = r.id
GROUP BY r.id, r.receipt_no, r.receipt_date, r.shift, r.supplier_id, r.receiver_name, r.note, r.created_at;
