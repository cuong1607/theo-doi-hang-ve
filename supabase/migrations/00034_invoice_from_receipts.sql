-- ============================================================
-- PHASE INV-FROM-RECEIPTS: Create invoice from receipt history
--
-- Two invoice sources now coexist in the SAME invoices table:
--
--   manual         = entered by hand on /invoices/new (invoice usually
--                    arrives before the goods). Outstanding received_qty
--                    keeps the pre-existing Excel-compatible rule
--                    (receipt_date >= invoice_date, same supplier+SKU —
--                    see migration 00014). UNCHANGED by this phase.
--
--   from_receipts  = generated on /receipts from a set of selected
--                    (supplier, receipt_date) daily groups (goods arrived
--                    first, the supplier invoices afterwards). Outstanding
--                    received_qty comes ONLY from the linked days recorded
--                    in invoice_receipt_days, matched on product_id AND
--                    unit_price. receipt_start_date is a business label
--                    (earliest linked day), NEVER a query range: linking
--                    01/09, 03/09, 04/09 does not pull in 02/09.
--
-- Custom SQLSTATEs raised here (mapped to Vietnamese messages by the app,
-- see src/lib/invoices/receipt-days.ts):
--   HD001  a selected day is already linked to another invoice
--   HD002  receipt data changed between preview and save
--   HD003  duplicate invoice_no for this supplier
--   HD004  a selected day has no receipts for this supplier
--   HD005  selected days have no received quantity at all
--   HD006  no day selected
--   HD007  supplier not found
--   HD008  financial snapshot inconsistent with the supplier policy
--   HD009  wrong edit path for this invoice's source_type
--   HD010  receipt edit blocked: its day is linked to an invoice
-- ============================================================


-- ------------------------------------------------------------
-- 1. invoices: source_type + receipt_start_date
-- ------------------------------------------------------------
-- ADD COLUMN ... NOT NULL DEFAULT 'manual' backfills every existing row
-- with 'manual' in the same statement. Old invoices are never inferred as
-- from_receipts, and no historical receipt day gets attached to them.
ALTER TABLE public.invoices
  ADD COLUMN source_type        text NOT NULL DEFAULT 'manual',
  ADD COLUMN receipt_start_date date;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_source_type_check
    CHECK (source_type IN ('manual', 'from_receipts')),
  ADD CONSTRAINT invoices_receipt_start_date_check
    CHECK (source_type = 'manual' OR receipt_start_date IS NOT NULL),
  -- Target for invoice_receipt_days' composite FK below: lets the database
  -- itself guarantee a linked day's supplier_id equals its invoice's.
  ADD CONSTRAINT invoices_id_supplier_id_key UNIQUE (id, supplier_id);

CREATE INDEX idx_invoices_source_type ON public.invoices (source_type);


-- ------------------------------------------------------------
-- 2. invoice_items: same SKU may appear once per unit_price
--
-- A from_receipts invoice groups receipt lines by (product_id, unit_price):
-- the same SKU received at 100.000 on 01/09 and 110.000 on 03/09 becomes two
-- invoice lines, never a weighted average. The old UNIQUE (invoice_id,
-- product_id) would reject that, so it is widened. Manual invoices keep
-- one line per SKU — still enforced by the app's zod schema (createInvoice/
-- updateInvoice), since the manual outstanding rule is per product_id.
-- ------------------------------------------------------------
ALTER TABLE public.invoice_items
  DROP CONSTRAINT invoice_items_invoice_id_product_id_key;

ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_invoice_product_price_key UNIQUE (invoice_id, product_id, unit_price);


