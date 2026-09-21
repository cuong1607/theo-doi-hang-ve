-- ============================================================
-- PHASE 8: Receipt number generation + atomic receipt creation
-- ============================================================

-- ------------------------------------------------------------
-- 1. Per-day counter for receipt_no (PN-YYYYMMDD-XXXX)
-- ------------------------------------------------------------
CREATE TABLE public.receipt_no_counters (
  receipt_date date PRIMARY KEY,
  last_value   integer NOT NULL DEFAULT 0
);

ALTER TABLE public.receipt_no_counters ENABLE ROW LEVEL SECURITY;
-- No policies: only touched internally by generate_receipt_no() below.

-- ------------------------------------------------------------
-- 2. generate_receipt_no: race-condition-safe sequence per day
--
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING is one atomic statement —
-- Postgres takes a row lock on the counter row, so concurrent callers for
-- the same date are serialized instead of racing on `SELECT count(*) + 1`.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_receipt_no(p_receipt_date date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_next integer;
BEGIN
  INSERT INTO public.receipt_no_counters (receipt_date, last_value)
  VALUES (p_receipt_date, 1)
  ON CONFLICT (receipt_date)
  DO UPDATE SET last_value = public.receipt_no_counters.last_value + 1
  RETURNING last_value INTO v_next;

  RETURN 'PN-' || to_char(p_receipt_date, 'YYYYMMDD') || '-' || lpad(v_next::text, 4, '0');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_receipt_no(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_receipt_no(date) TO service_role;

-- ------------------------------------------------------------
-- 3. create_receipt: insert receipt + all its items in one transaction.
--
-- A PL/pgSQL function body runs inside the transaction of the calling
-- statement. Any exception raised here (bad FK, the receipt_items
-- (receipt_id, product_id) unique constraint catching a duplicate SKU,
-- a failed check constraint) aborts the whole function call, rolling back
-- the receipt row too — there is no insert-then-cleanup step to get wrong.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_receipt(
  p_receipt_date  date,
  p_shift         text,
  p_supplier_id   uuid,
  p_receiver_name text,
  p_note          text,
  p_created_by    uuid,
  p_items         jsonb
)
RETURNS TABLE (receipt_id uuid, receipt_no text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_receipt_no text;
  v_receipt_id uuid;
  v_item       jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Phiếu nhập phải có ít nhất 1 sản phẩm.';
  END IF;

  v_receipt_no := public.generate_receipt_no(p_receipt_date);

  INSERT INTO public.receipts (receipt_no, receipt_date, shift, supplier_id, receiver_name, note, created_by)
  VALUES (v_receipt_no, p_receipt_date, p_shift, p_supplier_id, p_receiver_name, p_note, p_created_by)
  RETURNING id INTO v_receipt_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.receipt_items (receipt_id, product_id, unit_price, delivered_qty, received_qty)
    VALUES (
      v_receipt_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'unit_price')::numeric,
      (v_item->>'delivered_qty')::numeric,
      (v_item->>'received_qty')::numeric
    );
  END LOOP;

  RETURN QUERY SELECT v_receipt_id, v_receipt_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_receipt(date, text, uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_receipt(date, text, uuid, text, text, uuid, jsonb) TO service_role;
