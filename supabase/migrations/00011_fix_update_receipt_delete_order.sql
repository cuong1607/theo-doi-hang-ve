-- ============================================================
-- Fix: update_receipt inserted/updated items *before* deleting removed
-- ones. If a user removed an item and then added a new line for the same
-- product (e.g. re-picking a SKU that just became available again in the
-- dropdown), the INSERT for the "new" row collided with the
-- (receipt_id, product_id) unique constraint because the old row hadn't
-- been deleted yet. Delete first, then insert/update — the ids to keep are
-- already known from the incoming payload, no need to derive them from the
-- insert/update loop.
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
  v_keep_ids   uuid[];
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

  -- Ids the payload wants to keep (existing rows being updated). Delete
  -- everything else on this receipt *before* inserting new rows, so a
  -- product_id freed up by a removal is available immediately.
  SELECT COALESCE(array_agg((v->>'id')::uuid), ARRAY[]::uuid[])
  INTO v_keep_ids
  FROM jsonb_array_elements(p_items) v
  WHERE NULLIF(v->>'id', '') IS NOT NULL;

  DELETE FROM public.receipt_items
  WHERE public.receipt_items.receipt_id = p_receipt_id
    AND NOT (public.receipt_items.id = ANY(v_keep_ids));

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
      );
    END IF;
  END LOOP;

  RETURN QUERY SELECT p_receipt_id, v_receipt_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_receipt(uuid, date, text, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_receipt(uuid, date, text, uuid, text, text, jsonb) TO service_role;
