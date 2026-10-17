-- ============================================================
-- PATCH PROVISIONAL VAT COST ("Giá tạm"):
-- a company receipt that is NOT linked to an invoice yet is costed with a
-- DEFAULT VAT rate (cost_settings.default_vat_rate, 8 %) and labelled
-- "Tạm tính"; when the invoice arrives the cost corrects itself to the
-- invoice's real VAT — including the COGS of orders sold at the
-- provisional cost.
--
-- Replaces the 00052 rule "company without invoice → cost unknown
-- (vat_pending)". vat_pending stays a valid value (legacy rows / no default
-- rate configured) but is no longer produced while a default rate exists.
--
--   household supplier                 unit_cost = unit_price                        raw
--   company + day linked to invoice    unit_cost = unit_price × (1 + invoice VAT)    invoice_vat
--     (invoice with NULL vat_rate counts as "no VAT yet" → provisional)
--   company, no invoice VAT yet        unit_cost = unit_price × (1 + default VAT)    provisional_vat
--
-- Provisional propagation (cost_replay_product):
--   the moving average is "provisional" while the position holds units that
--   came in at a provisional cost (reset when the position restarts from
--   ≤ 0); a sale_out posted then carries metadata.cost_provisional and its
--   order line snapshot gets channel_order_items.cost_provisional = true.
--
-- Truing up (cost_true_up_provisional_sales, run by every product rebuild —
-- invoice link / VAT edit / receipt edit / supplier type / default rate):
--   provisional, not-reversed lines are moved to the CURRENT reconstruction
--   and keep cost_provisional while their cost is still provisional; each
--   value change writes a cogs_restatements row (source
--   'provisional_true_up'). FINAL (non-provisional) snapshots are never
--   touched automatically — explicit restatement stays the only path.
--   Known limit: a cancelled order's reversal keeps the provisional cost it
--   was reversed at (the reversal is part of history).
--
-- SCHEMA / FUNCTIONS ONLY — existing ledgers switch to provisional cost when
-- a product is rebuilt (invoice / receipt triggers, or admin "Dựng lại sổ
-- giá vốn" → cost_rebuild_all).
-- Version: moving-average-v3-provisional-vat.
-- ============================================================


-- ============================================================
-- A. Settings: default VAT for provisional cost
-- ============================================================
CREATE TABLE public.cost_settings (
  id                boolean      PRIMARY KEY DEFAULT true CHECK (id),
  default_vat_rate  numeric(5,2) CHECK (default_vat_rate IS NULL OR (default_vat_rate >= 0 AND default_vat_rate <= 100)),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  updated_by        uuid         REFERENCES public.profiles(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.cost_settings IS 'Single row. default_vat_rate = VAT % used for company receipts without an invoice (provisional cost). NULL = no provisional cost (cost unknown until the invoice).';
INSERT INTO public.cost_settings (id, default_vat_rate) VALUES (true, 8);

ALTER TABLE public.cost_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_settings FROM anon, authenticated;
GRANT SELECT ON public.cost_settings TO authenticated;
GRANT SELECT, UPDATE ON public.cost_settings TO service_role;
CREATE POLICY active_users_select ON public.cost_settings FOR SELECT TO authenticated USING (public.is_active_user());

CREATE OR REPLACE FUNCTION public.cost_default_vat_rate() RETURNS numeric
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT default_vat_rate FROM public.cost_settings WHERE id
$$;

CREATE OR REPLACE FUNCTION public.cost_costing_version() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'moving-average-v3-provisional-vat'::text $$;


-- ============================================================
-- B. Columns / constraints
-- ============================================================
ALTER TABLE public.inventory_cost_ledger DROP CONSTRAINT inventory_cost_ledger_cost_basis_check;
ALTER TABLE public.inventory_cost_ledger ADD CONSTRAINT inventory_cost_ledger_cost_basis_check CHECK (
  cost_basis IS NULL OR cost_basis IN ('raw', 'invoice_vat', 'provisional_vat', 'vat_pending')
);
COMMENT ON COLUMN public.inventory_cost_ledger.cost_basis IS
  'purchase_in only: raw = receipt price (household) · invoice_vat = price × (1 + invoice VAT) · provisional_vat = price × (1 + default VAT), company receipt without invoice VAT ("Tạm tính") · vat_pending = no invoice and no default rate (cost unknown). NULL = posted before moving-average-v2-vat.';

ALTER TABLE public.product_cost_state
  -- the current moving average includes provisional (default-VAT) units
  ADD COLUMN cost_provisional boolean NOT NULL DEFAULT false;

ALTER TABLE public.channel_order_items
  -- snapshot taken from a provisional average → trued up automatically when the invoice arrives
  ADD COLUMN cost_provisional boolean NOT NULL DEFAULT false;

ALTER TABLE public.cogs_restatements
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'provisional_true_up'));


-- ============================================================
-- C. Purchases with the provisional rule
-- ============================================================
CREATE OR REPLACE FUNCTION public.cost_sync_purchases(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_count integer;
  v_def   numeric := public.cost_default_vat_rate();
BEGIN
  DELETE FROM public.inventory_cost_ledger l
  WHERE l.product_id = p_product_id
    AND l.event_type = 'purchase_in'
    AND NOT EXISTS (
      SELECT 1 FROM public.receipt_items ri
      WHERE ri.id = l.source_id AND ri.product_id = p_product_id AND ri.received_qty > 0
    );

  INSERT INTO public.inventory_cost_ledger
    (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change,
     unit_cost, base_unit_cost, vat_rate, cost_basis, invoice_id)
  SELECT
    p_product_id, 'purchase_in', 'receipt_item', ri.id, r.receipt_no,
    (r.receipt_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'),
    '1|' || to_char(r.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') || '|' ||
      to_char(ri.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') || '|' || ri.id::text,
    ri.received_qty,
    CASE
      WHEN COALESCE(s.supplier_type, 'business_household') <> 'company' THEN ri.unit_price
      WHEN inv.vat_rate IS NOT NULL THEN public.cost_round_cost(ri.unit_price * (1 + inv.vat_rate / 100))
      WHEN v_def IS NOT NULL THEN public.cost_round_cost(ri.unit_price * (1 + v_def / 100))
      ELSE NULL
    END,
    ri.unit_price,
    CASE
      WHEN COALESCE(s.supplier_type, 'business_household') <> 'company' THEN NULL
      ELSE COALESCE(inv.vat_rate, v_def)
    END,
    CASE
      WHEN COALESCE(s.supplier_type, 'business_household') <> 'company' THEN 'raw'
      WHEN inv.vat_rate IS NOT NULL THEN 'invoice_vat'
      WHEN v_def IS NOT NULL THEN 'provisional_vat'
      ELSE 'vat_pending'
    END,
    CASE WHEN s.supplier_type = 'company' THEN inv.id END
  FROM public.receipt_items ri
  JOIN public.receipts r ON r.id = ri.receipt_id
  LEFT JOIN public.suppliers s ON s.id = r.supplier_id
  LEFT JOIN public.invoice_receipt_days d ON d.supplier_id = r.supplier_id AND d.receipt_date = r.receipt_date
  LEFT JOIN public.invoices inv ON inv.id = d.invoice_id
  WHERE ri.product_id = p_product_id AND ri.received_qty > 0
  ON CONFLICT (source_type, source_id, event_type) WHERE source_id IS NOT NULL
  DO UPDATE SET
    product_id = EXCLUDED.product_id,
    source_external_id = EXCLUDED.source_external_id,
    event_time = EXCLUDED.event_time,
    order_key = EXCLUDED.order_key,
    quantity_change = EXCLUDED.quantity_change,
    unit_cost = EXCLUDED.unit_cost,
    base_unit_cost = EXCLUDED.base_unit_cost,
    vat_rate = EXCLUDED.vat_rate,
    cost_basis = EXCLUDED.cost_basis,
    invoice_id = EXCLUDED.invoice_id;

  SELECT count(*) INTO v_count FROM public.inventory_cost_ledger WHERE product_id = p_product_id AND event_type = 'purchase_in';
  RETURN v_count;
END;
$$;

-- Replay (00052) + provisional flag (see header).
CREATE OR REPLACE FUNCTION public.cost_replay_product(p_product_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r       record;
  v_q     numeric := 0;
  v_avg   numeric := NULL;
  v_pend  boolean := false;
  v_prov  boolean := false;
  v_inp   boolean;
  v_new_q numeric;
  v_new_a numeric;
  v_mv    numeric;
  v_last  uuid;
  v_lastt timestamptz;
BEGIN
  FOR r IN
    SELECT id, quantity_change, unit_cost, event_time, metadata, cost_basis
    FROM public.inventory_cost_ledger
    WHERE product_id = p_product_id
    ORDER BY event_time, order_key, id
  LOOP
    v_new_q := public.cost_round_qty(v_q + r.quantity_change);
    IF r.quantity_change > 0 THEN
      v_inp := r.cost_basis IS NOT DISTINCT FROM 'provisional_vat';
      IF r.unit_cost IS NULL THEN
        v_new_a := NULL;
        v_pend := true;
        v_mv := NULL;
      ELSIF v_q <= 0 OR (v_avg IS NULL AND NOT v_pend) THEN
        v_new_a := public.cost_round_cost(r.unit_cost);
        v_pend := false;
        v_prov := v_inp;
        v_mv := public.cost_round_money(r.quantity_change * r.unit_cost);
      ELSIF v_pend THEN
        v_new_a := NULL;
        v_prov := v_prov OR v_inp;
        v_mv := public.cost_round_money(r.quantity_change * r.unit_cost);
      ELSE
        v_new_a := public.cost_round_cost((v_q * v_avg + r.quantity_change * r.unit_cost) / v_new_q);
        v_prov := v_prov OR v_inp;
        v_mv := public.cost_round_money(r.quantity_change * r.unit_cost);
      END IF;
      UPDATE public.inventory_cost_ledger
      SET qty_before = v_q, qty_after = v_new_q, avg_cost_before = v_avg, avg_cost_after = v_new_a, movement_cost = v_mv
      WHERE id = r.id
        AND (qty_before, qty_after, avg_cost_before, avg_cost_after, movement_cost)
            IS DISTINCT FROM (v_q, v_new_q, v_avg, v_new_a, v_mv);
      v_avg := v_new_a;
    ELSE
      v_mv := CASE WHEN v_avg IS NULL THEN NULL ELSE public.cost_round_money(-r.quantity_change * v_avg) END;
      UPDATE public.inventory_cost_ledger
      SET qty_before = v_q, qty_after = v_new_q, avg_cost_before = v_avg, avg_cost_after = v_avg,
          unit_cost = v_avg, movement_cost = v_mv,
          metadata = COALESCE(r.metadata, '{}'::jsonb)
                     || jsonb_build_object('negative_inventory', v_new_q < 0, 'cost_pending', v_pend, 'cost_provisional', v_avg IS NOT NULL AND v_prov)
      WHERE id = r.id;
    END IF;
    v_q := v_new_q;
    v_last := r.id;
    v_lastt := r.event_time;
  END LOOP;

  UPDATE public.product_cost_state
  SET quantity_on_hand = v_q,
      moving_average_cost = v_avg,
      inventory_value = CASE WHEN v_avg IS NULL THEN 0 ELSE public.cost_round_money(v_q * v_avg) END,
      vat_pending = v_pend,
      cost_provisional = v_avg IS NOT NULL AND v_prov,
      last_ledger_event_id = v_last,
      last_event_time = v_lastt,
      needs_rebuild = false,
      last_error = NULL,
      updated_at = now()
  WHERE product_id = p_product_id;
END;
$$;


-- ============================================================
-- D. Sale snapshots carry the provisional flag
-- ============================================================
CREATE OR REPLACE FUNCTION public.cost_apply_order_item(p_order_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v        record;
  v_led    record;
  v_new    uuid;
  v_avg    numeric;
  v_after  numeric;
  v_meta   jsonb;
BEGIN
  SELECT oi.id, oi.internal_product_id, oi.quantity, oi.total_cogs, oi.provider_line_key, oi.cogs_reversed_at,
         o.order_status, o.external_order_sn, COALESCE(o.paid_at_channel, o.created_at_channel, now()) AS cost_time
  INTO v
  FROM public.channel_order_items oi
  JOIN public.channel_orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id
  FOR UPDATE OF oi;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.total_cogs IS NOT NULL THEN RETURN 'already'; END IF;

  SELECT l.id, l.product_id, l.avg_cost_before, l.metadata INTO v_led
  FROM public.inventory_cost_ledger l
  WHERE l.source_type = 'channel_order_item' AND l.source_id = v.id AND l.event_type = 'sale_out';
  IF FOUND THEN
    IF v.cogs_reversed_at IS NOT NULL THEN RETURN 'already'; END IF;
    IF v_led.product_id IS NOT DISTINCT FROM v.internal_product_id THEN
      IF v_led.avg_cost_before IS NULL THEN RETURN 'cost_pending'; END IF;
      UPDATE public.channel_order_items
      SET cost_method = 'moving_average',
          cost_per_unit_snapshot = v_led.avg_cost_before,
          total_cogs = public.cost_round_money(v.quantity * v_led.avg_cost_before),
          cogs_calculated_at = now(),
          cost_version = public.cost_costing_version(),
          cost_provisional = COALESCE((v_led.metadata ->> 'cost_provisional')::boolean, false)
      WHERE id = v.id;
      RETURN 'calculated_late';
    END IF;
    -- Pending sale of a line re-mapped to another product: withdraw it.
    PERFORM public.cost_lock_state(v_led.product_id);
    DELETE FROM public.inventory_cost_ledger WHERE id = v_led.id;
    PERFORM public.cost_replay_product(v_led.product_id);
  END IF;

  IF v.internal_product_id IS NULL THEN RETURN 'unmapped'; END IF;
  IF NOT public.cost_order_status_eligible(v.order_status) THEN RETURN 'ineligible'; END IF;

  PERFORM public.cost_lock_state(v.internal_product_id);
  INSERT INTO public.inventory_cost_ledger
    (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change)
  VALUES
    (v.internal_product_id, 'sale_out', 'channel_order_item', v.id, v.external_order_sn, v.cost_time,
     '2|' || v.external_order_sn || '|' || COALESCE(v.provider_line_key, v.id::text), -v.quantity)
  RETURNING id INTO v_new;
  PERFORM public.cost_replay_product(v.internal_product_id);

  SELECT avg_cost_before, qty_after, metadata INTO v_avg, v_after, v_meta FROM public.inventory_cost_ledger WHERE id = v_new;
  IF v_avg IS NULL THEN
    IF COALESCE((v_meta ->> 'cost_pending')::boolean, false) THEN
      RETURN 'cost_pending';
    END IF;
    -- No known cost at this moment: post nothing, never a fake cost.
    DELETE FROM public.inventory_cost_ledger WHERE id = v_new;
    PERFORM public.cost_replay_product(v.internal_product_id);
    RETURN 'no_cost';
  END IF;

  UPDATE public.channel_order_items
  SET cost_method = 'moving_average',
      cost_per_unit_snapshot = v_avg,
      total_cogs = public.cost_round_money(v.quantity * v_avg),
      cogs_calculated_at = now(),
      cost_version = public.cost_costing_version(),
      cost_provisional = COALESCE((v_meta ->> 'cost_provisional')::boolean, false)
  WHERE id = v.id;
  RETURN CASE WHEN v_after < 0 THEN 'calculated_negative' ELSE 'calculated' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_fill_pending_sales(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r       record;
  v_n     integer := 0;
  v_order uuid;
  v_orders uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR r IN
    SELECT oi.id, oi.order_id, oi.quantity, l.avg_cost_before, COALESCE((l.metadata ->> 'cost_provisional')::boolean, false) AS prov
    FROM public.inventory_cost_ledger l
    JOIN public.channel_order_items oi ON oi.id = l.source_id
    JOIN public.channel_orders o ON o.id = oi.order_id
    WHERE l.product_id = p_product_id
      AND l.source_type = 'channel_order_item' AND l.event_type = 'sale_out'
      AND l.avg_cost_before IS NOT NULL
      AND oi.total_cogs IS NULL AND oi.cogs_reversed_at IS NULL
      AND oi.internal_product_id = p_product_id
      AND public.cost_order_status_eligible(o.order_status)
    ORDER BY oi.id
    FOR UPDATE OF oi
  LOOP
    UPDATE public.channel_order_items
    SET cost_method = 'moving_average',
        cost_per_unit_snapshot = r.avg_cost_before,
        total_cogs = public.cost_round_money(r.quantity * r.avg_cost_before),
        cogs_calculated_at = now(),
        cost_version = public.cost_costing_version(),
        cost_provisional = r.prov
    WHERE id = r.id;
    v_n := v_n + 1;
    IF NOT r.order_id = ANY (v_orders) THEN v_orders := v_orders || r.order_id; END IF;
  END LOOP;
  FOREACH v_order IN ARRAY v_orders LOOP
    PERFORM public.cost_refresh_order_cogs(v_order);
  END LOOP;
  RETURN v_n;
END;
$$;

-- Provisional order lines follow the current reconstruction until their
-- cost is final (invoice VAT). Audited per value change.
CREATE OR REPLACE FUNCTION public.cost_true_up_provisional_sales(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r        record;
  v_total  numeric;
  v_n      integer := 0;
  v_batch  uuid := gen_random_uuid();
  v_order  uuid;
  v_orders uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM set_config('app.cogs_restatement', 'on', true);
  FOR r IN
    SELECT oi.id, oi.order_id, oi.quantity, oi.cost_per_unit_snapshot, oi.total_cogs, oi.cost_version,
           l.avg_cost_before, COALESCE((l.metadata ->> 'cost_provisional')::boolean, false) AS still_prov
    FROM public.inventory_cost_ledger l
    JOIN public.channel_order_items oi ON oi.id = l.source_id
    WHERE l.product_id = p_product_id
      AND l.source_type = 'channel_order_item' AND l.event_type = 'sale_out'
      AND oi.cost_provisional
      AND oi.cost_per_unit_snapshot IS NOT NULL
      AND oi.cogs_reversed_at IS NULL
      AND oi.internal_product_id = p_product_id
      AND l.avg_cost_before IS NOT NULL
    ORDER BY oi.id
    FOR UPDATE OF oi
  LOOP
    IF r.avg_cost_before = r.cost_per_unit_snapshot AND r.still_prov THEN
      CONTINUE;
    END IF;
    v_total := public.cost_round_money(r.quantity * r.avg_cost_before);
    UPDATE public.channel_order_items
    SET cost_per_unit_snapshot = r.avg_cost_before,
        total_cogs = v_total,
        cogs_calculated_at = now(),
        cost_version = public.cost_costing_version(),
        cost_provisional = r.still_prov
    WHERE id = r.id;
    IF r.avg_cost_before IS DISTINCT FROM r.cost_per_unit_snapshot THEN
      INSERT INTO public.cogs_restatements
        (batch_id, order_id, order_item_id, product_id, old_cost_per_unit, new_cost_per_unit, old_total_cogs, new_total_cogs,
         old_cost_version, new_cost_version, reason, adjusted_by, source)
      VALUES
        (v_batch, r.order_id, r.id, p_product_id, r.cost_per_unit_snapshot, r.avg_cost_before, r.total_cogs, v_total,
         r.cost_version, public.cost_costing_version(),
         CASE WHEN r.still_prov THEN 'Tự động: cập nhật giá vốn tạm tính' ELSE 'Tự động: giá vốn tạm tính → VAT hóa đơn' END,
         NULL, 'provisional_true_up');
    END IF;
    v_n := v_n + 1;
    IF NOT r.order_id = ANY (v_orders) THEN v_orders := v_orders || r.order_id; END IF;
  END LOOP;
  PERFORM set_config('app.cogs_restatement', 'off', true);
  FOREACH v_order IN ARRAY v_orders LOOP
    PERFORM public.cost_refresh_order_cogs(v_order);
  END LOOP;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_rebuild_product(p_product_id uuid, p_reason text, p_triggered_by uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_purch  integer;
  v_total  integer;
BEGIN
  PERFORM public.cost_lock_state(p_product_id);
  SELECT to_jsonb(s) - 'updated_at' INTO v_before FROM public.product_cost_state s WHERE s.product_id = p_product_id;
  v_purch := public.cost_sync_purchases(p_product_id);
  PERFORM public.cost_replay_product(p_product_id);
  PERFORM public.cost_fill_pending_sales(p_product_id);
  PERFORM public.cost_true_up_provisional_sales(p_product_id);
  SELECT count(*) INTO v_total FROM public.inventory_cost_ledger WHERE product_id = p_product_id;
  SELECT to_jsonb(s) - 'updated_at' INTO v_after FROM public.product_cost_state s WHERE s.product_id = p_product_id;
  INSERT INTO public.inventory_cost_rebuilds (product_id, reason, triggered_by, purchase_events, total_events, state_before, state_after)
  VALUES (p_product_id, p_reason, p_triggered_by, v_purch, v_total, v_before, v_after);
  RETURN v_after;
END;
$$;

-- Default VAT changed → rebuild the products that have provisional purchases.
CREATE OR REPLACE FUNCTION public.cost_on_default_vat_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p uuid;
BEGIN
  FOR p IN
    SELECT DISTINCT ri.product_id FROM public.receipt_items ri
    JOIN public.receipts r ON r.id = ri.receipt_id
    JOIN public.suppliers s ON s.id = r.supplier_id AND s.supplier_type = 'company'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.invoice_receipt_days d JOIN public.invoices i ON i.id = d.invoice_id
      WHERE d.supplier_id = r.supplier_id AND d.receipt_date = r.receipt_date AND i.vat_rate IS NOT NULL
    )
    ORDER BY 1
  LOOP PERFORM public.cost_rebuild_product_safe(p, 'default_vat_change'); END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cost_default_vat_change AFTER UPDATE OF default_vat_rate ON public.cost_settings
  FOR EACH ROW WHEN (OLD.default_vat_rate IS DISTINCT FROM NEW.default_vat_rate) EXECUTE FUNCTION public.cost_on_default_vat_change();


-- ============================================================
-- E. Snapshot guard + manual restatement leave provisional lines alone
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_order_item_cogs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.cost_per_unit_snapshot IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.channel_orders WHERE id = OLD.order_id) THEN
      RAISE EXCEPTION 'Dòng đơn đã có giá vốn snapshot — không được xóa.' USING ERRCODE = 'CG002';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.cost_per_unit_snapshot IS NOT NULL
     AND COALESCE(current_setting('app.cogs_restatement', true), '') <> 'on'
     AND (
          NEW.internal_product_id IS DISTINCT FROM OLD.internal_product_id
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.cost_method IS DISTINCT FROM OLD.cost_method
       OR NEW.cost_per_unit_snapshot IS DISTINCT FROM OLD.cost_per_unit_snapshot
       OR NEW.total_cogs IS DISTINCT FROM OLD.total_cogs
       OR NEW.cogs_calculated_at IS DISTINCT FROM OLD.cogs_calculated_at
       OR NEW.cost_version IS DISTINCT FROM OLD.cost_version
       OR NEW.cost_provisional IS DISTINCT FROM OLD.cost_provisional
     ) THEN
    RAISE EXCEPTION 'Giá vốn của dòng đơn đã được chốt — không được thay đổi.' USING ERRCODE = 'CG001';
  END IF;
  RETURN NEW;
END;
$$;

-- 00052 candidates, minus provisional lines (they true up automatically).
CREATE OR REPLACE FUNCTION public.cost_restatement_candidates(p_limit integer DEFAULT 500)
RETURNS TABLE (
  order_item_id      uuid,
  order_id           uuid,
  external_order_sn  text,
  order_status       text,
  created_at_channel timestamptz,
  product_id         uuid,
  sku                text,
  product_name       text,
  quantity           text,
  old_cost_per_unit  text,
  new_cost_per_unit  text,
  old_total_cogs     text,
  new_total_cogs     text,
  difference         text,
  old_cost_version   text,
  restatable         boolean
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT oi.id, oi.order_id, o.external_order_sn, o.order_status, o.created_at_channel, l.product_id, p.sku, p.name,
         oi.quantity::text,
         oi.cost_per_unit_snapshot::text,
         l.avg_cost_before::text,
         oi.total_cogs::text,
         public.cost_round_money(oi.quantity * l.avg_cost_before)::text,
         (public.cost_round_money(oi.quantity * l.avg_cost_before) - oi.total_cogs)::text,
         oi.cost_version,
         l.avg_cost_before IS NOT NULL
  FROM public.channel_order_items oi
  JOIN public.inventory_cost_ledger l
    ON l.source_type = 'channel_order_item' AND l.source_id = oi.id AND l.event_type = 'sale_out'
  JOIN public.channel_orders o ON o.id = oi.order_id
  LEFT JOIN public.products p ON p.id = l.product_id
  WHERE oi.cost_per_unit_snapshot IS NOT NULL
    AND oi.cogs_reversed_at IS NULL
    AND NOT oi.cost_provisional
    AND l.avg_cost_before IS DISTINCT FROM oi.cost_per_unit_snapshot
  ORDER BY o.created_at_channel DESC NULLS LAST, oi.id
  LIMIT GREATEST(p_limit, 0)
$$;

-- 00053 preview, minus provisional lines.
CREATE OR REPLACE FUNCTION public.cost_restatement_preview_product(p_product_id uuid)
RETURNS TABLE (
  order_item_id           uuid,
  order_id                uuid,
  external_order_sn       text,
  order_status            text,
  created_at_channel      timestamptz,
  quantity                text,
  old_cost_per_unit       text,
  new_cost_per_unit       text,
  old_total_cogs          text,
  new_total_cogs          text,
  difference              text,
  restatable              boolean,
  estimated_order_revenue text,
  order_internal_cogs     text,
  order_estimated_profit  text,
  new_order_internal_cogs    text,
  new_order_estimated_profit text
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH c AS (
    SELECT oi.id AS item_id, oi.order_id, o.external_order_sn, o.order_status, o.created_at_channel,
           oi.quantity, oi.cost_per_unit_snapshot, l.avg_cost_before, oi.total_cogs,
           public.cost_round_money(oi.quantity * l.avg_cost_before) AS new_total,
           f.estimated_order_revenue, f.internal_cogs, f.estimated_profit
    FROM public.inventory_cost_ledger l
    JOIN public.channel_order_items oi
      ON l.source_type = 'channel_order_item' AND l.source_id = oi.id AND l.event_type = 'sale_out'
    JOIN public.channel_orders o ON o.id = oi.order_id
    LEFT JOIN public.order_financials f ON f.order_id = o.id
    WHERE l.product_id = p_product_id
      AND oi.cost_per_unit_snapshot IS NOT NULL
      AND oi.cogs_reversed_at IS NULL
      AND NOT oi.cost_provisional
      AND l.avg_cost_before IS DISTINCT FROM oi.cost_per_unit_snapshot
  ), d AS (
    SELECT c.*,
           CASE WHEN bool_and(c.avg_cost_before IS NOT NULL) OVER w
                THEN sum(c.new_total - c.total_cogs) OVER w END AS order_diff
    FROM c
    WINDOW w AS (PARTITION BY c.order_id)
  )
  SELECT d.item_id, d.order_id, d.external_order_sn, d.order_status, d.created_at_channel,
         d.quantity::text,
         d.cost_per_unit_snapshot::text,
         d.avg_cost_before::text,
         d.total_cogs::text,
         d.new_total::text,
         (d.new_total - d.total_cogs)::text,
         d.avg_cost_before IS NOT NULL,
         d.estimated_order_revenue::text,
         d.internal_cogs::text,
         d.estimated_profit::text,
         (d.internal_cogs + d.order_diff)::text,
         (d.estimated_order_revenue - (d.internal_cogs + d.order_diff))::text
  FROM d
  ORDER BY d.created_at_channel DESC NULLS LAST, d.item_id
$$;

-- 00052 manual restatement, minus provisional lines.
CREATE OR REPLACE FUNCTION public.cost_restate_order_cogs(p_item_ids uuid[], p_reason text, p_by uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_batch  uuid := gen_random_uuid();
  r        record;
  v_p      uuid;
  v_n      integer := 0;
  v_total  numeric;
  v_old    numeric := 0;
  v_new    numeric := 0;
  v_order  uuid;
  v_orders uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Cần nhập lý do điều chỉnh giá vốn.' USING ERRCODE = 'CG003';
  END IF;
  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 THEN
    RETURN jsonb_build_object('batch_id', NULL, 'restated', 0, 'skipped', 0, 'orders', 0, 'old_total', '0', 'new_total', '0');
  END IF;

  FOR v_p IN
    SELECT DISTINCT l.product_id FROM public.inventory_cost_ledger l
    WHERE l.source_type = 'channel_order_item' AND l.event_type = 'sale_out' AND l.source_id = ANY (p_item_ids)
    ORDER BY 1
  LOOP
    PERFORM public.cost_lock_state(v_p);
  END LOOP;

  PERFORM set_config('app.cogs_restatement', 'on', true);
  FOR r IN
    SELECT oi.id, oi.order_id, oi.quantity, oi.cost_per_unit_snapshot, oi.total_cogs, oi.cost_version, l.product_id, l.avg_cost_before
    FROM public.channel_order_items oi
    JOIN public.inventory_cost_ledger l
      ON l.source_type = 'channel_order_item' AND l.source_id = oi.id AND l.event_type = 'sale_out'
    WHERE oi.id = ANY (p_item_ids)
      AND oi.cost_per_unit_snapshot IS NOT NULL
      AND oi.cogs_reversed_at IS NULL
      AND NOT oi.cost_provisional
      AND l.avg_cost_before IS NOT NULL
      AND l.avg_cost_before IS DISTINCT FROM oi.cost_per_unit_snapshot
    ORDER BY oi.id
    FOR UPDATE OF oi
  LOOP
    v_total := public.cost_round_money(r.quantity * r.avg_cost_before);
    UPDATE public.channel_order_items
    SET cost_per_unit_snapshot = r.avg_cost_before,
        total_cogs = v_total,
        cogs_calculated_at = now(),
        cost_version = public.cost_costing_version()
    WHERE id = r.id;
    INSERT INTO public.cogs_restatements
      (batch_id, order_id, order_item_id, product_id, old_cost_per_unit, new_cost_per_unit, old_total_cogs, new_total_cogs,
       old_cost_version, new_cost_version, reason, adjusted_by)
    VALUES
      (v_batch, r.order_id, r.id, r.product_id, r.cost_per_unit_snapshot, r.avg_cost_before, r.total_cogs, v_total,
       r.cost_version, public.cost_costing_version(), btrim(p_reason), p_by);
    v_n := v_n + 1;
    v_old := v_old + r.total_cogs;
    v_new := v_new + v_total;
    IF NOT r.order_id = ANY (v_orders) THEN v_orders := v_orders || r.order_id; END IF;
  END LOOP;
  PERFORM set_config('app.cogs_restatement', 'off', true);

  FOREACH v_order IN ARRAY v_orders LOOP
    PERFORM public.cost_refresh_order_cogs(v_order);
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id', CASE WHEN v_n > 0 THEN v_batch END,
    'restated', v_n,
    'skipped', cardinality(p_item_ids) - v_n,
    'orders', cardinality(v_orders),
    'old_total', v_old::text,
    'new_total', v_new::text
  );
END;
$$;


-- ============================================================
-- F. Read models (columns appended)
-- ============================================================
CREATE OR REPLACE VIEW public.v_product_cost_overview
WITH (security_invoker = true)
AS
SELECT
  p.id                                  AS product_id,
  p.sku,
  p.name,
  p.unit,
  p.is_active,
  s.quantity_on_hand::text              AS quantity_on_hand,
  s.moving_average_cost::text           AS moving_average_cost,
  s.inventory_value::text               AS inventory_value,
  s.last_event_time,
  COALESCE(s.needs_rebuild, false)      AS needs_rebuild,
  s.last_error,
  EXISTS (SELECT 1 FROM public.inventory_cost_ledger l WHERE l.product_id = p.id) AS has_history,
  COALESCE(s.quantity_on_hand < 0, false) AS negative_quantity,
  (s.product_id IS NOT NULL AND s.moving_average_cost IS NULL
     AND EXISTS (SELECT 1 FROM public.inventory_cost_ledger l WHERE l.product_id = p.id)) AS missing_cost,
  COALESCE(s.vat_pending, false)        AS vat_pending,
  COALESCE(s.cost_provisional, false)   AS cost_provisional
FROM public.products p
LEFT JOIN public.product_cost_state s ON s.product_id = p.id;

REVOKE ALL ON public.v_product_cost_overview FROM anon;
GRANT SELECT ON public.v_product_cost_overview TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_channel_order_summary
WITH (security_invoker = true)
AS
SELECT
  o.id                       AS order_id,
  o.shop_id,
  s.shop_name,
  s.data_source,
  o.external_order_sn,
  o.order_status,
  o.financial_status,
  o.currency,
  o.channel_total_amount::text AS channel_total_amount,
  o.created_at_channel,
  o.updated_at_channel,
  o.last_synced_at,
  COALESCE(i.line_count, 0)  AS line_count,
  COALESCE(i.mapped_lines, 0) AS mapped_lines,
  i.total_item_quantity::text AS total_item_quantity,
  CASE WHEN i.lines_missing_price = 0 THEN i.item_gross_value::text END     AS item_gross_value,
  CASE WHEN i.lines_missing_original = 0 THEN i.original_item_value::text END AS original_item_value,
  CASE
    WHEN COALESCE(i.line_count, 0) = 0 THEN 'no_items'
    WHEN i.mapped_lines = i.line_count THEN 'complete'
    WHEN i.mapped_lines = 0 THEN 'unmapped'
    ELSE 'partial'
  END AS mapping_readiness,
  CASE
    WHEN COALESCE(i.line_count, 0) > 0 AND i.costed_lines = i.line_count THEN 'complete'
    WHEN COALESCE(i.costed_lines, 0) > 0 THEN 'partial'
    ELSE 'incomplete'
  END AS cogs_readiness,
  (o.order_status = 'COMPLETED') AS financial_sync_eligible,
  COALESCE(i.costed_lines, 0) AS costed_lines,
  CASE WHEN COALESCE(i.line_count, 0) > 0 AND i.costed_lines = i.line_count THEN COALESCE(i.cogs_sum, 0)::text END AS total_cogs,
  i.cogs_sum::text AS partial_cogs_sum,
  COALESCE(i.reversed_lines, 0) AS reversed_lines,
  f.actual_shopee_income::text  AS shopee_net_income,
  f.internal_cogs::text         AS internal_cogs,
  f.profit_after_cogs::text     AS profit_after_cogs,
  f.reconciliation_status,
  f.settlement_variance::text   AS settlement_variance,
  f.escrow_synced_at,
  CASE
    WHEN f.actual_shopee_income IS NULL THEN 'missing'
    ELSE 'available'
  END AS settlement_state,
  CASE
    WHEN f.profit_after_cogs IS NULL THEN NULL
    WHEN f.profit_after_cogs > 0 THEN 'profit'
    WHEN f.profit_after_cogs < 0 THEN 'loss'
    ELSE 'break_even'
  END AS profit_state,
  (f.estimated_order_revenue - f.internal_cogs)::text AS estimated_profit,
  CASE
    WHEN f.estimated_order_revenue IS NULL OR f.internal_cogs IS NULL
      OR o.channel_total_amount IS NULL OR o.channel_total_amount <= 0 THEN NULL
    ELSE round((f.estimated_order_revenue - f.internal_cogs) / o.channel_total_amount * 100, 1)::text
  END AS estimated_margin_pct,
  CASE
    WHEN f.estimated_order_revenue IS NULL OR f.internal_cogs IS NULL THEN 'insufficient'
    WHEN f.estimated_order_revenue - f.internal_cogs < 0 THEN 'loss'
    ELSE 'profit'
  END AS estimated_profit_state,
  f.estimated_order_revenue::text AS estimated_order_revenue,
  f.estimated_revenue_source,
  f.estimated_revenue_synced_at,
  -- PATCH provisional VAT: at least one costed line uses a provisional (default-VAT) cost
  COALESCE(i.provisional_lines, 0) > 0 AS cogs_provisional
FROM public.channel_orders o
JOIN public.shops s ON s.id = o.shop_id
LEFT JOIN public.order_financials f ON f.order_id = o.id
CROSS JOIN LATERAL (
  SELECT
    count(*)                                                        AS line_count,
    count(*) FILTER (WHERE oi.internal_product_id IS NOT NULL)      AS mapped_lines,
    count(*) FILTER (WHERE oi.total_cogs IS NOT NULL)               AS costed_lines,
    count(*) FILTER (WHERE oi.discounted_unit_price IS NULL)        AS lines_missing_price,
    count(*) FILTER (WHERE oi.original_unit_price IS NULL)          AS lines_missing_original,
    sum(oi.quantity)                                                AS total_item_quantity,
    sum(oi.discounted_unit_price * oi.quantity)                     AS item_gross_value,
    sum(oi.original_unit_price * oi.quantity)                       AS original_item_value,
    sum(oi.total_cogs) FILTER (WHERE oi.cogs_reversed_at IS NULL)   AS cogs_sum,
    count(*) FILTER (WHERE oi.cogs_reversed_at IS NOT NULL)         AS reversed_lines,
    count(*) FILTER (WHERE oi.cost_provisional AND oi.total_cogs IS NOT NULL AND oi.cogs_reversed_at IS NULL) AS provisional_lines
  FROM public.channel_order_items oi
  WHERE oi.order_id = o.id
) i;

REVOKE ALL ON public.v_channel_order_summary FROM anon;
GRANT SELECT ON public.v_channel_order_summary TO authenticated, service_role;


-- ============================================================
-- G. Privileges (cloud has no default EXECUTE grants — explicit, always)
-- ============================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'cost_default_vat_rate()', 'cost_true_up_provisional_sales(uuid)', 'cost_on_default_vat_change()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'cost_default_vat_rate()', 'cost_true_up_provisional_sales(uuid)',
    -- replaced bodies keep their grants; re-granted for clarity
    'cost_costing_version()', 'cost_sync_purchases(uuid)', 'cost_replay_product(uuid)', 'cost_apply_order_item(uuid)',
    'cost_fill_pending_sales(uuid)', 'cost_rebuild_product(uuid, text, uuid)', 'cost_restatement_candidates(integer)',
    'cost_restatement_preview_product(uuid)', 'cost_restate_order_cogs(uuid[], text, uuid)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;

-- PostgREST caches the schema; new columns / functions must be visible at once.
NOTIFY pgrst, 'reload schema';
