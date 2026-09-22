-- ============================================================
-- PHASE CN1: Payments & supplier debt (database only, no UI)
--
-- paid_amount / remaining_amount / payment_status are NEVER stored on
-- invoices — they are always derived from payment_items via the views
-- below (v_invoice_debt, v_supplier_debt_summary), the same "tính động,
-- không cache" principle already used for daily receipt summaries
-- (v_daily_receipt_summary) and outstanding goods (v_outstanding).
-- ============================================================

-- ------------------------------------------------------------
-- 1. TABLE: payments
-- One payment = one payment run to a supplier, covering >=1 invoices.
-- ------------------------------------------------------------
CREATE TABLE public.payments (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   uuid          NOT NULL REFERENCES public.suppliers(id),
  payment_date  date          NOT NULL,
  total_amount  numeric(15,2) NOT NULL CHECK (total_amount > 0),
  note          text,
  created_by    uuid          REFERENCES public.profiles(id),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_supplier_id  ON public.payments (supplier_id);
CREATE INDEX idx_payments_payment_date ON public.payments (payment_date);

CREATE TRIGGER set_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 2. TABLE: payment_items
-- How one payment splits across the invoices it settles. amount is capped
-- at neither invoice_total nor remaining_amount here — allocation rules
-- belong to the (future) app layer that writes these rows, not the schema.
-- ------------------------------------------------------------
CREATE TABLE public.payment_items (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid          NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  invoice_id  uuid          NOT NULL REFERENCES public.invoices(id),
  amount      numeric(15,2) NOT NULL CHECK (amount > 0),
  created_at  timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX idx_payment_items_invoice_id ON public.payment_items (invoice_id);
CREATE INDEX idx_payment_items_payment_id ON public.payment_items (payment_id);

ALTER TABLE public.payment_items ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 3. RLS POLICIES
-- Same shape as invoices/invoice_items (00001): authenticated users get
-- full access pending real role-based rules from Phase 5 (Authentication).
-- payments mirrors invoices (no DELETE policy); payment_items mirrors
-- invoice_items (DELETE allowed, for diff-based edits of a payment's lines).
-- ------------------------------------------------------------

-- payments
CREATE POLICY "Authenticated users can view payments"
  ON public.payments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert payments"
  ON public.payments FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update payments"
  ON public.payments FOR UPDATE
  TO authenticated
  USING (true);

-- payment_items
CREATE POLICY "Authenticated users can view payment_items"
  ON public.payment_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert payment_items"
  ON public.payment_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update payment_items"
  ON public.payment_items FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can delete payment_items"
  ON public.payment_items FOR DELETE
  TO authenticated
  USING (true);


-- ------------------------------------------------------------
-- 4. VIEW: v_invoice_debt
-- Per-invoice debt: invoice_total (from invoice_items), paid_amount (from
-- payment_items), remaining_amount, payment_status. Two independent
-- pre-aggregated subqueries joined by invoice_id — avoids a fan-out join
-- (invoice_items x payment_items) that would double-count either side.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_invoice_debt AS
SELECT
  i.id                                                                AS invoice_id,
  i.invoice_no,
  i.invoice_date,
  i.supplier_id,
  s.code                                                               AS supplier_code,
  s.name                                                                AS supplier_name,
  COALESCE(items.invoice_total, 0)                                    AS invoice_total,
  COALESCE(paid.paid_amount, 0)                                       AS paid_amount,
  COALESCE(items.invoice_total, 0) - COALESCE(paid.paid_amount, 0)    AS remaining_amount,
  CASE
    WHEN COALESCE(paid.paid_amount, 0) <= 0                            THEN 'unpaid'
    WHEN COALESCE(paid.paid_amount, 0) >= COALESCE(items.invoice_total, 0) THEN 'paid'
    ELSE 'partial'
  END                                                                  AS payment_status
FROM public.invoices i
JOIN public.suppliers s ON s.id = i.supplier_id
LEFT JOIN (
  SELECT invoice_id, SUM(line_total) AS invoice_total
  FROM public.invoice_items
  GROUP BY invoice_id
) items ON items.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS paid_amount
  FROM public.payment_items
  GROUP BY invoice_id
) paid ON paid.invoice_id = i.id;


-- ------------------------------------------------------------
-- 5. VIEW: v_supplier_debt_summary
-- Per-supplier rollup of v_invoice_debt. supplier_open_invoice_count counts
-- invoices whose payment_status is not 'paid' (unpaid + partial).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_supplier_debt_summary AS
SELECT
  s.id                                                          AS supplier_id,
  s.code                                                        AS supplier_code,
  s.name                                                        AS supplier_name,
  COALESCE(SUM(d.invoice_total), 0)                             AS supplier_invoice_total,
  COALESCE(SUM(d.paid_amount), 0)                               AS supplier_paid_total,
  COALESCE(SUM(d.remaining_amount), 0)                          AS supplier_remaining_total,
  COUNT(*) FILTER (WHERE d.payment_status <> 'paid')            AS supplier_open_invoice_count
FROM public.suppliers s
LEFT JOIN public.v_invoice_debt d ON d.supplier_id = s.id
GROUP BY s.id, s.code, s.name;
