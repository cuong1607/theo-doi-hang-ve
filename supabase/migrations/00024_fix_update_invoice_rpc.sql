-- ============================================================
-- Fix update_invoice (00023), which had the same two bugs update_receipt
-- already hit and fixed once before (00010, 00011) — should have been
-- caught by reading those first:
--
-- 1. Ambiguous column: the bare identifier `invoice_id` is ambiguous
--    between invoice_items.invoice_id and this function's own
--    RETURNS TABLE (invoice_id uuid, ...) output column (PL/pgSQL exposes
--    RETURNS TABLE columns as variables in scope). Fully qualify every
--    column reference.
-- 2. Delete-before-insert ordering: updating/inserting items before
--    deleting removed ones can collide with the (invoice_id, product_id)
--    unique constraint if a removed product_id is immediately reused by a
--    new line in the same edit. Compute the keep-list up front and delete
--    first.
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_invoice(
  p_invoice_id      uuid,
  p_supplier_id     uuid,
  p_invoice_no      text,
  p_invoice_date    date,
  p_note            text,
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
  v_item      jsonb;
  v_item_id   uuid;
  v_keep_ids  uuid[];
  v_invoice_no text;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Hóa đơn phải có ít nhất 1 sản phẩm.';
  END IF;

  UPDATE public.invoices
  SET supplier_id     = p_supplier_id,
      invoice_date    = p_invoice_date,
      note            = p_note,
      subtotal        = p_subtotal,
      discount_type   = p_discount_type,
      discount_value  = p_discount_value,
      discount_amount = p_discount_amount,
      vat_rate        = p_vat_rate,
      vat_amount      = p_vat_amount,
      final_amount    = p_final_amount,
      invoice_no      = p_invoice_no
  WHERE public.invoices.id = p_invoice_id
  RETURNING public.invoices.invoice_no INTO v_invoice_no;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn.';
  END IF;

  -- Ids the payload wants to keep (existing rows being updated). Delete
  -- everything else on this invoice *before* inserting new rows, so a
  -- product_id freed up by a removal is available immediately.
  SELECT COALESCE(array_agg((v->>'id')::uuid), ARRAY[]::uuid[])
  INTO v_keep_ids
  FROM jsonb_array_elements(p_items) v
  WHERE NULLIF(v->>'id', '') IS NOT NULL;

  DELETE FROM public.invoice_items
  WHERE public.invoice_items.invoice_id = p_invoice_id
    AND NOT (public.invoice_items.id = ANY(v_keep_ids));

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := NULLIF(v_item->>'id', '')::uuid;

    IF v_item_id IS NOT NULL THEN
      UPDATE public.invoice_items
      SET product_id = (v_item->>'product_id')::uuid,
          unit_price = (v_item->>'unit_price')::numeric,
          quantity   = (v_item->>'quantity')::numeric
      WHERE public.invoice_items.id = v_item_id
        AND public.invoice_items.invoice_id = p_invoice_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Không tìm thấy dòng hàng % trong hóa đơn này.', v_item_id;
      END IF;
    ELSE
      INSERT INTO public.invoice_items (invoice_id, product_id, unit_price, quantity)
      VALUES (
        p_invoice_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'unit_price')::numeric,
        (v_item->>'quantity')::numeric
      );
    END IF;
  END LOOP;

  RETURN QUERY SELECT p_invoice_id, v_invoice_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_invoice(
  uuid, uuid, text, date, text, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_invoice(
  uuid, uuid, text, date, text, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) TO service_role;
