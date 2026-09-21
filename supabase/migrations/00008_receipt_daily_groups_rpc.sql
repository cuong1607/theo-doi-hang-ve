-- ============================================================
-- PHASE 10 (history list only, Excel export deferred)
-- Paginated, filterable (date range / supplier / SKU / product name)
-- aggregation of receipts grouped by (receipt_date, supplier_id), for the
-- /receipts history screen.
--
-- IMPORTANT: when p_sku or p_product_name is supplied, the WHERE clause
-- filters receipt_items/products *before* the GROUP BY, so every returned
-- group's totals reflect only the matching product(s) — not the day's full
-- totals. This is intentional (see /receipts page.tsx for the UI-facing
-- note): showing the unfiltered day total next to a SKU filter would be
-- misleading.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_receipt_daily_groups(
  p_from_date     date DEFAULT NULL,
  p_to_date       date DEFAULT NULL,
  p_supplier_id   uuid DEFAULT NULL,
  p_sku           text DEFAULT NULL,
  p_product_name  text DEFAULT NULL,
  p_limit         integer DEFAULT 10,
  p_offset        integer DEFAULT 0
)
RETURNS TABLE (
  receipt_date         date,
  supplier_id          uuid,
  supplier_code        text,
  supplier_name        text,
  sku_count            bigint,
  total_delivered_qty  numeric,
  total_received_qty   numeric,
  total_difference_qty numeric,
  total_line_total     numeric,
  total_groups         bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    r.receipt_date,
    r.supplier_id,
    s.code,
    s.name,
    COUNT(DISTINCT ri.product_id),
    COALESCE(SUM(ri.delivered_qty), 0),
    COALESCE(SUM(ri.received_qty), 0),
    COALESCE(SUM(ri.difference_qty), 0),
    COALESCE(SUM(ri.line_total), 0),
    COUNT(*) OVER()
  FROM public.receipts r
  JOIN public.receipt_items ri ON ri.receipt_id = r.id
  JOIN public.suppliers s      ON s.id = r.supplier_id
  JOIN public.products p       ON p.id = ri.product_id
  WHERE (p_from_date    IS NULL OR r.receipt_date >= p_from_date)
    AND (p_to_date      IS NULL OR r.receipt_date <= p_to_date)
    AND (p_supplier_id  IS NULL OR r.supplier_id = p_supplier_id)
    AND (p_sku          IS NULL OR p.sku  ILIKE '%' || p_sku || '%')
    AND (p_product_name IS NULL OR p.name ILIKE '%' || p_product_name || '%')
  GROUP BY r.receipt_date, r.supplier_id, s.code, s.name
  ORDER BY r.receipt_date DESC, s.code ASC
  LIMIT p_limit OFFSET p_offset;
$$;

REVOKE EXECUTE ON FUNCTION public.get_receipt_daily_groups(date, date, uuid, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_receipt_daily_groups(date, date, uuid, text, text, integer, integer) TO service_role;
