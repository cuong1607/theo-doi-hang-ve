-- ============================================================
-- PHASE CN3: Payment history list (tính động, không lưu table riêng).
--
-- invoice_numbers is a comma-joined string of the invoice_no's this payment
-- covers (e.g. "PN-001, PN-002") — matches the spec's own list format
-- ("22/09/2026 - Thanh toán HĐ 001, 002"), so the list screen doesn't need a
-- second query per row just to show which invoices were paid.
-- ============================================================
CREATE OR REPLACE VIEW public.v_payment_summary AS
SELECT
  p.id,
  p.payment_date,
  p.supplier_id,
  s.code                                            AS supplier_code,
  s.name                                             AS supplier_name,
  p.total_amount,
  p.note,
  p.created_by,
  pr.full_name                                       AS created_by_name,
  p.created_at,
  COUNT(pi.id)                                        AS invoice_count,
  STRING_AGG(i.invoice_no, ', ' ORDER BY i.invoice_no) AS invoice_numbers
FROM public.payments p
JOIN public.suppliers s        ON s.id = p.supplier_id
LEFT JOIN public.profiles pr   ON pr.id = p.created_by
LEFT JOIN public.payment_items pi ON pi.payment_id = p.id
LEFT JOIN public.invoices i    ON i.id = pi.invoice_id
GROUP BY p.id, p.payment_date, p.supplier_id, s.code, s.name, p.total_amount, p.note, p.created_by, pr.full_name, p.created_at;
