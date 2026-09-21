-- ============================================================
-- PHASE 13: Dashboard aggregates — tính động, không cache table riêng.
--
-- All numbers the dashboard shows come from these SQL aggregates (or from
-- v_daily_receipt_summary / v_outstanding, already built in earlier
-- phases). The app layer never loads raw rows and sums them in
-- React/Node — that would mean fetching potentially unbounded receipt_items
-- rows per page view. Every function here is a single aggregate query.
--
-- p_supplier_id = NULL means "all suppliers" (no filter).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Top-level counters (cards 1-6 on the dashboard).
--
-- receipt_count = number of actual phiếu nhập (receipts rows) — distinct
-- from daily_group_count, which counts (receipt_date, supplier_id) pairs
-- (i.e. "daily summary" groups). The spec is explicit that these two must
-- never be conflated in the UI.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_summary(
  p_from_date date,
  p_to_date date,
  p_supplier_id uuid
)
RETURNS TABLE (
  receipt_count         bigint,
  daily_group_count     bigint,
  total_delivered_qty   numeric,
  total_received_qty    numeric,
  total_difference_qty  numeric,
  total_amount          numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(DISTINCT r.id)                          AS receipt_count,
    COUNT(DISTINCT (r.receipt_date, r.supplier_id)) AS daily_group_count,
    COALESCE(SUM(ri.delivered_qty), 0)            AS total_delivered_qty,
    COALESCE(SUM(ri.received_qty), 0)             AS total_received_qty,
    COALESCE(SUM(ri.difference_qty), 0)           AS total_difference_qty,
    COALESCE(SUM(ri.line_total), 0)               AS total_amount
  FROM public.receipts r
  JOIN public.receipt_items ri ON ri.receipt_id = r.id
  WHERE r.receipt_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR r.supplier_id = p_supplier_id);
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_summary(date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(date, date, uuid) TO service_role;

-- ------------------------------------------------------------
-- 2. "Hàng về theo ngày" section — group by date across (or within one)
-- supplier.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_daily_series(
  p_from_date date,
  p_to_date date,
  p_supplier_id uuid
)
RETURNS TABLE (
  receipt_date         date,
  total_delivered_qty  numeric,
  total_received_qty   numeric,
  total_amount         numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    r.receipt_date,
    COALESCE(SUM(ri.delivered_qty), 0) AS total_delivered_qty,
    COALESCE(SUM(ri.received_qty), 0)  AS total_received_qty,
    COALESCE(SUM(ri.line_total), 0)    AS total_amount
  FROM public.receipts r
  JOIN public.receipt_items ri ON ri.receipt_id = r.id
  WHERE r.receipt_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR r.supplier_id = p_supplier_id)
  GROUP BY r.receipt_date
  ORDER BY r.receipt_date;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_daily_series(date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_daily_series(date, date, uuid) TO service_role;

-- ------------------------------------------------------------
-- 3. "Giá trị hàng về theo NCC" section — group by supplier.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_supplier_totals(
  p_from_date date,
  p_to_date date,
  p_supplier_id uuid
)
RETURNS TABLE (
  supplier_id        uuid,
  supplier_code      text,
  supplier_name      text,
  total_received_qty numeric,
  total_amount       numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id, s.code, s.name,
    COALESCE(SUM(ri.received_qty), 0) AS total_received_qty,
    COALESCE(SUM(ri.line_total), 0)   AS total_amount
  FROM public.receipts r
  JOIN public.receipt_items ri ON ri.receipt_id = r.id
  JOIN public.suppliers s      ON s.id = r.supplier_id
  WHERE r.receipt_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR r.supplier_id = p_supplier_id)
  GROUP BY s.id, s.code, s.name
  ORDER BY total_amount DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_supplier_totals(date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_supplier_totals(date, date, uuid) TO service_role;

-- ------------------------------------------------------------
-- 4. Outstanding-related cards (7-8): reuses v_outstanding from Phase 12
-- (same Excel-compatibility caveat applies — see migration 00014). Filtered
-- by invoice_date, since that is v_outstanding's own date dimension.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_outstanding_summary(
  p_from_date date,
  p_to_date date,
  p_supplier_id uuid
)
RETURNS TABLE (
  watching_invoice_count bigint,
  low_sku_count          bigint,
  need_makeup_sku_count  bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(DISTINCT invoice_id) FILTER (WHERE status <> 'normal') AS watching_invoice_count,
    COUNT(*) FILTER (WHERE status = 'low')                       AS low_sku_count,
    COUNT(*) FILTER (WHERE status = 'need_makeup')                AS need_makeup_sku_count
  FROM public.v_outstanding
  WHERE invoice_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR supplier_id = p_supplier_id);
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_outstanding_summary(date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_outstanding_summary(date, date, uuid) TO service_role;
