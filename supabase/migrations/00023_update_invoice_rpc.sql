-- ============================================================
-- PHASE UP3: Atomic, diff-based invoice update.
--
-- Same shape as update_receipt (00009): does not delete-all-then-reinsert
-- items (would burn new ids for unchanged rows). Instead:
--   - item with an id already on this invoice -> UPDATE in place
--   - item with no id (or an id not on this invoice) -> INSERT
--   - existing item whose id is absent from the payload -> DELETE
-- Header update (incl. the financial snapshot columns from UP2) + all item
-- diffing run in one PL/pgSQL call, i.e. one transaction.
--
-- Like create_invoice, this RPC does not compute subtotal/discount/VAT
-- itself — the caller (updateInvoice in src/lib/invoices/actions.ts) has
-- already run calculateInvoiceFinancials server-side using the supplier's
-- current supplier_type, and this function just persists that result.
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
  v_item     jsonb;
  v_item_id  uuid;
  v_keep_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Hóa đơn phải có ít nhất 1 sản phẩm.';
  END IF;

  UPDATE public.invoices
  SET supplier_id     = p_supplier_id,
      invoice_no      = p_invoice_no,
      invoice_date    = p_invoice_date,
      note            = p_note,
      subtotal        = p_subtotal,
      discount_type   = p_discount_type,
      discount_value  = p_discount_value,
      discount_amount = p_discount_amount,
      vat_rate        = p_vat_rate,
      vat_amount      = p_vat_amount,
      final_amount    = p_final_amount
  WHERE id = p_invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn.';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := NULLIF(v_item->>'id', '')::uuid;

    IF v_item_id IS NOT NULL THEN
      UPDATE public.invoice_items
      SET product_id = (v_item->>'product_id')::uuid,
          unit_price = (v_item->>'unit_price')::numeric,
          quantity   = (v_item->>'quantity')::numeric
      WHERE id = v_item_id AND invoice_id = p_invoice_id;

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
      )
      RETURNING id INTO v_item_id;
    END IF;

    v_keep_ids := array_append(v_keep_ids, v_item_id);
  END LOOP;

  DELETE FROM public.invoice_items
  WHERE invoice_items.invoice_id = p_invoice_id
    AND NOT (invoice_items.id = ANY(v_keep_ids));

  RETURN QUERY SELECT p_invoice_id, p_invoice_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_invoice(
  uuid, uuid, text, date, text, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_invoice(
  uuid, uuid, text, date, text, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) TO service_role;
