-- ============================================================
-- PHASE 15: Legacy Excel import support
--
-- legacy_ref is a deterministic fingerprint the import script derives from
-- the source workbook (e.g. date+shift+supplier for a receipt, or the
-- "Ngày Lưu" save-timestamp for an invoice) — NOT the generated receipt_no
-- / user-entered invoice_no. Re-running the import script is then a no-op
-- for rows already imported: import_legacy_receipt / import_legacy_invoice
-- look up legacy_ref first and skip insertion if it already exists, instead
-- of relying on receipt_no/invoice_no (which could collide or regenerate
-- differently across runs).
-- ============================================================

ALTER TABLE public.receipts ADD COLUMN legacy_ref text UNIQUE;
ALTER TABLE public.invoices ADD COLUMN legacy_ref text UNIQUE;

COMMENT ON COLUMN public.receipts.legacy_ref IS
  'Deterministic fingerprint from the Phase 15 legacy Excel import (NULL for receipts created normally through the app). Used for import idempotency, not display.';
COMMENT ON COLUMN public.invoices.legacy_ref IS
  'Deterministic fingerprint from the Phase 15 legacy Excel import (NULL for invoices created normally through the app). Used for import idempotency, not display.';


-- ------------------------------------------------------------
-- import_legacy_receipt: idempotent version of create_receipt for bulk
-- migration. receipt_no is supplied by the caller (script-generated,
-- LEGACY-PN-prefixed) rather than drawn from generate_receipt_no(), so the
-- import never perturbs the live per-day counter used by the app's own
-- "create new receipt" flow.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_legacy_receipt(
  p_legacy_ref    text,
  p_receipt_no    text,
  p_receipt_date  date,
  p_shift         text,
  p_supplier_id   uuid,
  p_receiver_name text,
  p_note          text,
  p_items         jsonb
)
RETURNS TABLE (receipt_id uuid, receipt_no text, inserted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_id uuid;
  v_receipt_id  uuid;
  v_item        jsonb;
BEGIN
  IF p_legacy_ref IS NULL OR p_legacy_ref = '' THEN
    RAISE EXCEPTION 'legacy_ref là bắt buộc cho import legacy.';
  END IF;

  SELECT id INTO v_existing_id FROM public.receipts WHERE receipts.legacy_ref = p_legacy_ref;
  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_id, p_receipt_no, false;
    RETURN;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Phiếu nhập phải có ít nhất 1 sản phẩm.';
  END IF;

  INSERT INTO public.receipts
    (receipt_no, receipt_date, shift, supplier_id, receiver_name, note, legacy_ref)
  VALUES
    (p_receipt_no, p_receipt_date, p_shift, p_supplier_id, p_receiver_name, p_note, p_legacy_ref)
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

  RETURN QUERY SELECT v_receipt_id, p_receipt_no, true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.import_legacy_receipt(text, text, date, text, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_legacy_receipt(text, text, date, text, uuid, text, text, jsonb) TO service_role;


-- ------------------------------------------------------------
-- import_legacy_invoice: idempotent version of create_invoice for bulk
-- migration, same legacy_ref lookup-before-insert pattern.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_legacy_invoice(
  p_legacy_ref   text,
  p_supplier_id  uuid,
  p_invoice_no   text,
  p_invoice_date date,
  p_note         text,
  p_items        jsonb
)
RETURNS TABLE (invoice_id uuid, invoice_no text, inserted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_id uuid;
  v_invoice_id  uuid;
  v_item        jsonb;
BEGIN
  IF p_legacy_ref IS NULL OR p_legacy_ref = '' THEN
    RAISE EXCEPTION 'legacy_ref là bắt buộc cho import legacy.';
  END IF;

  SELECT id INTO v_existing_id FROM public.invoices WHERE invoices.legacy_ref = p_legacy_ref;
  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_id, p_invoice_no, false;
    RETURN;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Hóa đơn phải có ít nhất 1 sản phẩm.';
  END IF;

  INSERT INTO public.invoices (invoice_no, supplier_id, invoice_date, note, legacy_ref)
  VALUES (p_invoice_no, p_supplier_id, p_invoice_date, p_note, p_legacy_ref)
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

  RETURN QUERY SELECT v_invoice_id, p_invoice_no, true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.import_legacy_invoice(text, uuid, text, date, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_legacy_invoice(text, uuid, text, date, text, jsonb) TO service_role;
