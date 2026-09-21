-- ============================================================
-- Fix: update_receipt's UPDATE ... WHERE clause referenced the bare
-- identifier `receipt_id`, which is ambiguous between the
-- receipt_items.receipt_id column and the function's own
-- RETURNS TABLE (receipt_id uuid, ...) output column (PL/pgSQL exposes
-- RETURNS TABLE columns as variables in scope). Fully qualify the column.
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_receipt(
  p_receipt_id    uuid,
  p_receipt_date  date,
  p_shift         text,
  p_supplier_id   uuid,
  p_receiver_name text,
  p_note          text,
  p_items         jsonb
)
RETURNS TABLE (receipt_id uuid, receipt_no text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_item       jsonb;
  v_item_id    uuid;
  v_keep_ids   uuid[] := ARRAY[]::uuid[];
  v_receipt_no text;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Phiếu nhập phải có ít nhất 1 sản phẩm.';
  END IF;

  UPDATE public.receipts
  SET receipt_date  = p_receipt_date,
      shift         = p_shift,
      supplier_id   = p_supplier_id,
      receiver_name = p_receiver_name,
      note          = p_note
  WHERE public.receipts.id = p_receipt_id
  RETURNING public.receipts.receipt_no INTO v_receipt_no;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu nhập.';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := NULLIF(v_item->>'id', '')::uuid;

    IF v_item_id IS NOT NULL THEN
      UPDATE public.receipt_items
      SET product_id    = (v_item->>'product_id')::uuid,
          unit_price    = (v_item->>'unit_price')::numeric,
          delivered_qty = (v_item->>'delivered_qty')::numeric,
          received_qty  = (v_item->>'received_qty')::numeric
      WHERE public.receipt_items.id = v_item_id
        AND public.receipt_items.receipt_id = p_receipt_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Không tìm thấy dòng hàng % trong phiếu này.', v_item_id;
      END IF;
    ELSE
      INSERT INTO public.receipt_items (receipt_id, product_id, unit_price, delivered_qty, received_qty)
      VALUES (
        p_receipt_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'unit_price')::numeric,
        (v_item->>'delivered_qty')::numeric,
        (v_item->>'received_qty')::numeric
      )
      RETURNING id INTO v_item_id;
    END IF;

    v_keep_ids := array_append(v_keep_ids, v_item_id);
  END LOOP;

  DELETE FROM public.receipt_items
  WHERE public.receipt_items.receipt_id = p_receipt_id
    AND NOT (public.receipt_items.id = ANY(v_keep_ids));

  RETURN QUERY SELECT p_receipt_id, v_receipt_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_receipt(uuid, date, text, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_receipt(uuid, date, text, uuid, text, text, jsonb) TO service_role;
