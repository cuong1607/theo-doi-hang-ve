-- ============================================================
-- PHASE ZL3: Daily Receipt Summary Notification
--
-- Single aggregate RPC for the DAILY_RECEIPT_SUMMARY business event —
-- same "aggregate in SQL, not in the app layer" convention as
-- get_dashboard_financial_supplier_breakdown (00026) / v_outstanding (00027).
-- Grouped by supplier only; the service layer (src/lib/notifications/
-- daily-receipt-summary.ts) sums these already-aggregated per-supplier rows
-- to get the "TỔNG" line — that's summing a handful of numbers server-side,
-- not raw receipt_items rows, so it stays consistent with "không aggregate
-- ở browser" (the existing /receipts/daily/[date]/[supplierId] page already
-- does the same kind of reduce() over a SQL-aggregated array).
--
-- INNER JOINs mean a supplier with zero receipts that day never appears —
-- callers detect the "no receipts at all" case via an empty result set
-- (receiptCount = 0 after summing), not a NULL row.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_daily_receipt_summary_by_supplier(
  p_date date
)
RETURNS TABLE (
  supplier_id      uuid,
  supplier_code    text,
  supplier_name    text,
  receipt_count    bigint,
  total_delivered  numeric,
  total_received   numeric,
  total_difference numeric,
  total_amount     numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id                                AS supplier_id,
    s.code                              AS supplier_code,
    s.name                              AS supplier_name,
    COUNT(DISTINCT r.id)                AS receipt_count,
    COALESCE(SUM(ri.delivered_qty), 0)  AS total_delivered,
    COALESCE(SUM(ri.received_qty), 0)   AS total_received,
    COALESCE(SUM(ri.difference_qty), 0) AS total_difference,
    COALESCE(SUM(ri.line_total), 0)     AS total_amount
  FROM public.receipts r
  JOIN public.receipt_items ri ON ri.receipt_id = r.id
  JOIN public.suppliers s      ON s.id = r.supplier_id
  WHERE r.receipt_date = p_date
  GROUP BY s.id, s.code, s.name
  ORDER BY s.name;
$$;

REVOKE EXECUTE ON FUNCTION public.get_daily_receipt_summary_by_supplier(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_receipt_summary_by_supplier(date) TO service_role;
