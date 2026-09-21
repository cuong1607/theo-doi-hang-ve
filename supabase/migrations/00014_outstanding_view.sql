-- ============================================================
-- PHASE 12: Outstanding goods (hàng còn phải về) — tính động, không cache.
--
-- IMPORTANT — this intentionally reproduces the existing Excel workbook's
-- logic, not a general-purpose allocation engine:
--
--   received_qty (per invoice_item) =
--     SUM(receipt_items.received_qty)
--     WHERE same product_id
--       AND receipt.supplier_id = invoice.supplier_id
--       AND receipt.receipt_date >= invoice.invoice_date
--
-- This has NO upper date bound and no notion of "this receipt already
-- belongs to an earlier invoice". If the same supplier+SKU has multiple
-- invoices whose date ranges overlap, the same physical receipt can get
-- summed into more than one invoice's received_qty — i.e. DOUBLE-COUNTING
-- across overlapping invoices for the same product. This is a known,
-- accepted limitation carried over from the Excel workbook, not a bug to
-- silently "fix" here. A real fix would require an allocation engine
-- (assigning each receipt_item to exactly one invoice), which is explicitly
-- out of scope for this phase — do not build one without a separate,
-- explicit request.
-- ============================================================
CREATE OR REPLACE VIEW public.v_outstanding AS
SELECT
  ii.id                                             AS invoice_item_id,
  i.id                                              AS invoice_id,
  i.invoice_no,
  i.invoice_date,
  i.supplier_id,
  s.code                                            AS supplier_code,
  s.name                                            AS supplier_name,
  ii.product_id,
  p.sku,
  p.name                                            AS product_name,
  p.unit,
  ii.quantity                                       AS invoice_qty,
  ii.unit_price,
  COALESCE(recv.received_qty, 0)                    AS received_qty,
  ii.quantity - COALESCE(recv.received_qty, 0)      AS remaining_qty,
  ii.quantity * ii.unit_price                       AS invoice_value,
  COALESCE(recv.received_qty, 0) * ii.unit_price    AS received_value,
  (ii.quantity - COALESCE(recv.received_qty, 0)) * ii.unit_price AS remaining_value,
  CASE
    WHEN ii.quantity - COALESCE(recv.received_qty, 0) < 0  THEN 'need_makeup'
    WHEN ii.quantity - COALESCE(recv.received_qty, 0) < 15 THEN 'low'
    ELSE 'normal'
  END                                                AS status
FROM public.invoice_items ii
JOIN public.invoices  i ON i.id = ii.invoice_id
JOIN public.suppliers s ON s.id = i.supplier_id
JOIN public.products  p ON p.id = ii.product_id
LEFT JOIN LATERAL (
  SELECT SUM(ri.received_qty) AS received_qty
  FROM public.receipt_items ri
  JOIN public.receipts r ON r.id = ri.receipt_id
  WHERE ri.product_id = ii.product_id
    AND r.supplier_id = i.supplier_id
    AND r.receipt_date >= i.invoice_date
) recv ON true;

-- ------------------------------------------------------------
-- Detail drill-down: the individual receipt_items rows that fed into one
-- invoice_item's received_qty (the "13/09 +30, 15/09 +40, 18/09 +32" list
-- in the spec). Same WHERE clause as the LATERAL join above, parameterized
-- by invoice_item_id so the UI's total always matches v_outstanding exactly
-- — this is not a separate recomputation.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_outstanding_contributing_receipts(p_invoice_item_id uuid)
RETURNS TABLE (
  receipt_id     uuid,
  receipt_no     text,
  receipt_date   date,
  shift          text,
  received_qty   numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.id, r.receipt_no, r.receipt_date, r.shift, ri.received_qty
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  JOIN public.receipt_items ri ON ri.product_id = ii.product_id
  JOIN public.receipts r ON r.id = ri.receipt_id
    AND r.supplier_id = i.supplier_id
    AND r.receipt_date >= i.invoice_date
  WHERE ii.id = p_invoice_item_id
  ORDER BY r.receipt_date ASC, r.created_at ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_outstanding_contributing_receipts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_outstanding_contributing_receipts(uuid) TO service_role;
