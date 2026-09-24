-- ============================================================
-- PHASE UP2: Invoice Financial Snapshot
--
-- Each invoice now snapshots its own financial policy (discount for
-- business_household, VAT for company) at create time. These fields never
-- change later even if the supplier's supplier_type or a future default
-- changes — that is the whole point of a snapshot (see calculateInvoiceFinancials
-- in src/lib/invoices/financials.ts, the single place these are computed).
--
-- LEGACY DATA: invoices created before this migration have no discount/VAT
-- history to reconstruct, and UP2 does not attempt to. They get neutral
-- values only (discount_amount = 0, vat_amount = 0), with subtotal/
-- final_amount backfilled from their existing invoice_items so debt/list
-- screens don't suddenly show 0 for old invoices. Real historical
-- reconciliation (if ever needed) is explicitly deferred to UP6.
-- ============================================================

ALTER TABLE public.invoices
  ADD COLUMN subtotal        numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_type   text,
  ADD COLUMN discount_value  numeric(15,2),
  ADD COLUMN discount_amount numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN vat_rate        numeric(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN vat_amount      numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN final_amount    numeric(15,2) NOT NULL DEFAULT 0;

UPDATE public.invoices i
SET subtotal     = COALESCE(sub.total, 0),
    final_amount = COALESCE(sub.total, 0)
FROM (
  SELECT invoice_id, SUM(line_total) AS total
  FROM public.invoice_items
  GROUP BY invoice_id
) sub
WHERE sub.invoice_id = i.id;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('percent', 'fixed_amount')),
  -- Same-row invariant: pairs discount_type with a discount_value in the
  -- right range for that type (percent 0-100, fixed_amount 0-subtotal), and
  -- forbids a dangling value without a type or vice versa.
  ADD CONSTRAINT invoices_discount_value_check
    CHECK (
      (discount_type IS NULL AND discount_value IS NULL)
      OR (discount_type = 'percent' AND discount_value >= 0 AND discount_value <= 100)
      OR (discount_type = 'fixed_amount' AND discount_value >= 0 AND discount_value <= subtotal)
    ),
  ADD CONSTRAINT invoices_subtotal_nonnegative CHECK (subtotal >= 0),
  ADD CONSTRAINT invoices_discount_amount_nonnegative CHECK (discount_amount >= 0),
  ADD CONSTRAINT invoices_vat_rate_nonnegative CHECK (vat_rate >= 0),
  ADD CONSTRAINT invoices_vat_amount_nonnegative CHECK (vat_amount >= 0),
  ADD CONSTRAINT invoices_final_amount_nonnegative CHECK (final_amount >= 0);

-- ------------------------------------------------------------
-- create_invoice RPC: now stores the (already server-computed) financial
-- snapshot instead of just the header + items. Signature changed (new
-- required params), so the old overload is dropped first rather than
-- relying on CREATE OR REPLACE to widen it in place.
--
-- Still does not compute subtotal/discount/VAT itself — those come in
-- already calculated by calculateInvoiceFinancials on the server action
-- side, the single source of truth for the formulas. This RPC's job is
-- only the atomic, all-or-nothing persist (header + items), same as before.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_invoice(uuid, text, date, text, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.create_invoice(
  p_supplier_id     uuid,
  p_invoice_no      text,
  p_invoice_date    date,
  p_note            text,
  p_created_by      uuid,
  p_items           jsonb,
  p_subtotal        numeric,
  p_discount_type   text,
  p_discount_value  numeric,
  p_discount_amount numeric,
  p_vat_rate        numeric,
  p_vat_amount      numeric,
  p_final_amount    numeric
)
RETURNS TABLE (invoice_id uuid, invoice_no text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_id uuid;
  v_item       jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Hóa đơn phải có ít nhất 1 sản phẩm.';
  END IF;

  INSERT INTO public.invoices (
    invoice_no, supplier_id, invoice_date, note, created_by,
    subtotal, discount_type, discount_value, discount_amount,
    vat_rate, vat_amount, final_amount
  )
  VALUES (
    p_invoice_no, p_supplier_id, p_invoice_date, p_note, p_created_by,
    p_subtotal, p_discount_type, p_discount_value, p_discount_amount,
    p_vat_rate, p_vat_amount, p_final_amount
  )
  RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.invoice_items (invoice_id, product_id, unit_price, quantity)
    VALUES (
      v_invoice_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::numeric
    );
  END LOOP;

  RETURN QUERY SELECT v_invoice_id, p_invoice_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_invoice(
  uuid, text, date, text, uuid, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_invoice(
  uuid, text, date, text, uuid, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) TO service_role;

-- ------------------------------------------------------------
-- v_invoice_summary (00013): same column set plus the new financial
-- breakdown. total_amount is kept (now an alias of final_amount, not a
-- fresh SUM(line_total)) so the existing /invoices list page needs no
-- changes and automatically starts showing the discount/VAT-adjusted
-- total for new invoices. Column list changes, so replace via DROP/CREATE
-- rather than CREATE OR REPLACE (which cannot reorder/insert columns).
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.v_invoice_summary;

CREATE VIEW public.v_invoice_summary AS
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
  i.subtotal,
  i.discount_type,
  i.discount_value,
  i.discount_amount,
  i.vat_rate,
  i.vat_amount,
  i.final_amount,
  i.final_amount                  AS total_amount
FROM public.invoices i
JOIN public.suppliers s      ON s.id = i.supplier_id
LEFT JOIN public.invoice_items ii ON ii.invoice_id = i.id
GROUP BY i.id, i.invoice_no, i.invoice_date, i.supplier_id, s.code, s.name, i.note, i.created_at,
         i.subtotal, i.discount_type, i.discount_value, i.discount_amount, i.vat_rate, i.vat_amount,
         i.final_amount;

-- ------------------------------------------------------------
-- v_invoice_debt (00017): invoice_total now reads the snapshot
-- (invoices.final_amount) instead of re-summing invoice_items.line_total —
-- the debt screens must reflect discount/VAT, not just the raw item sum.
-- Same column names/order as before, so a plain CREATE OR REPLACE is
-- enough here (no DROP needed) — but the original invoice_total came from
-- SUM(line_total), whose aggregate result type is unconstrained numeric,
-- while i.final_amount is numeric(15,2); CREATE OR REPLACE VIEW rejects a
-- column type change, so cast it back to plain numeric to match. Reads
-- through this view need no changes: get_debt_overview and
-- get_supplier_debt_summary_filtered (00018).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_invoice_debt AS
SELECT
  i.id                                             AS invoice_id,
  i.invoice_no,
  i.invoice_date,
  i.supplier_id,
  s.code                                           AS supplier_code,
  s.name                                            AS supplier_name,
  i.final_amount::numeric                           AS invoice_total,
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
