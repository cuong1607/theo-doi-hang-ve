-- ============================================================
-- PHASE OUTSTANDING-FINANCE: Update outstanding value calculation
--
-- v_outstanding's money columns (invoice_value/received_value/remaining_value)
-- used to be plain quantity * unit_price — ignoring the discount (hộ kinh
-- doanh) / VAT (công ty) already snapshotted on invoices since Phase UP1-UP2
-- (subtotal, discount_amount, vat_amount, final_amount — see migration
-- 00022). This migration allocates each invoice's real final_amount down to
-- its invoice_items, in proportion to each line's share of subtotal, so the
-- outstanding screen's money figures mean "giá trị thực đã bao gồm VAT/trừ
-- chiết khấu" instead of the raw quantity*unit_price total.
--
-- Column names are unchanged (invoice_value/received_value/remaining_value)
-- — only what they mean changes — so no call site (list/detail queries,
-- outstanding pages, dashboard's outstanding aggregates) needs a rename.
--
-- financial_factor = final_amount / subtotal is the same ratio for every
-- item on one invoice (VAT applies uniformly to the whole invoice; discount
-- likewise) — see PHẦN 1 of the phase spec. Not stored: subtotal = 0 would
-- only happen if every line's unit_price is 0, in which case every line's
-- adjusted amount is 0 regardless of the factor, so it's safe to fall back
-- to factor = 1 there (COALESCE/CASE guard, no division by zero).
--
-- Rounding: each line's raw allocation is rounded to numeric(15,2) (same
-- money scale as the rest of the app, see calculateInvoiceFinancials'
-- round2), then the residual (final_amount minus the sum of all rounded
-- lines) is added onto the LAST item of the invoice (by created_at, then id,
-- descending — i.e. the most recently added line). This guarantees
-- SUM(invoice_value) per invoice == invoices.final_amount exactly, never off
-- by a few đồng.
--
-- received_value/remaining_value are derived from invoice_value by a
-- received_qty/invoice_qty ratio (0 when invoice_qty <= 0, guarding
-- division by zero — a defensive case, not expected in practice since
-- invoice_items.quantity is always > 0 by construction). remaining_value is
-- computed as invoice_value − received_value (subtraction, not its own
-- independent rounding), so invoice_value = received_value + remaining_value
-- holds exactly for every row — and therefore for every filtered SUM too.
-- Over-received (received_qty > invoice_qty) is left alone: ratio > 1,
-- received_value > invoice_value, remaining_value negative — same
-- "cần xuất bù" semantics the qty columns already had, now applied to money.
-- ============================================================
CREATE OR REPLACE VIEW public.v_outstanding AS
WITH item_base AS (
  SELECT
    ii.id                           AS invoice_item_id,
    ii.invoice_id,
    ii.product_id,
    ii.quantity                     AS invoice_qty,
    ii.unit_price,
    ii.line_total,
    ii.created_at,
    i.invoice_no,
    i.invoice_date,
    i.supplier_id,
    i.subtotal,
    i.final_amount,
    COALESCE(recv.received_qty, 0)  AS received_qty
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  LEFT JOIN LATERAL (
    SELECT SUM(ri.received_qty) AS received_qty
    FROM public.receipt_items ri
    JOIN public.receipts r ON r.id = ri.receipt_id
    WHERE ri.product_id = ii.product_id
      AND r.supplier_id = i.supplier_id
      AND r.receipt_date >= i.invoice_date
  ) recv ON true
),
-- invoice_value = each line's share of invoices.final_amount, allocated by
-- its share of subtotal, with the rounding residual folded into the last
-- line so the per-invoice total is exact.
adjusted AS (
  SELECT
    b.*,
    ROUND(b.line_total * (CASE WHEN b.subtotal = 0 THEN 1 ELSE b.final_amount / b.subtotal END), 2)
      + CASE
          WHEN ROW_NUMBER() OVER (PARTITION BY b.invoice_id ORDER BY b.created_at DESC, b.invoice_item_id DESC) = 1
          THEN b.final_amount - SUM(
                 ROUND(b.line_total * (CASE WHEN b.subtotal = 0 THEN 1 ELSE b.final_amount / b.subtotal END), 2)
               ) OVER (PARTITION BY b.invoice_id)
          ELSE 0
        END AS invoice_value
  FROM item_base b
)
SELECT
  a.invoice_item_id,
  a.invoice_id,
  a.invoice_no,
  a.invoice_date,
  a.supplier_id,
  s.code                                AS supplier_code,
  s.name                                 AS supplier_name,
  a.product_id,
  p.sku,
  p.name                                  AS product_name,
  p.unit,
  a.invoice_qty,
  a.unit_price,
  a.received_qty,
  a.invoice_qty - a.received_qty          AS remaining_qty,
  a.invoice_value,
  ROUND(a.invoice_value * CASE WHEN a.invoice_qty <= 0 THEN 0 ELSE a.received_qty / a.invoice_qty END, 2)
                                           AS received_value,
  a.invoice_value
    - ROUND(a.invoice_value * CASE WHEN a.invoice_qty <= 0 THEN 0 ELSE a.received_qty / a.invoice_qty END, 2)
                                           AS remaining_value,
  CASE
    WHEN a.invoice_qty - a.received_qty < 0  THEN 'need_makeup'
    WHEN a.invoice_qty - a.received_qty < 15 THEN 'low'
    ELSE 'normal'
  END                                      AS status
FROM adjusted a
JOIN public.suppliers s ON s.id = a.supplier_id
JOIN public.products  p ON p.id = a.product_id;


-- ------------------------------------------------------------
-- PHẦN 3: server-side aggregate for the 3 summary cards — SUM over the
-- ENTIRE filtered set (same filter shape as getOutstandingList), never a
-- frontend reduce over one paginated page. Same convention as
-- get_debt_overview (00018/00025).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_outstanding_summary(
  p_supplier_id  uuid,
  p_invoice_date date,
  p_sku          text,
  p_status       text
)
RETURNS TABLE (
  total_invoice_amount   numeric,
  total_received_amount  numeric,
  total_remaining_amount numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(SUM(invoice_value), 0)   AS total_invoice_amount,
    COALESCE(SUM(received_value), 0)  AS total_received_amount,
    COALESCE(SUM(remaining_value), 0) AS total_remaining_amount
  FROM public.v_outstanding
  WHERE (p_supplier_id IS NULL OR supplier_id = p_supplier_id)
    AND (p_invoice_date IS NULL OR invoice_date = p_invoice_date)
    AND (p_sku IS NULL OR p_sku = '' OR sku ILIKE '%' || p_sku || '%')
    AND (p_status IS NULL OR p_status = '' OR status = p_status);
$$;

REVOKE EXECUTE ON FUNCTION public.get_outstanding_summary(uuid, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_outstanding_summary(uuid, date, text, text) TO service_role;
