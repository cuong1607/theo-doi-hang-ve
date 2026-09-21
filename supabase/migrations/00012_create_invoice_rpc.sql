-- ============================================================
-- PHASE 11: Atomic supplier invoice creation.
--
-- invoice_no is user-entered (unlike receipt_no, which is auto-generated),
-- and its uniqueness is already enforced per-supplier by the
-- UNIQUE (supplier_id, invoice_no) constraint on public.invoices from the
-- initial schema. Duplicate SKU within one invoice is likewise already
-- enforced by UNIQUE (invoice_id, product_id) on public.invoice_items.
--
-- A PL/pgSQL function body runs inside the transaction of the calling
-- statement, so any exception here (bad FK, either unique constraint, a
-- failed check constraint) aborts the whole call and rolls back the
-- invoice row too — there is no insert-then-cleanup step to get wrong.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_invoice(
  p_supplier_id  uuid,
  p_invoice_no   text,
  p_invoice_date date,
  p_note         text,
  p_created_by   uuid,
  p_items        jsonb
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

  INSERT INTO public.invoices (invoice_no, supplier_id, invoice_date, note, created_by)
  VALUES (p_invoice_no, p_supplier_id, p_invoice_date, p_note, p_created_by)
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

REVOKE EXECUTE ON FUNCTION public.create_invoice(uuid, text, date, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_invoice(uuid, text, date, text, uuid, jsonb) TO service_role;
