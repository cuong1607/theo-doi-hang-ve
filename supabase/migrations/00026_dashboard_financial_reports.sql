-- ============================================================
-- PHASE UP5: Dashboard and Financial Reports
--
-- Adds invoice/discount/VAT/debt-based metrics to the dashboard, built on
-- top of v_invoice_debt (already has subtotal/discount_amount/vat_amount/
-- final_amount/paid_amount/remaining_amount/supplier_type since UP4,
-- migration 00025). Same "tính động, không cache" + single-aggregate-query
-- convention as the existing dashboard functions (migration 00015) and the
-- debt screen (00018/00025) — no raw-row fetch summed in the app layer.
--
-- These are intentionally separate functions from the debt screen's
-- get_debt_overview / get_supplier_debt_summary_filtered (00018/00025)
-- rather than reused directly: the dashboard adds a p_supplier_type filter
-- dimension the debt screen doesn't have, and has its own supplier/type
-- breakdown shapes. Both read the same v_invoice_debt base, so with
-- identical date/supplier filters and no type filter their totals
-- reconcile exactly (see UP5 test list: "totals reconcile với debt
-- module").
-- ============================================================

-- ------------------------------------------------------------
-- 1. Top-level financial summary cards.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_financial_summary(
  p_from_date     date,
  p_to_date       date,
  p_supplier_id   uuid,
  p_supplier_type text
)
RETURNS TABLE (
  total_subtotal_amount  numeric,
  total_discount_amount  numeric,
  total_vat_amount       numeric,
  total_final_amount     numeric,
  total_paid_amount      numeric,
  total_remaining_amount numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(SUM(subtotal), 0)         AS total_subtotal_amount,
    COALESCE(SUM(discount_amount), 0)  AS total_discount_amount,
    COALESCE(SUM(vat_amount), 0)       AS total_vat_amount,
    COALESCE(SUM(final_amount), 0)     AS total_final_amount,
    COALESCE(SUM(paid_amount), 0)      AS total_paid_amount,
    COALESCE(SUM(remaining_amount), 0) AS total_remaining_amount
  FROM public.v_invoice_debt
  WHERE invoice_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR supplier_id = p_supplier_id)
    AND (p_supplier_type IS NULL OR p_supplier_type = '' OR supplier_type = p_supplier_type);
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_financial_summary(date, date, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_financial_summary(date, date, uuid, text) TO service_role;


-- ------------------------------------------------------------
-- 2. Per-supplier financial breakdown. Only suppliers with at least one
-- invoice matching the filter appear (INNER — same convention as
-- get_dashboard_supplier_totals in 00015, the receipts-side equivalent),
-- ordered by final total descending like the debt screen's own ranking.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_financial_supplier_breakdown(
  p_from_date     date,
  p_to_date       date,
  p_supplier_id   uuid,
  p_supplier_type text
)
RETURNS TABLE (
  supplier_id       uuid,
  supplier_code     text,
  supplier_name     text,
  supplier_type     text,
  subtotal_total    numeric,
  discount_total    numeric,
  vat_total         numeric,
  final_total       numeric,
  paid_total        numeric,
  remaining_total   numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    supplier_id, supplier_code, supplier_name, supplier_type,
    COALESCE(SUM(subtotal), 0)         AS subtotal_total,
    COALESCE(SUM(discount_amount), 0)  AS discount_total,
    COALESCE(SUM(vat_amount), 0)       AS vat_total,
    COALESCE(SUM(final_amount), 0)     AS final_total,
    COALESCE(SUM(paid_amount), 0)      AS paid_total,
    COALESCE(SUM(remaining_amount), 0) AS remaining_total
  FROM public.v_invoice_debt
  WHERE invoice_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR supplier_id = p_supplier_id)
    AND (p_supplier_type IS NULL OR p_supplier_type = '' OR supplier_type = p_supplier_type)
  GROUP BY supplier_id, supplier_code, supplier_name, supplier_type
  ORDER BY final_total DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_financial_supplier_breakdown(date, date, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_financial_supplier_breakdown(date, date, uuid, text) TO service_role;


-- ------------------------------------------------------------
-- 3. Breakdown by supplier_type (hộ kinh doanh / công ty) — at most 2 rows.
-- Table, not a chart, per the UP5 spec ("Không cần chart nếu table rõ
-- hơn"). p_supplier_type is still accepted for consistency with the other
-- two functions (so every dashboard metric reacts to every active filter),
-- even though filtering it here just collapses the result to one row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_financial_type_breakdown(
  p_from_date     date,
  p_to_date       date,
  p_supplier_id   uuid,
  p_supplier_type text
)
RETURNS TABLE (
  supplier_type     text,
  subtotal_total    numeric,
  discount_total    numeric,
  vat_total         numeric,
  final_total       numeric,
  paid_total        numeric,
  remaining_total   numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    supplier_type,
    COALESCE(SUM(subtotal), 0)         AS subtotal_total,
    COALESCE(SUM(discount_amount), 0)  AS discount_total,
    COALESCE(SUM(vat_amount), 0)       AS vat_total,
    COALESCE(SUM(final_amount), 0)     AS final_total,
    COALESCE(SUM(paid_amount), 0)      AS paid_total,
    COALESCE(SUM(remaining_amount), 0) AS remaining_total
  FROM public.v_invoice_debt
  WHERE invoice_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR supplier_id = p_supplier_id)
    AND (p_supplier_type IS NULL OR p_supplier_type = '' OR supplier_type = p_supplier_type)
  GROUP BY supplier_type
  ORDER BY supplier_type;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_financial_type_breakdown(date, date, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_financial_type_breakdown(date, date, uuid, text) TO service_role;
