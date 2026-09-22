-- ============================================================
-- PHASE CN2: Aggregates for the /debts screen — tính động, không cache.
--
-- Built on top of v_invoice_debt (migration 00017). Same convention as the
-- dashboard aggregates (00015): p_supplier_id/p_status/p_search = NULL (or
-- '') means "no filter on this dimension". Date filter is always required
-- and applies to invoice_date, per the CN2 spec ("Bộ lọc ngày ở màn hình
-- này là theo ngày hóa đơn").
-- ============================================================

-- ------------------------------------------------------------
-- 1. Overview cards (Phần 2): totals across every invoice matching the
-- current filter set — not a page, the whole filtered set.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_debt_overview(
  p_from_date   date,
  p_to_date     date,
  p_supplier_id uuid,
  p_status      text,
  p_search      text
)
RETURNS TABLE (
  total_invoice_amount   numeric,
  total_paid_amount      numeric,
  total_remaining_amount numeric,
  open_invoice_count     bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(SUM(invoice_total), 0)                     AS total_invoice_amount,
    COALESCE(SUM(paid_amount), 0)                        AS total_paid_amount,
    COALESCE(SUM(remaining_amount), 0)                   AS total_remaining_amount,
    COUNT(*) FILTER (WHERE payment_status <> 'paid')     AS open_invoice_count
  FROM public.v_invoice_debt
  WHERE invoice_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR supplier_id = p_supplier_id)
    AND (p_status IS NULL OR p_status = '' OR payment_status = p_status)
    AND (p_search IS NULL OR p_search = '' OR invoice_no ILIKE '%' || p_search || '%');
$$;

REVOKE EXECUTE ON FUNCTION public.get_debt_overview(date, date, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_debt_overview(date, date, uuid, text, text) TO service_role;


-- ------------------------------------------------------------
-- 2. Per-supplier breakdown (Phần 3). Filters (date/status/search) sit in
-- the LEFT JOIN's ON clause, not WHERE — a supplier with zero invoices
-- matching the filter must still appear with all-zero figures ("Nếu không
-- lọc NCC: hiển thị tất cả NCC"). Putting a date/status/search condition in
-- WHERE instead would silently drop such suppliers, since NULL BETWEEN /
-- NULL = ... is neither true nor false.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_supplier_debt_summary_filtered(
  p_from_date   date,
  p_to_date     date,
  p_supplier_id uuid,
  p_status      text,
  p_search      text
)
RETURNS TABLE (
  supplier_id                 uuid,
  supplier_code                text,
  supplier_name                 text,
  supplier_invoice_total       numeric,
  supplier_paid_total          numeric,
  supplier_remaining_total     numeric,
  supplier_open_invoice_count  bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id, s.code, s.name,
    COALESCE(SUM(d.invoice_total), 0)                 AS supplier_invoice_total,
    COALESCE(SUM(d.paid_amount), 0)                    AS supplier_paid_total,
    COALESCE(SUM(d.remaining_amount), 0)               AS supplier_remaining_total,
    COUNT(*) FILTER (WHERE d.payment_status <> 'paid') AS supplier_open_invoice_count
  FROM public.suppliers s
  LEFT JOIN public.v_invoice_debt d
    ON d.supplier_id = s.id
   AND d.invoice_date BETWEEN p_from_date AND p_to_date
   AND (p_status IS NULL OR p_status = '' OR d.payment_status = p_status)
   AND (p_search IS NULL OR p_search = '' OR d.invoice_no ILIKE '%' || p_search || '%')
  WHERE (p_supplier_id IS NULL OR s.id = p_supplier_id)
  GROUP BY s.id, s.code, s.name
  ORDER BY supplier_remaining_total DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_supplier_debt_summary_filtered(date, date, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_supplier_debt_summary_filtered(date, date, uuid, text, text) TO service_role;
