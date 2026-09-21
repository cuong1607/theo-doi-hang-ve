-- ============================================================
-- PHASE 11: Invoice list summary (tính động, không lưu table).
--
-- Unlike the receipt daily-groups view, one invoice is already one row —
-- no GROUP BY across multiple source rows is needed for the list, just a
-- per-invoice rollup of its own items. Filterable directly from the app via
-- normal PostgREST query params (eq/gte/lte/ilike + range for pagination).
-- ============================================================
CREATE OR REPLACE VIEW public.v_invoice_summary AS
SELECT
  i.id,
  i.invoice_no,
  i.invoice_date,
  i.supplier_id,
  s.code AS supplier_code,
  s.name AS supplier_name,
  i.note,
  i.created_at,
  COUNT(ii.id)                    AS sku_count,
  COALESCE(SUM(ii.quantity), 0)   AS total_quantity,
  COALESCE(SUM(ii.line_total), 0) AS total_amount
FROM public.invoices i
JOIN public.suppliers s      ON s.id = i.supplier_id
LEFT JOIN public.invoice_items ii ON ii.invoice_id = i.id
GROUP BY i.id, i.invoice_no, i.invoice_date, i.supplier_id, s.code, s.name, i.note, i.created_at;
