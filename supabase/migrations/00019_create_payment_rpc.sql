-- ============================================================
-- PHASE CN3: Atomic payment creation (payments + payment_items).
--
-- A PL/pgSQL function body runs inside the transaction of the calling
-- statement — any RAISE EXCEPTION here (mixed-supplier invoice, invoice not
-- found, non-positive amount) aborts the whole call and rolls back
-- everything, including the payments row itself. There is no insert-then-
-- cleanup step to get wrong, same pattern as create_receipt/create_invoice.
--
-- p_items validation (all same supplier, amount > 0) is deliberately
-- re-checked here even though the app layer (src/lib/payments/actions.ts)
-- already validates the same things against fresh data before calling this
-- — the database is the final authority, not just the app.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_payment(
  p_supplier_id  uuid,
  p_payment_date date,
  p_note         text,
  p_created_by   uuid,
  p_items        jsonb -- [{ invoice_id, amount }]
)
RETURNS TABLE (payment_id uuid, total_amount numeric)
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment_id     uuid;
  v_total          numeric := 0;
  v_item           jsonb;
  v_invoice_id     uuid;
  v_amount         numeric;
  v_invoice_supplier uuid;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Phải chọn ít nhất 1 hóa đơn để thanh toán.';
  END IF;

  -- Validate every item before inserting anything: same supplier as
  -- p_supplier_id, amount > 0. Also sums total_amount here so
  -- payments.total_amount is guaranteed to equal SUM(payment_items.amount)
  -- by construction, not by a separate reconciliation step.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_invoice_id := (v_item->>'invoice_id')::uuid;
    v_amount     := (v_item->>'amount')::numeric;

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Số tiền thanh toán phải lớn hơn 0.';
    END IF;

    SELECT supplier_id INTO v_invoice_supplier
    FROM public.invoices
    WHERE id = v_invoice_id;

    IF v_invoice_supplier IS NULL THEN
      RAISE EXCEPTION 'Không tìm thấy hóa đơn %.', v_invoice_id;
    END IF;

    IF v_invoice_supplier <> p_supplier_id THEN
      RAISE EXCEPTION 'Tất cả hóa đơn trong một lần thanh toán phải thuộc cùng một nhà cung cấp.';
    END IF;

    v_total := v_total + v_amount;
  END LOOP;

  INSERT INTO public.payments (supplier_id, payment_date, total_amount, note, created_by)
  VALUES (p_supplier_id, p_payment_date, v_total, p_note, p_created_by)
  RETURNING id INTO v_payment_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.payment_items (payment_id, invoice_id, amount)
    VALUES (
      v_payment_id,
      (v_item->>'invoice_id')::uuid,
      (v_item->>'amount')::numeric
    );
  END LOOP;

  RETURN QUERY SELECT v_payment_id, v_total;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_payment(uuid, date, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_payment(uuid, date, text, uuid, jsonb) TO service_role;
