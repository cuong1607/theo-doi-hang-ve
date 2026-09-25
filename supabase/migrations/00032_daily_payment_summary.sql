-- ============================================================
-- PHASE ZL5: Daily Payment Summary Notification
--
-- Same "aggregate in SQL, not in the app layer" convention as ZL3's
-- get_daily_receipt_summary_by_supplier (00030). Grouped by (supplier,
-- invoice) rather than just supplier — the message needs a line per
-- invoice ("HĐ 001: 10.000.000 đ"), not just a supplier total, so the
-- per-invoice SUM has to happen here, not be reconstructed in the app
-- layer from raw payment_items rows.
--
-- Join chain matches the spec: payments -> payment_items -> invoices, plus
-- suppliers via payments.supplier_id directly (payments already carries
-- its own supplier_id — see migration 00017 — and create_payment's RPC
-- already guarantees every payment_items.invoice_id belongs to that same
-- supplier, so joining suppliers off payments.supplier_id vs.
-- invoices.supplier_id is equivalent but one hop shorter).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_daily_payment_summary_by_invoice(
  p_date date
)
RETURNS TABLE (
  supplier_id   uuid,
  supplier_code text,
  supplier_name text,
  invoice_id    uuid,
  invoice_no    text,
  amount_paid   numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id                     AS supplier_id,
    s.code                   AS supplier_code,
    s.name                   AS supplier_name,
    i.id                     AS invoice_id,
    i.invoice_no             AS invoice_no,
    COALESCE(SUM(pi.amount), 0) AS amount_paid
  FROM public.payments p
  JOIN public.payment_items pi ON pi.payment_id = p.id
  JOIN public.invoices i       ON i.id = pi.invoice_id
  JOIN public.suppliers s      ON s.id = p.supplier_id
  WHERE p.payment_date = p_date
  GROUP BY s.id, s.code, s.name, i.id, i.invoice_no
  ORDER BY s.name, i.invoice_no;
$$;

REVOKE EXECUTE ON FUNCTION public.get_daily_payment_summary_by_invoice(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_payment_summary_by_invoice(date) TO service_role;