-- ------------------------------------------------------------
-- 3. invoice_receipt_days
-- ------------------------------------------------------------
CREATE TABLE public.invoice_receipt_days (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid        NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  supplier_id  uuid        NOT NULL REFERENCES public.suppliers(id),
  receipt_date date        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- One daily receipt group of one supplier feeds at most one
  -- from_receipts invoice. Last line of defense against two concurrent
  -- saves picking the same day.
  UNIQUE (supplier_id, receipt_date),

  -- invoice.supplier_id == invoice_receipt_days.supplier_id, enforced by
  -- the database rather than trusted from any caller. NO ACTION on update:
  -- an invoice's supplier cannot change while it has linked days.
  CONSTRAINT invoice_receipt_days_invoice_supplier_fkey
    FOREIGN KEY (invoice_id, supplier_id)
    REFERENCES public.invoices (id, supplier_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_invoice_receipt_days_invoice_id   ON public.invoice_receipt_days (invoice_id);
CREATE INDEX idx_invoice_receipt_days_supplier_id  ON public.invoice_receipt_days (supplier_id);
CREATE INDEX idx_invoice_receipt_days_receipt_date ON public.invoice_receipt_days (receipt_date);

ALTER TABLE public.invoice_receipt_days ENABLE ROW LEVEL SECURITY;

-- Rows are written only by create_invoice_from_receipts and removed only by
-- the ON DELETE CASCADE from invoices — so read + insert, no update/delete
-- policy (same "no DELETE policy" convention as invoices itself).
CREATE POLICY "Authenticated users can view invoice_receipt_days"
  ON public.invoice_receipt_days FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert invoice_receipt_days"
  ON public.invoice_receipt_days FOR INSERT
  TO authenticated
  WITH CHECK (true);


-- ------------------------------------------------------------
-- 4. Per-(supplier, day) serialization
--
-- Transaction-scoped advisory lock shared by (a) invoice creation from
-- receipts and (b) every write to receipts/receipt_items on that day. It
-- closes the race where a receipt is saved on day D while an invoice for
-- day D is being built: whichever takes the lock second re-reads committed
-- data (READ COMMITTED + a fresh snapshot per statement) and either sees
-- the new receipt, or sees the day is now linked and is rejected.
-- The first int namespaces these locks away from any other advisory use.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_receipt_day(p_supplier_id uuid, p_receipt_date date)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(34001, hashtext(p_supplier_id::text || '|' || p_receipt_date::text));
$$;

REVOKE EXECUTE ON FUNCTION public.lock_receipt_day(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_receipt_day(uuid, date) TO service_role;


-- ------------------------------------------------------------
-- 5. Edit lock for linked receipt days
--
-- Once a day feeds a from_receipts invoice, its receipt data can no longer
-- change underneath that invoice's snapshot (e.g. 100 -> 120 received would
-- silently desync invoice qty vs linked received qty). Enforced by triggers
-- so EVERY write path is covered — create_receipt, update_receipt, and any
-- future path — not just the current server actions.
--
-- Blocked: adding a receipt to a linked day, deleting one, moving one into
-- or out of a linked day (OLD and NEW supplier/date are both checked), and
-- adding/removing/changing any item line (product, price, delivered or
-- received qty) of a receipt on a linked day.
-- Still allowed: receiver_name / note / shift on such a receipt — none of
-- those feed the invoice. update_receipt re-writes unchanged item lines
-- with identical values, which the item trigger treats as a no-op.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_receipt_day_unlinked(p_supplier_id uuid, p_receipt_date date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_no text;
BEGIN
  PERFORM public.lock_receipt_day(p_supplier_id, p_receipt_date);

  SELECT i.invoice_no INTO v_invoice_no
  FROM public.invoice_receipt_days d
  JOIN public.invoices i ON i.id = d.invoice_id
  WHERE d.supplier_id = p_supplier_id
    AND d.receipt_date = p_receipt_date;

  IF FOUND THEN
    RAISE EXCEPTION 'Ngày hàng về này đã được sử dụng để lập hóa đơn %. Không thể thay đổi dữ liệu hàng về trực tiếp.', v_invoice_no
      USING ERRCODE = 'HD010';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_receipt_day_unlinked(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_receipt_day_unlinked(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_linked_receipt_day()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.assert_receipt_day_unlinked(NEW.supplier_id, NEW.receipt_date);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_receipt_day_unlinked(OLD.supplier_id, OLD.receipt_date);
    RETURN OLD;
  END IF;

  -- UPDATE: only a supplier/date move changes which daily group the
  -- receipt's items count toward. Check both sides, locking them in a
  -- stable order so two opposite moves can't deadlock each other.
  IF (OLD.supplier_id, OLD.receipt_date) IS DISTINCT FROM (NEW.supplier_id, NEW.receipt_date) THEN
    IF (OLD.supplier_id::text, OLD.receipt_date) < (NEW.supplier_id::text, NEW.receipt_date) THEN
      PERFORM public.assert_receipt_day_unlinked(OLD.supplier_id, OLD.receipt_date);
      PERFORM public.assert_receipt_day_unlinked(NEW.supplier_id, NEW.receipt_date);
    ELSE
      PERFORM public.assert_receipt_day_unlinked(NEW.supplier_id, NEW.receipt_date);
      PERFORM public.assert_receipt_day_unlinked(OLD.supplier_id, OLD.receipt_date);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_linked_receipt_day
  BEFORE INSERT OR UPDATE OR DELETE ON public.receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_linked_receipt_day();

CREATE OR REPLACE FUNCTION public.guard_linked_receipt_item_day()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_supplier_id  uuid;
  v_receipt_date date;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.receipt_id    = OLD.receipt_id
     AND NEW.product_id    = OLD.product_id
     AND NEW.unit_price    = OLD.unit_price
     AND NEW.delivered_qty = OLD.delivered_qty
     AND NEW.received_qty  = OLD.received_qty THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    -- On a cascade from a receipt DELETE the parent row is already gone
    -- (and the receipts trigger already vetted that delete) — nothing to do.
    SELECT r.supplier_id, r.receipt_date INTO v_supplier_id, v_receipt_date
    FROM public.receipts r WHERE r.id = OLD.receipt_id;
    IF FOUND THEN
      PERFORM public.assert_receipt_day_unlinked(v_supplier_id, v_receipt_date);
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT r.supplier_id, r.receipt_date INTO v_supplier_id, v_receipt_date
    FROM public.receipts r WHERE r.id = NEW.receipt_id;
    IF FOUND THEN
      PERFORM public.assert_receipt_day_unlinked(v_supplier_id, v_receipt_date);
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER guard_linked_receipt_item_day
  BEFORE INSERT OR UPDATE OR DELETE ON public.receipt_items
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_linked_receipt_item_day();


-- ------------------------------------------------------------
-- 6. get_receipt_days_invoice_lines: the ONE grouping of selected days
-- into invoice lines. Used by the preview (server action) and re-run inside
-- create_invoice_from_receipts, so preview and saved invoice can't diverge.
--
-- Exactly the selected dates (= ANY), never a date range. All shifts and all
-- receipts of each day. received_qty only (delivered_qty never becomes an
-- invoice quantity). Grouped by (product_id, unit_price): the receipt's
-- unit_price snapshot is the price source, never products.current_price.
-- Groups whose total received_qty is 0 produce no invoice line.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_receipt_days_invoice_lines(
  p_supplier_id  uuid,
  p_receipt_dates date[]
)
RETURNS TABLE (
  product_id   uuid,
  sku          text,
  product_name text,
  unit         text,
  unit_price   numeric,
  quantity     numeric,
  line_total   numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ri.product_id,
    p.sku,
    p.name,
    p.unit,
    ri.unit_price,
    SUM(ri.received_qty)                        AS quantity,
    ROUND(SUM(ri.received_qty) * ri.unit_price, 2) AS line_total
  FROM public.receipts r
  JOIN public.receipt_items ri ON ri.receipt_id = r.id
  JOIN public.products p       ON p.id = ri.product_id
  WHERE r.supplier_id = p_supplier_id
    AND r.receipt_date = ANY (p_receipt_dates)
  GROUP BY ri.product_id, p.sku, p.name, p.unit, ri.unit_price
  HAVING SUM(ri.received_qty) > 0
  ORDER BY p.sku ASC, ri.unit_price ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_receipt_days_invoice_lines(uuid, date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_receipt_days_invoice_lines(uuid, date[]) TO service_role;


-- ------------------------------------------------------------
-- 7. create_invoice_from_receipts: atomic create
--
-- The financial snapshot (subtotal/discount/VAT/final) is still computed by
-- calculateInvoiceFinancials on the server action side — the single owner
-- of those formulas — from lines the server itself loaded via
-- get_receipt_days_invoice_lines. This function then re-validates
-- everything under the per-day locks: days exist, are unlinked, the lines
-- it recomputes right now equal p_items exactly, and the snapshot is
-- arithmetically consistent with those lines and the supplier's policy.
-- invoice_items are inserted from its OWN recomputed lines, never from
-- p_items. Any failure aborts the whole call — header, items and links
-- roll back together.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice_from_receipts(
  p_supplier_id     uuid,
  p_receipt_dates   date[],
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
  v_dates         date[];
  v_date          date;
  v_supplier_type text;
  v_invoice_id    uuid;
  v_linked_no     text;
  v_lines         jsonb;
  v_mismatch      bigint;
  v_line_count    bigint;
  v_subtotal      numeric;
BEGIN
  -- Normalize: drop nulls, de-duplicate, sort (stable lock order below).
  SELECT COALESCE(array_agg(DISTINCT d ORDER BY d), ARRAY[]::date[])
  INTO v_dates
  FROM unnest(p_receipt_dates) AS d
  WHERE d IS NOT NULL;

  IF cardinality(v_dates) = 0 THEN
    RAISE EXCEPTION 'Vui lòng chọn ít nhất 1 ngày hàng về.' USING ERRCODE = 'HD006';
  END IF;

  SELECT s.supplier_type INTO v_supplier_type
  FROM public.suppliers s WHERE s.id = p_supplier_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nhà cung cấp không tồn tại.' USING ERRCODE = 'HD007';
  END IF;

  FOREACH v_date IN ARRAY v_dates LOOP
    PERFORM public.lock_receipt_day(p_supplier_id, v_date);
  END LOOP;

  -- Every selected day must be a real daily group of THIS supplier.
  SELECT d INTO v_date
  FROM unnest(v_dates) AS d
  WHERE NOT EXISTS (
    SELECT 1 FROM public.receipts r
    WHERE r.supplier_id = p_supplier_id AND r.receipt_date = d
  )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Ngày % không có phiếu nhập của nhà cung cấp này.', to_char(v_date, 'DD/MM/YYYY')
      USING ERRCODE = 'HD004';
  END IF;

  SELECT i.invoice_no INTO v_linked_no
  FROM public.invoice_receipt_days d
  JOIN public.invoices i ON i.id = d.invoice_id
  WHERE d.supplier_id = p_supplier_id
    AND d.receipt_date = ANY (v_dates)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Ngày hàng về đã được lập hóa đơn %.', v_linked_no USING ERRCODE = 'HD001';
  END IF;

  -- Recompute the lines now, under the locks. Kept as jsonb (not a temp
  -- table) so the function needs no TEMP privilege.
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'product_id', l.product_id,
      'unit_price', l.unit_price,
      'quantity',   l.quantity
    )), '[]'::jsonb),
    count(*),
    ROUND(COALESCE(SUM(l.line_total), 0), 2)
  INTO v_lines, v_line_count, v_subtotal
  FROM public.get_receipt_days_invoice_lines(p_supplier_id, v_dates) l;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Các ngày đã chọn không có số lượng hàng nhận.' USING ERRCODE = 'HD005';
  END IF;

  -- The lines the caller priced must be exactly what's in the DB right now
  -- (multiset equality both ways).
  WITH expected AS (
    SELECT e.product_id, e.unit_price, e.quantity
    FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb))
      AS e(product_id uuid, unit_price numeric, quantity numeric)
  ),
  actual AS (
    SELECT a.product_id, a.unit_price, a.quantity
    FROM jsonb_to_recordset(v_lines)
      AS a(product_id uuid, unit_price numeric, quantity numeric)
  )
  SELECT count(*) INTO v_mismatch
  FROM (
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  ) diff;

  IF v_mismatch > 0 OR p_subtotal IS DISTINCT FROM v_subtotal THEN
    RAISE EXCEPTION 'Dữ liệu hàng về đã thay đổi. Vui lòng tải lại.' USING ERRCODE = 'HD002';
  END IF;

  IF p_final_amount IS DISTINCT FROM (p_subtotal - p_discount_amount + p_vat_amount)
     OR (v_supplier_type = 'company'
         AND (p_discount_type IS NOT NULL OR p_discount_amount <> 0))
     OR (v_supplier_type = 'business_household'
         AND (p_vat_rate <> 0 OR p_vat_amount <> 0)) THEN
    RAISE EXCEPTION 'Số liệu tài chính không hợp lệ với loại nhà cung cấp.' USING ERRCODE = 'HD008';
  END IF;

  BEGIN
    INSERT INTO public.invoices (
      invoice_no, supplier_id, invoice_date, note, created_by,
      subtotal, discount_type, discount_value, discount_amount,
      vat_rate, vat_amount, final_amount,
      source_type, receipt_start_date
    )
    VALUES (
      p_invoice_no, p_supplier_id, p_invoice_date, p_note, p_created_by,
      p_subtotal, p_discount_type, p_discount_value, p_discount_amount,
      p_vat_rate, p_vat_amount, p_final_amount,
      'from_receipts', v_dates[1]
    )
    RETURNING public.invoices.id INTO v_invoice_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Số hóa đơn này đã tồn tại cho nhà cung cấp đã chọn.' USING ERRCODE = 'HD003';
  END;

  INSERT INTO public.invoice_items (invoice_id, product_id, unit_price, quantity)
  SELECT v_invoice_id, a.product_id, a.unit_price, a.quantity
  FROM jsonb_to_recordset(v_lines) AS a(product_id uuid, unit_price numeric, quantity numeric);

  BEGIN
    INSERT INTO public.invoice_receipt_days (invoice_id, supplier_id, receipt_date)
    SELECT v_invoice_id, p_supplier_id, d FROM unnest(v_dates) AS d;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ngày hàng về vừa được sử dụng để lập hóa đơn khác.' USING ERRCODE = 'HD001';
  END;

  RETURN QUERY SELECT v_invoice_id, p_invoice_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_invoice_from_receipts(
  uuid, date[], text, date, text, uuid, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_receipts(
  uuid, date[], text, date, text, uuid, jsonb, numeric, text, numeric, numeric, numeric, numeric, numeric
) TO service_role;


-- ------------------------------------------------------------
-- 8. Editing a from_receipts invoice: header + financial policy only.
--
-- Supplier, receipt_start_date, linked days and items are fixed in this
-- phase (to change the source days: delete the invoice and create again).
-- p_subtotal must still equal the invoice's own stored item total — the
-- caller recomputes financials from the DB items, this re-checks it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_invoice_from_receipts_header(
  p_invoice_id      uuid,
  p_invoice_no      text,
  p_invoice_date    date,
  p_note            text,
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
  v_source_type text;
  v_subtotal    numeric;
BEGIN
  SELECT i.source_type INTO v_source_type
  FROM public.invoices i WHERE i.id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn.';
  END IF;
  IF v_source_type <> 'from_receipts' THEN
    RAISE EXCEPTION 'Hóa đơn này không được tạo từ hàng đã nhận.' USING ERRCODE = 'HD009';
  END IF;

  SELECT ROUND(COALESCE(SUM(ii.line_total), 0), 2) INTO v_subtotal
  FROM public.invoice_items ii WHERE ii.invoice_id = p_invoice_id;

  IF p_subtotal IS DISTINCT FROM v_subtotal
     OR p_final_amount IS DISTINCT FROM (p_subtotal - p_discount_amount + p_vat_amount) THEN
    RAISE EXCEPTION 'Số liệu tài chính không hợp lệ.' USING ERRCODE = 'HD008';
  END IF;

  BEGIN
    UPDATE public.invoices
    SET invoice_no      = p_invoice_no,
        invoice_date    = p_invoice_date,
        note            = p_note,
        subtotal        = p_subtotal,
        discount_type   = p_discount_type,
        discount_value  = p_discount_value,
        discount_amount = p_discount_amount,
        vat_rate        = p_vat_rate,
        vat_amount      = p_vat_amount,
        final_amount    = p_final_amount
    WHERE public.invoices.id = p_invoice_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Số hóa đơn này đã tồn tại cho nhà cung cấp đã chọn.' USING ERRCODE = 'HD003';
  END;

  RETURN QUERY SELECT p_invoice_id, p_invoice_no;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_invoice_from_receipts_header(
  uuid, text, date, text, numeric, text, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_invoice_from_receipts_header(
  uuid, text, date, text, numeric, text, numeric, numeric, numeric, numeric, numeric
) TO service_role;


-- ------------------------------------------------------------
-- 9. update_invoice (manual edit, 00024): refuse from_receipts invoices.
-- Body otherwise identical to 00024 — the manual flow is unchanged.
-- ------------------------------------------------------------
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

  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE public.invoices.id = p_invoice_id AND public.invoices.source_type = 'from_receipts'
  ) THEN
    RAISE EXCEPTION 'Hóa đơn tạo từ hàng đã nhận không thể sửa danh sách hàng.' USING ERRCODE = 'HD009';
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


-- ------------------------------------------------------------
-- 10. /receipts daily history: + linked invoice per daily group.
--
-- (supplier_id, receipt_date) is UNIQUE in invoice_receipt_days, so the
-- LEFT JOIN matches at most one row per receipt_item — the SUMs are
-- unaffected. Return type changes, so DROP + CREATE.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_receipt_daily_groups(date, date, uuid, text, text, integer, integer);

CREATE FUNCTION public.get_receipt_daily_groups(
  p_from_date     date DEFAULT NULL,
  p_to_date       date DEFAULT NULL,
  p_supplier_id   uuid DEFAULT NULL,
  p_sku           text DEFAULT NULL,
  p_product_name  text DEFAULT NULL,
  p_limit         integer DEFAULT 10,
  p_offset        integer DEFAULT 0
)
RETURNS TABLE (
  receipt_date         date,
  supplier_id          uuid,
  supplier_code        text,
  supplier_name        text,
  sku_count            bigint,
  total_delivered_qty  numeric,
  total_received_qty   numeric,
  total_difference_qty numeric,
  total_line_total     numeric,
  linked_invoice_id    uuid,
  linked_invoice_no    text,
  total_groups         bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    r.receipt_date,
    r.supplier_id,
    s.code,
    s.name,
    COUNT(DISTINCT ri.product_id),
    COALESCE(SUM(ri.delivered_qty), 0),
    COALESCE(SUM(ri.received_qty), 0),
    COALESCE(SUM(ri.difference_qty), 0),
    COALESCE(SUM(ri.line_total), 0),
    d.invoice_id,
    i.invoice_no,
    COUNT(*) OVER()
  FROM public.receipts r
  JOIN public.receipt_items ri ON ri.receipt_id = r.id
  JOIN public.suppliers s      ON s.id = r.supplier_id
  JOIN public.products p       ON p.id = ri.product_id
  LEFT JOIN public.invoice_receipt_days d
    ON d.supplier_id = r.supplier_id AND d.receipt_date = r.receipt_date
  LEFT JOIN public.invoices i  ON i.id = d.invoice_id
  WHERE (p_from_date    IS NULL OR r.receipt_date >= p_from_date)
    AND (p_to_date      IS NULL OR r.receipt_date <= p_to_date)
    AND (p_supplier_id  IS NULL OR r.supplier_id = p_supplier_id)
    AND (p_sku          IS NULL OR p.sku  ILIKE '%' || p_sku || '%')
    AND (p_product_name IS NULL OR p.name ILIKE '%' || p_product_name || '%')
  GROUP BY r.receipt_date, r.supplier_id, s.code, s.name, d.invoice_id, i.invoice_no
  ORDER BY r.receipt_date DESC, s.code ASC
  LIMIT p_limit OFFSET p_offset;
$$;

REVOKE EXECUTE ON FUNCTION public.get_receipt_daily_groups(date, date, uuid, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_receipt_daily_groups(date, date, uuid, text, text, integer, integer) TO service_role;


-- ------------------------------------------------------------
-- 11. v_outstanding: received_qty branches on source_type; new 'complete'
-- status. Everything else (financial allocation from 00027) is unchanged.
--
--   manual         -> 00014 rule, untouched: same supplier + product_id,
--                     receipt_date >= invoice_date (known double-count
--                     caveat across overlapping invoices still applies).
--   from_receipts  -> only receipts on this invoice's linked days
--                     (invoice_receipt_days), same product_id AND same
--                     unit_price. No date range at all.
--
-- Status (qty thresholds unchanged, 0 split out of "low"):
--   remaining <  0        -> need_makeup  (Cần xuất bù)
--   remaining =  0        -> complete     (Đã đủ)
--   0 < remaining < 15    -> low          (Sắp hết)
--   remaining >= 15       -> normal       (Bình thường)
-- source_type is appended as the last column (CREATE OR REPLACE VIEW can
-- only add columns at the end).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_outstanding AS
WITH item_base AS (
  SELECT
    ii.id                           AS invoice_item_id,
    ii.invoice_id,
    ii.product_id,
    ii.quantity                     AS invoice_qty,
    ii.unit_price,
    ii.line_total,
    ii.created_at,
    i.invoice_no,
    i.invoice_date,
    i.supplier_id,
    i.subtotal,
    i.final_amount,
    i.source_type,
    CASE
      WHEN i.source_type = 'from_receipts' THEN COALESCE(recv_linked.received_qty, 0)
      ELSE COALESCE(recv_manual.received_qty, 0)
    END                             AS received_qty
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  LEFT JOIN LATERAL (
    SELECT SUM(ri.received_qty) AS received_qty
    FROM public.receipt_items ri
    JOIN public.receipts r ON r.id = ri.receipt_id
    WHERE i.source_type = 'manual'
      AND ri.product_id = ii.product_id
      AND r.supplier_id = i.supplier_id
      AND r.receipt_date >= i.invoice_date
  ) recv_manual ON true
  LEFT JOIN LATERAL (
    SELECT SUM(ri.received_qty) AS received_qty
    FROM public.invoice_receipt_days d
    JOIN public.receipts r
      ON r.supplier_id = d.supplier_id AND r.receipt_date = d.receipt_date
    JOIN public.receipt_items ri ON ri.receipt_id = r.id
    WHERE i.source_type = 'from_receipts'
      AND d.invoice_id = i.id
      AND ri.product_id = ii.product_id
      AND ri.unit_price = ii.unit_price
  ) recv_linked ON true
),
adjusted AS (
  SELECT
    b.*,
    ROUND(b.line_total * (CASE WHEN b.subtotal = 0 THEN 1 ELSE b.final_amount / b.subtotal END), 2)
      + CASE
          WHEN ROW_NUMBER() OVER (PARTITION BY b.invoice_id ORDER BY b.created_at DESC, b.invoice_item_id DESC) = 1
          THEN b.final_amount - SUM(
                 ROUND(b.line_total * (CASE WHEN b.subtotal = 0 THEN 1 ELSE b.final_amount / b.subtotal END), 2)
               ) OVER (PARTITION BY b.invoice_id)
          ELSE 0
        END AS invoice_value
  FROM item_base b
)
SELECT
  a.invoice_item_id,
  a.invoice_id,
  a.invoice_no,
  a.invoice_date,
  a.supplier_id,
  s.code                                AS supplier_code,
  s.name                                 AS supplier_name,
  a.product_id,
  p.sku,
  p.name                                  AS product_name,
  p.unit,
  a.invoice_qty,
  a.unit_price,
  a.received_qty,
  a.invoice_qty - a.received_qty          AS remaining_qty,
  a.invoice_value,
  ROUND(a.invoice_value * CASE WHEN a.invoice_qty <= 0 THEN 0 ELSE a.received_qty / a.invoice_qty END, 2)
                                           AS received_value,
  a.invoice_value
    - ROUND(a.invoice_value * CASE WHEN a.invoice_qty <= 0 THEN 0 ELSE a.received_qty / a.invoice_qty END, 2)
                                           AS remaining_value,
  CASE
    WHEN a.invoice_qty - a.received_qty < 0  THEN 'need_makeup'
    WHEN a.invoice_qty - a.received_qty = 0  THEN 'complete'
    WHEN a.invoice_qty - a.received_qty < 15 THEN 'low'
    ELSE 'normal'
  END                                      AS status,
  a.source_type
FROM adjusted a
JOIN public.suppliers s ON s.id = a.supplier_id
JOIN public.products  p ON p.id = a.product_id;


-- Drill-down: same branching as the view's two LATERALs, so the listed
-- receipts always add up to v_outstanding.received_qty.
CREATE OR REPLACE FUNCTION public.get_outstanding_contributing_receipts(p_invoice_item_id uuid)
RETURNS TABLE (
  receipt_id     uuid,
  receipt_no     text,
  receipt_date   date,
  shift          text,
  received_qty   numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.id, r.receipt_no, r.receipt_date, r.shift, ri.received_qty
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  JOIN public.receipt_items ri ON ri.product_id = ii.product_id
  JOIN public.receipts r ON r.id = ri.receipt_id
    AND r.supplier_id = i.supplier_id
  WHERE ii.id = p_invoice_item_id
    AND (
      (i.source_type = 'manual' AND r.receipt_date >= i.invoice_date)
      OR (
        i.source_type = 'from_receipts'
        AND ri.unit_price = ii.unit_price
        AND EXISTS (
          SELECT 1 FROM public.invoice_receipt_days d
          WHERE d.invoice_id = i.id AND d.receipt_date = r.receipt_date
        )
      )
    )
  ORDER BY r.receipt_date ASC, r.created_at ASC;
$$;


-- Dashboard "HĐ đang theo dõi": 'complete' items are done, not watched.
-- Previously `status <> 'normal'` (then only low/need_makeup existed).
CREATE OR REPLACE FUNCTION public.get_dashboard_outstanding_summary(
  p_from_date date,
  p_to_date date,
  p_supplier_id uuid
)
RETURNS TABLE (
  watching_invoice_count bigint,
  low_sku_count          bigint,
  need_makeup_sku_count  bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(DISTINCT invoice_id) FILTER (WHERE status IN ('low', 'need_makeup')) AS watching_invoice_count,
    COUNT(*) FILTER (WHERE status = 'low')                                     AS low_sku_count,
    COUNT(*) FILTER (WHERE status = 'need_makeup')                             AS need_makeup_sku_count
  FROM public.v_outstanding
  WHERE invoice_date BETWEEN p_from_date AND p_to_date
    AND (p_supplier_id IS NULL OR supplier_id = p_supplier_id);
$$;


-- ------------------------------------------------------------
-- 12. v_invoice_summary (/invoices list): + source_type, receipt_start_date
-- appended at the end.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_invoice_summary AS
SELECT
  i.id,
  i.invoice_no,
  i.invoice_date,
  i.supplier_id,
  s.code AS supplier_code,
  s.name AS supplier_name,
  i.note,
  i.created_at,
  -- DISTINCT: a from_receipts invoice can hold one SKU on several price
  -- lines; "Số SKU" should still count it once. Same result as before for
  -- manual invoices (one line per SKU).
  COUNT(DISTINCT ii.product_id)   AS sku_count,
  COALESCE(SUM(ii.quantity), 0)   AS total_quantity,
  i.subtotal,
  i.discount_type,
  i.discount_value,
  i.discount_amount,
  i.vat_rate,
  i.vat_amount,
  i.final_amount,
  i.final_amount                  AS total_amount,
  i.source_type,
  i.receipt_start_date
FROM public.invoices i
JOIN public.suppliers s      ON s.id = i.supplier_id
LEFT JOIN public.invoice_items ii ON ii.invoice_id = i.id
GROUP BY i.id, i.invoice_no, i.invoice_date, i.supplier_id, s.code, s.name, i.note, i.created_at,
         i.subtotal, i.discount_type, i.discount_value, i.discount_amount, i.vat_rate, i.vat_amount,
         i.final_amount, i.source_type, i.receipt_start_date;
