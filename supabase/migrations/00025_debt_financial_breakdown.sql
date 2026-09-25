-- ============================================================
-- PHASE UP4: Debt Calculation Update
--
-- v_invoice_debt already used invoices.final_amount for its debt math
-- (migration 00022) — that business rule (invoice_debt = final_amount -
-- SUM(payment_items.amount)) does not change here. What UP4 adds is
-- surfacing the breakdown that was already sitting on invoices
-- (subtotal, discount_amount, vat_amount, supplier_type) through the debt
-- views/RPCs, so the /debts screen can show "Tạm tính / Chiết khấu / VAT /
-- Tổng phải trả" as distinct numbers instead of only the final total.
--
-- invoice_total is renamed to final_amount (and supplier_invoice_total to
-- supplier_final_total / total_invoice_amount to total_final_amount) to
-- match the naming the spec calls out explicitly — these views are internal
-- read models with a handful of call sites, all updated in this same phase.
-- ============================================================

-- ------------------------------------------------------------
-- 1. VIEW: v_invoice_debt — add subtotal/discount_amount/vat_amount/
-- supplier_type, rename invoice_total -> final_amount. Column set changes,
-- so DROP/CREATE rather than CREATE OR REPLACE (which cannot reorder or
-- rename columns).
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.v_invoice_debt CASCADE;

CREATE VIEW public.v_invoice_debt AS
SELECT
  i.id                                             AS invoice_id,
  i.invoice_no,
  i.invoice_date,
  i.supplier_id,
  s.code                                           AS supplier_code,
  s.name                                            AS supplier_name,
  s.supplier_type                                   AS supplier_type,
  i.subtotal::numeric                               AS subtotal,
  i.discount_amount::numeric                        AS discount_amount,
  i.vat_amount::numeric                             AS vat_amount,
  i.final_amount::numeric                           AS final_amount,
  COALESCE(paid.paid_amount, 0)                     AS paid_amount,
  i.final_amount - COALESCE(paid.paid_amount, 0)    AS remaining_amount,
  CASE
    WHEN COALESCE(paid.paid_amount, 0) <= 0            THEN 'unpaid'
    WHEN COALESCE(paid.paid_amount, 0) >= i.final_amount THEN 'paid'
    ELSE 'partial'
  END                                                AS payment_status
FROM public.invoices i
JOIN public.suppliers s ON s.id = i.supplier_id
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS paid_amount
  FROM public.payment_items
  GROUP BY invoice_id
) paid ON paid.invoice_id = i.id;


-- ------------------------------------------------------------
-- 2. VIEW: v_supplier_debt_summary — per-supplier rollup, now including
-- the subtotal/discount/VAT sums and the supplier's own type.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_supplier_debt_summary AS
SELECT
  s.id                                                          AS supplier_id,
  s.code                                                        AS supplier_code,
  s.name                                                        AS supplier_name,
  s.supplier_type                                               AS supplier_type,
  COALESCE(SUM(d.subtotal), 0)                                  AS supplier_subtotal_total,
  COALESCE(SUM(d.discount_amount), 0)                           AS supplier_discount_total,
  COALESCE(SUM(d.vat_amount), 0)                                AS supplier_vat_total,
  COALESCE(SUM(d.final_amount), 0)                              AS supplier_final_total,
  COALESCE(SUM(d.paid_amount), 0)                               AS supplier_paid_total,
  COALESCE(SUM(d.remaining_amount), 0)                          AS supplier_remaining_total,
  COUNT(*) FILTER (WHERE d.payment_status <> 'paid')            AS supplier_open_invoice_count
FROM public.suppliers s
LEFT JOIN public.v_invoice_debt d ON d.supplier_id = s.id
GROUP BY s.id, s.code, s.name, s.supplier_type;


-- ------------------------------------------------------------
-- 3. get_debt_overview — add total_subtotal_amount / total_discount_amount
-- / total_vat_amount, rename total_invoice_amount -> total_final_amount.
-- Return shape changed, so drop the old signature's function first.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_debt_overview(date, date, uuid, text, text);

CREATE FUNCTION public.get_debt_overview(
  p_from_date   date,
  p_to_date     date,
  p_supplier_id uuid,
  p_status      text,
  p_search      text
)
RETURNS TABLE (
  total_subtotal_amount  numeric,
  total_discount_amount  numeric,
  total_vat_amount       numeric,
  total_final_amount     numeric,
  total_paid_amount      numeric,
  total_remaining_amount numeric,
  open_invoice_count     bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(SUM(subtotal), 0)                          AS total_subtotal_amount,
    COALESCE(SUM(discount_amount), 0)                   AS total_discount_amount,
    COALESCE(SUM(vat_amount), 0)                        AS total_vat_amount,
    COALESCE(SUM(final_amount), 0)                      AS total_final_amount,
    COALESCE(SUM(paid_amount), 0)                       AS total_paid_amount,
    COALESCE(SUM(remaining_amount), 0)                  AS total_remaining_amount,
    COUNT(*) FILTER (WHERE payment_status <> 'paid')    AS open_invoice_count
  FROM public.v_invoice_debt
  WHERE invoice_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR supplier_id = p_supplier_id)
    AND (p_status IS NULL OR p_status = '' OR payment_status = p_status)
    AND (p_search IS NULL OR p_search = '' OR invoice_no ILIKE '%' || p_search || '%');
$$;

REVOKE EXECUTE ON FUNCTION public.get_debt_overview(date, date, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_debt_overview(date, date, uuid, text, text) TO service_role;


-- ------------------------------------------------------------
-- 4. get_supplier_debt_summary_filtered — same breakdown columns, still
-- LEFT JOIN with filters in the ON clause (not WHERE) so a supplier with no
-- invoices matching the filter still appears with all-zero figures.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_supplier_debt_summary_filtered(date, date, uuid, text, text);

CREATE FUNCTION public.get_supplier_debt_summary_filtered(
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
  supplier_type                  text,
  supplier_subtotal_total       numeric,
  supplier_discount_total       numeric,
  supplier_vat_total            numeric,
  supplier_final_total          numeric,
  supplier_paid_total           numeric,
  supplier_remaining_total      numeric,
  supplier_open_invoice_count   bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id, s.code, s.name, s.supplier_type,
    COALESCE(SUM(d.subtotal), 0)                       AS supplier_subtotal_total,
    COALESCE(SUM(d.discount_amount), 0)                AS supplier_discount_total,
    COALESCE(SUM(d.vat_amount), 0)                      AS supplier_vat_total,
    COALESCE(SUM(d.final_amount), 0)                   AS supplier_final_total,
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
  GROUP BY s.id, s.code, s.name, s.supplier_type
  ORDER BY supplier_remaining_total DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_supplier_debt_summary_filtered(date, date, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_supplier_debt_summary_filtered(date, date, uuid, text, text) TO service_role;
