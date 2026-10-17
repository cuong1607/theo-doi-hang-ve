-- ============================================================
-- PHASE PRODUCT-COMBO-1: logical combo SKU + BOM + atomic COGS + atomic
-- inventory.
--
--   ATOMIC product = real SKU = the ONLY source of truth for stock, moving
--   average, COGS and the cost ledger (unchanged).
--   COMBO product  = a selling SKU made of atomic SKUs (BOM). It has no
--   stock, no moving average, no product_cost_state, no purchase_in and no
--   sale_out of its own — enforced by guards below, not just by convention.
--
--   products.product_type                 atomic | combo (immutable; combo has no supplier)
--   product_combo_components              BOM: combo → atomic component × quantity (> 0)
--   channel_order_item_cogs_components    per combo order line × component: the BOM
--                                         and cost USED (immutable once costed)
--   inventory_cost_ledger                 component sale_out / sale_reversal_in with
--                                         source_type 'channel_order_item_component',
--                                         source_id = the snapshot row (stable id →
--                                         the existing unique key makes retries idempotent)
--
-- Combo COGS (cost_apply_combo_order_item, one transaction):
--   first posting snapshots the CURRENT BOM (later BOM edits never touch it);
--   per component: sale_out of bom_qty × order_qty on the ATOMIC product,
--   cost = that product's moving average at the sale moment;
--   line total_cogs = Σ component totals — only when EVERY component is
--   costed (otherwise NULL, never partial); provisional if any component is.
-- Cancellation reverses each component at its snapshot cost (snapshot, never
-- the current BOM). Pending components fill / provisional ones true up with
-- the existing rebuild hooks. Manual historical restatement does not cover
-- combo lines yet (known limit).
-- Version: moving-average-v3-provisional-vat (unchanged); combo lines use
-- cost_method 'combo_bom'.
-- ============================================================


-- ============================================================
-- A. Product type
-- ============================================================
ALTER TABLE public.products
  ADD COLUMN product_type text NOT NULL DEFAULT 'atomic' CHECK (product_type IN ('atomic', 'combo')),
  ADD COLUMN note text;
ALTER TABLE public.products ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE public.products ADD CONSTRAINT products_atomic_has_supplier CHECK (product_type = 'combo' OR supplier_id IS NOT NULL);
ALTER TABLE public.products ADD CONSTRAINT products_combo_no_supplier CHECK (product_type = 'atomic' OR supplier_id IS NULL);
CREATE INDEX idx_products_product_type ON public.products (product_type);
COMMENT ON COLUMN public.products.product_type IS 'atomic = real SKU (stock, cost, ledger) · combo = selling SKU made of atomic SKUs (product_combo_components); immutable.';

CREATE OR REPLACE FUNCTION public.guard_product_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.product_type IS DISTINCT FROM OLD.product_type THEN
    RAISE EXCEPTION 'Không được đổi loại sản phẩm (sản phẩm / combo).' USING ERRCODE = 'PC001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_product_type BEFORE UPDATE OF product_type ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_type();


-- ============================================================
-- B. BOM
-- ============================================================
CREATE TABLE public.product_combo_components (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_product_id     uuid          NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  component_product_id uuid          NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity             numeric(18,4) NOT NULL CHECK (quantity > 0),
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT product_combo_components_not_self CHECK (combo_product_id <> component_product_id),
  CONSTRAINT product_combo_components_unique UNIQUE (combo_product_id, component_product_id)
);
CREATE INDEX idx_product_combo_components_component ON public.product_combo_components (component_product_id);
CREATE TRIGGER set_product_combo_components_updated_at BEFORE UPDATE ON public.product_combo_components
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- combo → atomic only (no nested combos, hence no cycles)
CREATE OR REPLACE FUNCTION public.guard_combo_component() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (SELECT product_type FROM public.products WHERE id = NEW.combo_product_id) IS DISTINCT FROM 'combo' THEN
    RAISE EXCEPTION 'Chỉ sản phẩm loại combo mới có thành phần.' USING ERRCODE = 'PC002';
  END IF;
  IF (SELECT product_type FROM public.products WHERE id = NEW.component_product_id) IS DISTINCT FROM 'atomic' THEN
    RAISE EXCEPTION 'Thành phần của combo phải là sản phẩm thật (không lồng combo).' USING ERRCODE = 'PC003';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_combo_component BEFORE INSERT OR UPDATE ON public.product_combo_components
  FOR EACH ROW EXECUTE FUNCTION public.guard_combo_component();

ALTER TABLE public.product_combo_components ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_combo_components FROM anon, authenticated;
GRANT SELECT ON public.product_combo_components TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_combo_components TO service_role;
CREATE POLICY active_users_select ON public.product_combo_components FOR SELECT TO authenticated USING (public.is_active_user());

-- Create / update a combo and REPLACE its BOM atomically. Duplicate component
-- rows are merged (quantities summed); ≥ 1 component; components atomic.
CREATE OR REPLACE FUNCTION public.save_combo_product(
  p_id            uuid,
  p_sku           text,
  p_name          text,
  p_unit          text,
  p_current_price numeric,
  p_note          text,
  p_components    jsonb
) RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_id    uuid := p_id;
  v_count integer;
  v_bad   integer;
BEGIN
  IF p_sku IS NULL OR btrim(p_sku) = '' THEN RAISE EXCEPTION 'SKU combo là bắt buộc.' USING ERRCODE = 'PC010'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'Tên combo là bắt buộc.' USING ERRCODE = 'PC010'; END IF;
  IF p_components IS NULL OR jsonb_typeof(p_components) <> 'array' OR jsonb_array_length(p_components) = 0 THEN
    RAISE EXCEPTION 'Combo phải có ít nhất 1 thành phần.' USING ERRCODE = 'PC011';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.combo_bom (component_product_id uuid, quantity numeric) ON COMMIT DROP;
  TRUNCATE pg_temp.combo_bom;
  INSERT INTO pg_temp.combo_bom
  SELECT (c ->> 'product_id')::uuid, sum((c ->> 'quantity')::numeric)
  FROM jsonb_array_elements(p_components) c
  GROUP BY 1;

  IF EXISTS (SELECT 1 FROM pg_temp.combo_bom WHERE component_product_id IS NULL OR quantity IS NULL OR quantity <= 0) THEN
    RAISE EXCEPTION 'Số lượng mỗi thành phần phải lớn hơn 0.' USING ERRCODE = 'PC012';
  END IF;
  IF v_id IS NOT NULL AND EXISTS (SELECT 1 FROM pg_temp.combo_bom WHERE component_product_id = v_id) THEN
    RAISE EXCEPTION 'Combo không thể chứa chính nó.' USING ERRCODE = 'PC013';
  END IF;
  SELECT count(*) INTO v_count FROM pg_temp.combo_bom b JOIN public.products p ON p.id = b.component_product_id;
  IF v_count <> (SELECT count(*) FROM pg_temp.combo_bom) THEN
    RAISE EXCEPTION 'Có thành phần không tồn tại.' USING ERRCODE = 'PC014';
  END IF;
  SELECT count(*) INTO v_bad FROM pg_temp.combo_bom b JOIN public.products p ON p.id = b.component_product_id WHERE p.product_type <> 'atomic';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Thành phần của combo phải là sản phẩm thật (không lồng combo).' USING ERRCODE = 'PC003';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.products (sku, name, unit, current_price, supplier_id, product_type, note)
    VALUES (btrim(p_sku), btrim(p_name), COALESCE(NULLIF(btrim(p_unit), ''), 'combo'), COALESCE(p_current_price, 0), NULL, 'combo', NULLIF(btrim(p_note), ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.products
    SET sku = btrim(p_sku), name = btrim(p_name), unit = COALESCE(NULLIF(btrim(p_unit), ''), 'combo'),
        current_price = COALESCE(p_current_price, 0), note = NULLIF(btrim(p_note), '')
    WHERE id = v_id AND product_type = 'combo';
    IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy combo.' USING ERRCODE = 'PC015'; END IF;
    DELETE FROM public.product_combo_components WHERE combo_product_id = v_id;
  END IF;

  INSERT INTO public.product_combo_components (combo_product_id, component_product_id, quantity)
  SELECT v_id, component_product_id, quantity FROM pg_temp.combo_bom;
  RETURN v_id;
END;
$$;


-- ============================================================
-- C. Combo has no stock / cost state / ledger / receipts (guards)
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_atomic_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (SELECT product_type FROM public.products WHERE id = NEW.product_id) = 'combo' THEN
    RAISE EXCEPTION 'Combo không có tồn kho / giá vốn / nhập hàng riêng (%).', TG_TABLE_NAME USING ERRCODE = 'PC020';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_atomic_only BEFORE INSERT OR UPDATE OF product_id ON public.product_cost_state
  FOR EACH ROW EXECUTE FUNCTION public.guard_atomic_only();
CREATE TRIGGER guard_atomic_only BEFORE INSERT OR UPDATE OF product_id ON public.inventory_cost_ledger
  FOR EACH ROW EXECUTE FUNCTION public.guard_atomic_only();
CREATE TRIGGER guard_atomic_only BEFORE INSERT OR UPDATE OF product_id ON public.receipt_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_atomic_only();
CREATE TRIGGER guard_atomic_only BEFORE INSERT OR UPDATE OF product_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_atomic_only();


-- ============================================================
-- D. Order line component snapshot + ledger source
-- ============================================================
ALTER TABLE public.channel_order_items DROP CONSTRAINT channel_order_items_cost_method_check;
ALTER TABLE public.channel_order_items ADD CONSTRAINT channel_order_items_cost_method_check CHECK (
  cost_method IN ('moving_average', 'fifo', 'manual', 'unknown', 'combo_bom')
);

CREATE TABLE public.channel_order_item_cogs_components (
  id                           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_order_item_id        uuid          NOT NULL REFERENCES public.channel_order_items(id) ON DELETE CASCADE,
  combo_product_id             uuid          NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  component_product_id         uuid          NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  component_sku_snapshot       text          NOT NULL,
  component_quantity_per_combo numeric(18,4) NOT NULL CHECK (component_quantity_per_combo > 0),
  order_quantity               numeric(18,4) NOT NULL CHECK (order_quantity > 0),
  total_component_quantity     numeric(18,4) NOT NULL CHECK (total_component_quantity > 0),
  cost_per_unit_snapshot       numeric(18,4),
  component_total_cogs         numeric(18,2),
  cost_method                  text          CHECK (cost_method IS NULL OR cost_method = 'moving_average'),
  cost_provisional             boolean       NOT NULL DEFAULT false,
  calculated_at                timestamptz,
  calculation_version          text          NOT NULL,
  created_at                   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT channel_order_item_cogs_components_unique UNIQUE (channel_order_item_id, component_product_id),
  CONSTRAINT channel_order_item_cogs_components_costed CHECK ((cost_per_unit_snapshot IS NULL) = (component_total_cogs IS NULL))
);
CREATE INDEX idx_order_item_cogs_components_component ON public.channel_order_item_cogs_components (component_product_id);
CREATE INDEX idx_order_item_cogs_components_combo ON public.channel_order_item_cogs_components (combo_product_id);
COMMENT ON TABLE public.channel_order_item_cogs_components IS
  'Combo order line × atomic component: BOM + cost used at costing time. Immutable once costed (restatement / provisional true-up only).';

ALTER TABLE public.channel_order_item_cogs_components ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_order_item_cogs_components FROM anon, authenticated;
GRANT SELECT ON public.channel_order_item_cogs_components TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_order_item_cogs_components TO service_role;
CREATE POLICY active_users_select ON public.channel_order_item_cogs_components FOR SELECT TO authenticated USING (public.is_active_user());

CREATE OR REPLACE FUNCTION public.guard_order_item_cogs_component() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.cost_per_unit_snapshot IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.channel_order_items WHERE id = OLD.channel_order_item_id) THEN
      RAISE EXCEPTION 'Thành phần combo đã chốt giá vốn — không được xóa.' USING ERRCODE = 'CG004';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.cost_per_unit_snapshot IS NOT NULL
     AND COALESCE(current_setting('app.cogs_restatement', true), '') <> 'on'
     AND (
          NEW.component_product_id IS DISTINCT FROM OLD.component_product_id
       OR NEW.combo_product_id IS DISTINCT FROM OLD.combo_product_id
       OR NEW.component_quantity_per_combo IS DISTINCT FROM OLD.component_quantity_per_combo
       OR NEW.order_quantity IS DISTINCT FROM OLD.order_quantity
       OR NEW.total_component_quantity IS DISTINCT FROM OLD.total_component_quantity
       OR NEW.cost_per_unit_snapshot IS DISTINCT FROM OLD.cost_per_unit_snapshot
       OR NEW.component_total_cogs IS DISTINCT FROM OLD.component_total_cogs
       OR NEW.cost_provisional IS DISTINCT FROM OLD.cost_provisional
     ) THEN
    RAISE EXCEPTION 'Giá vốn thành phần combo đã được chốt — không được thay đổi.' USING ERRCODE = 'CG001';
  END IF;
  -- BOM structure is fixed from the first posting, costed or not
  IF NEW.component_product_id IS DISTINCT FROM OLD.component_product_id
     OR NEW.component_quantity_per_combo IS DISTINCT FROM OLD.component_quantity_per_combo
     OR NEW.combo_product_id IS DISTINCT FROM OLD.combo_product_id THEN
    RAISE EXCEPTION 'BOM đã chụp của dòng đơn không được thay đổi.' USING ERRCODE = 'CG005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_order_item_cogs_component BEFORE UPDATE OR DELETE ON public.channel_order_item_cogs_components
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_item_cogs_component();

ALTER TABLE public.inventory_cost_ledger DROP CONSTRAINT inventory_cost_ledger_source_type_check;
ALTER TABLE public.inventory_cost_ledger ADD CONSTRAINT inventory_cost_ledger_source_type_check CHECK (
  source_type IN ('receipt_item', 'channel_order_item', 'channel_order_item_component', 'manual_adjustment', 'opening_balance', 'return_item')
);


-- ============================================================
-- E. Combo costing functions
-- ============================================================
-- Withdraw an UNCOSTED combo line's component sales (remap / no cost /
-- cancelled while pending): ledger rows + snapshot rows removed, replayed.
CREATE OR REPLACE FUNCTION public.cost_withdraw_combo_components(p_order_item_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.id, c.component_product_id FROM public.channel_order_item_cogs_components c
    WHERE c.channel_order_item_id = p_order_item_id ORDER BY c.component_product_id
  LOOP
    PERFORM public.cost_lock_state(r.component_product_id);
  END LOOP;
  FOR r IN
    SELECT c.id, c.component_product_id FROM public.channel_order_item_cogs_components c
    WHERE c.channel_order_item_id = p_order_item_id ORDER BY c.component_product_id
  LOOP
    DELETE FROM public.inventory_cost_ledger
    WHERE source_type = 'channel_order_item_component' AND source_id = r.id AND event_type = 'sale_out';
    PERFORM public.cost_replay_product(r.component_product_id);
  END LOOP;
  DELETE FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = p_order_item_id;
END;
$$;

-- One combo order line: snapshot BOM (first time), post atomic sale_outs,
-- cost when every component is known. Idempotent.
CREATE OR REPLACE FUNCTION public.cost_apply_combo_order_item(p_order_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v        record;
  r        record;
  v_combo  uuid;
  v_new    uuid;
  v_unknown  boolean := false;
  v_pending  boolean := false;
  v_negative boolean := false;
  v_total  numeric;
  v_unit   numeric;
  v_prov   boolean;
BEGIN
  SELECT oi.id, oi.internal_product_id, oi.quantity, oi.total_cogs, oi.provider_line_key, oi.cogs_reversed_at,
         o.order_status, o.external_order_sn, COALESCE(o.paid_at_channel, o.created_at_channel, now()) AS cost_time
  INTO v
  FROM public.channel_order_items oi
  JOIN public.channel_orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id
  FOR UPDATE OF oi;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.total_cogs IS NOT NULL OR v.cogs_reversed_at IS NOT NULL THEN RETURN 'already'; END IF;

  SELECT combo_product_id INTO v_combo FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = v.id LIMIT 1;
  IF v_combo IS NULL THEN
    IF NOT public.cost_order_status_eligible(v.order_status) THEN RETURN 'ineligible'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_combo_components WHERE combo_product_id = v.internal_product_id) THEN
      RETURN 'no_bom';
    END IF;
    -- snapshot the BOM used for this line (current BOM, now)
    INSERT INTO public.channel_order_item_cogs_components
      (channel_order_item_id, combo_product_id, component_product_id, component_sku_snapshot,
       component_quantity_per_combo, order_quantity, total_component_quantity, calculation_version)
    SELECT v.id, v.internal_product_id, b.component_product_id, p.sku, b.quantity, v.quantity,
           public.cost_round_qty(b.quantity * v.quantity), public.cost_costing_version()
    FROM public.product_combo_components b
    JOIN public.products p ON p.id = b.component_product_id AND p.product_type = 'atomic'
    WHERE b.combo_product_id = v.internal_product_id
    ON CONFLICT (channel_order_item_id, component_product_id) DO NOTHING;
  END IF;

  -- consistent locking order across all component cost states
  FOR r IN SELECT component_product_id FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = v.id ORDER BY component_product_id LOOP
    PERFORM public.cost_lock_state(r.component_product_id);
  END LOOP;

  FOR r IN
    SELECT c.id, c.component_product_id, c.component_sku_snapshot, c.total_component_quantity
    FROM public.channel_order_item_cogs_components c
    WHERE c.channel_order_item_id = v.id
    ORDER BY c.component_product_id
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.inventory_cost_ledger WHERE source_type = 'channel_order_item_component' AND source_id = r.id AND event_type = 'sale_out') THEN
      INSERT INTO public.inventory_cost_ledger
        (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change, metadata)
      VALUES
        (r.component_product_id, 'sale_out', 'channel_order_item_component', r.id, v.external_order_sn, v.cost_time,
         '2|' || v.external_order_sn || '|' || COALESCE(v.provider_line_key, v.id::text) || '|' || r.component_sku_snapshot,
         -r.total_component_quantity,
         jsonb_build_object('parent_order_item_id', v.id, 'combo_product_id', v.internal_product_id))
      RETURNING id INTO v_new;
      PERFORM public.cost_replay_product(r.component_product_id);
    END IF;
  END LOOP;

  FOR r IN
    SELECT l.avg_cost_before, l.qty_after, l.metadata
    FROM public.channel_order_item_cogs_components c
    JOIN public.inventory_cost_ledger l ON l.source_type = 'channel_order_item_component' AND l.source_id = c.id AND l.event_type = 'sale_out'
    WHERE c.channel_order_item_id = v.id
  LOOP
    IF r.avg_cost_before IS NULL THEN
      IF COALESCE((r.metadata ->> 'cost_pending')::boolean, false) THEN v_pending := true; ELSE v_unknown := true; END IF;
    END IF;
    IF r.qty_after < 0 THEN v_negative := true; END IF;
  END LOOP;
  IF v_unknown THEN
    -- a component with no known cost at all: post nothing (never a partial / fake COGS)
    PERFORM public.cost_withdraw_combo_components(v.id);
    RETURN 'no_cost';
  END IF;
  IF v_pending THEN RETURN 'cost_pending'; END IF;

  UPDATE public.channel_order_item_cogs_components c
  SET cost_per_unit_snapshot = l.avg_cost_before,
      component_total_cogs = public.cost_round_money(c.total_component_quantity * l.avg_cost_before),
      cost_method = 'moving_average',
      cost_provisional = COALESCE((l.metadata ->> 'cost_provisional')::boolean, false),
      calculated_at = now(),
      calculation_version = public.cost_costing_version()
  FROM public.inventory_cost_ledger l
  WHERE c.channel_order_item_id = v.id
    AND l.source_type = 'channel_order_item_component' AND l.source_id = c.id AND l.event_type = 'sale_out';

  SELECT sum(component_total_cogs), sum(component_quantity_per_combo * cost_per_unit_snapshot), bool_or(cost_provisional)
  INTO v_total, v_unit, v_prov
  FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = v.id;

  UPDATE public.channel_order_items
  SET cost_method = 'combo_bom',
      cost_per_unit_snapshot = public.cost_round_cost(v_unit),
      total_cogs = v_total,
      cogs_calculated_at = now(),
      cost_version = public.cost_costing_version(),
      cost_provisional = COALESCE(v_prov, false)
  WHERE id = v.id;
  RETURN CASE WHEN v_negative THEN 'calculated_negative' ELSE 'calculated' END;
END;
$$;

-- Cancellation of a combo line: reverse every component at its SNAPSHOT cost
-- (pending → withdraw). Never reads the current BOM.
CREATE OR REPLACE FUNCTION public.cost_reverse_combo_order_item(p_order_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v record;
  r record;
BEGIN
  SELECT oi.id, oi.total_cogs, oi.cogs_reversed_at, oi.provider_line_key, o.external_order_sn, COALESCE(o.updated_at_channel, now()) AS rev_time
  INTO v
  FROM public.channel_order_items oi JOIN public.channel_orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id
  FOR UPDATE OF oi;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.cogs_reversed_at IS NOT NULL THEN RETURN 'already'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.channel_order_item_cogs_components c
    JOIN public.inventory_cost_ledger l ON l.source_type = 'channel_order_item_component' AND l.source_id = c.id AND l.event_type = 'sale_out'
    WHERE c.channel_order_item_id = v.id
  ) THEN
    RETURN 'nothing_posted';
  END IF;

  IF v.total_cogs IS NULL THEN
    PERFORM public.cost_withdraw_combo_components(v.id);
    RETURN 'withdrawn_pending';
  END IF;

  FOR r IN SELECT component_product_id FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = v.id ORDER BY component_product_id LOOP
    PERFORM public.cost_lock_state(r.component_product_id);
  END LOOP;
  FOR r IN
    SELECT c.id, c.component_product_id, c.component_sku_snapshot, c.total_component_quantity, c.cost_per_unit_snapshot
    FROM public.channel_order_item_cogs_components c
    WHERE c.channel_order_item_id = v.id
    ORDER BY c.component_product_id
  LOOP
    INSERT INTO public.inventory_cost_ledger
      (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change, unit_cost, note, metadata)
    VALUES
      (r.component_product_id, 'sale_reversal_in', 'channel_order_item_component', r.id, v.external_order_sn, v.rev_time,
       '3|' || v.external_order_sn || '|' || COALESCE(v.provider_line_key, v.id::text) || '|' || r.component_sku_snapshot,
       r.total_component_quantity, r.cost_per_unit_snapshot,
       'Đơn combo bị huỷ — hoàn kho thành phần theo giá vốn snapshot',
       jsonb_build_object('parent_order_item_id', v.id))
    ON CONFLICT (source_type, source_id, event_type) WHERE source_id IS NOT NULL DO NOTHING;
    PERFORM public.cost_replay_product(r.component_product_id);
  END LOOP;
  UPDATE public.channel_order_items SET cogs_reversed_at = now() WHERE id = v.id;
  RETURN 'reversed';
END;
$$;

-- Rebuild hook: pending combo lines whose components are now all known get
-- their FIRST costing (same function → same rule).
CREATE OR REPLACE FUNCTION public.cost_fill_pending_combo_sales(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r       record;
  v_n     integer := 0;
  v_res   text;
BEGIN
  FOR r IN
    SELECT DISTINCT oi.id, oi.order_id
    FROM public.channel_order_item_cogs_components c
    JOIN public.channel_order_items oi ON oi.id = c.channel_order_item_id
    JOIN public.channel_orders o ON o.id = oi.order_id
    WHERE c.component_product_id = p_product_id
      AND oi.total_cogs IS NULL AND oi.cogs_reversed_at IS NULL
      AND public.cost_order_status_eligible(o.order_status)
    ORDER BY oi.id
  LOOP
    v_res := public.cost_apply_combo_order_item(r.id);
    IF v_res IN ('calculated', 'calculated_negative') THEN
      v_n := v_n + 1;
      PERFORM public.cost_refresh_order_cogs(r.order_id);
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Rebuild hook: provisional combo lines follow the current reconstruction of
-- ALL their components until final (same policy as atomic lines, 00054).
CREATE OR REPLACE FUNCTION public.cost_true_up_provisional_combo_sales(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r        record;
  v_n      integer := 0;
  v_batch  uuid := gen_random_uuid();
  v_known  boolean;
  v_total  numeric;
  v_unit   numeric;
  v_prov   boolean;
BEGIN
  PERFORM set_config('app.cogs_restatement', 'on', true);
  FOR r IN
    SELECT DISTINCT oi.id, oi.order_id, oi.quantity, oi.total_cogs, oi.cost_per_unit_snapshot, oi.cost_version, oi.internal_product_id
    FROM public.channel_order_item_cogs_components c
    JOIN public.channel_order_items oi ON oi.id = c.channel_order_item_id
    WHERE c.component_product_id = p_product_id
      AND oi.cost_provisional AND oi.total_cogs IS NOT NULL AND oi.cogs_reversed_at IS NULL
    ORDER BY oi.id
  LOOP
    SELECT bool_and(l.avg_cost_before IS NOT NULL) INTO v_known
    FROM public.channel_order_item_cogs_components c
    JOIN public.inventory_cost_ledger l ON l.source_type = 'channel_order_item_component' AND l.source_id = c.id AND l.event_type = 'sale_out'
    WHERE c.channel_order_item_id = r.id;
    IF NOT COALESCE(v_known, false) THEN CONTINUE; END IF;

    UPDATE public.channel_order_item_cogs_components c
    SET cost_per_unit_snapshot = l.avg_cost_before,
        component_total_cogs = public.cost_round_money(c.total_component_quantity * l.avg_cost_before),
        cost_provisional = COALESCE((l.metadata ->> 'cost_provisional')::boolean, false),
        calculated_at = now(),
        calculation_version = public.cost_costing_version()
    FROM public.inventory_cost_ledger l
    WHERE c.channel_order_item_id = r.id
      AND l.source_type = 'channel_order_item_component' AND l.source_id = c.id AND l.event_type = 'sale_out'
      AND (c.cost_per_unit_snapshot IS DISTINCT FROM l.avg_cost_before
           OR c.cost_provisional IS DISTINCT FROM COALESCE((l.metadata ->> 'cost_provisional')::boolean, false));

    SELECT sum(component_total_cogs), sum(component_quantity_per_combo * cost_per_unit_snapshot), bool_or(cost_provisional)
    INTO v_total, v_unit, v_prov
    FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = r.id;

    IF v_total IS DISTINCT FROM r.total_cogs OR NOT COALESCE(v_prov, false) THEN
      UPDATE public.channel_order_items
      SET cost_per_unit_snapshot = public.cost_round_cost(v_unit),
          total_cogs = v_total,
          cogs_calculated_at = now(),
          cost_version = public.cost_costing_version(),
          cost_provisional = COALESCE(v_prov, false)
      WHERE id = r.id;
      IF v_total IS DISTINCT FROM r.total_cogs THEN
        INSERT INTO public.cogs_restatements
          (batch_id, order_id, order_item_id, product_id, old_cost_per_unit, new_cost_per_unit, old_total_cogs, new_total_cogs,
           old_cost_version, new_cost_version, reason, adjusted_by, source)
        VALUES
          (v_batch, r.order_id, r.id, r.internal_product_id, r.cost_per_unit_snapshot, public.cost_round_cost(v_unit), r.total_cogs, v_total,
           r.cost_version, public.cost_costing_version(),
           CASE WHEN COALESCE(v_prov, false) THEN 'Tự động: cập nhật giá vốn tạm tính (combo)' ELSE 'Tự động: giá vốn tạm tính → VAT hóa đơn (combo)' END,
           NULL, 'provisional_true_up');
      END IF;
      PERFORM public.cost_refresh_order_cogs(r.order_id);
      v_n := v_n + 1;
    END IF;
  END LOOP;
  PERFORM set_config('app.cogs_restatement', 'off', true);
  RETURN v_n;
END;
$$;


-- ============================================================
-- F. Engine entry points become combo-aware (atomic paths unchanged)
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
  v_combo  uuid;
BEGIN
  SELECT oi.id, oi.internal_product_id, oi.quantity, oi.total_cogs, oi.provider_line_key, oi.cogs_reversed_at,
         o.order_status, o.external_order_sn, COALESCE(o.paid_at_channel, o.created_at_channel, now()) AS cost_time,
         p.product_type
  INTO v
  FROM public.channel_order_items oi
  JOIN public.channel_orders o ON o.id = oi.order_id
  LEFT JOIN public.products p ON p.id = oi.internal_product_id
  WHERE oi.id = p_order_item_id
  FOR UPDATE OF oi;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.total_cogs IS NOT NULL THEN RETURN 'already'; END IF;

  -- PRODUCT-COMBO-1: a line already posted as a combo, or mapped to a combo
  SELECT combo_product_id INTO v_combo FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = v.id LIMIT 1;
  IF v_combo IS NOT NULL THEN
    IF v.cogs_reversed_at IS NOT NULL THEN RETURN 'already'; END IF;
    IF v_combo IS NOT DISTINCT FROM v.internal_product_id THEN
      RETURN public.cost_apply_combo_order_item(v.id);
    END IF;
    -- uncosted combo line re-mapped: withdraw its component sales, then cost as mapped now
    PERFORM public.cost_withdraw_combo_components(v.id);
  END IF;
  IF v.product_type = 'combo' THEN
    SELECT l.id, l.product_id INTO v_led
    FROM public.inventory_cost_ledger l
    WHERE l.source_type = 'channel_order_item' AND l.source_id = v.id AND l.event_type = 'sale_out';
    IF FOUND THEN
      IF v.cogs_reversed_at IS NOT NULL THEN RETURN 'already'; END IF;
      -- pending atomic sale of a line re-mapped to a combo: withdraw it
      PERFORM public.cost_lock_state(v_led.product_id);
      DELETE FROM public.inventory_cost_ledger WHERE id = v_led.id;
      PERFORM public.cost_replay_product(v_led.product_id);
    END IF;
    RETURN public.cost_apply_combo_order_item(v.id);
  END IF;

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

CREATE OR REPLACE FUNCTION public.cost_reverse_order_item(p_order_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = p_order_item_id) THEN
    RETURN public.cost_reverse_combo_order_item(p_order_item_id);
  END IF;

  SELECT oi.id, oi.internal_product_id, oi.quantity, oi.cost_per_unit_snapshot, oi.cogs_reversed_at, oi.provider_line_key,
         o.external_order_sn, COALESCE(o.updated_at_channel, now()) AS rev_time,
         l.id AS ledger_id, l.product_id AS ledger_product
  INTO v
  FROM public.channel_order_items oi
  JOIN public.channel_orders o ON o.id = oi.order_id
  LEFT JOIN public.inventory_cost_ledger l
    ON l.source_type = 'channel_order_item' AND l.source_id = oi.id AND l.event_type = 'sale_out'
  WHERE oi.id = p_order_item_id
  FOR UPDATE OF oi;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.ledger_product IS NULL THEN RETURN 'nothing_posted'; END IF;
  IF v.cogs_reversed_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.inventory_cost_ledger WHERE source_type = 'channel_order_item' AND source_id = v.id AND event_type = 'sale_reversal_in') THEN
    RETURN 'already';
  END IF;

  PERFORM public.cost_lock_state(v.ledger_product);
  IF v.cost_per_unit_snapshot IS NULL THEN
    DELETE FROM public.inventory_cost_ledger WHERE id = v.ledger_id;
    PERFORM public.cost_replay_product(v.ledger_product);
    RETURN 'withdrawn_pending';
  END IF;
  INSERT INTO public.inventory_cost_ledger
    (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change, unit_cost, note)
  VALUES
    (v.ledger_product, 'sale_reversal_in', 'channel_order_item', v.id, v.external_order_sn, v.rev_time,
     '3|' || v.external_order_sn || '|' || COALESCE(v.provider_line_key, v.id::text), v.quantity, v.cost_per_unit_snapshot,
     'Đơn bị huỷ — hoàn kho theo giá vốn snapshot');
  PERFORM public.cost_replay_product(v.ledger_product);
  UPDATE public.channel_order_items SET cogs_reversed_at = now() WHERE id = v.id;
  RETURN 'reversed';
END;
$$;

-- Locks only ATOMIC cost states (a combo never gets one): atomic lines, the
-- current BOM of combo lines, and every product already posted for the order.
CREATE OR REPLACE FUNCTION public.cost_process_order(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_status  text;
  v_item    record;
  v_result  text;
  v_counts  jsonb := '{}'::jsonb;
  v_p       uuid;
BEGIN
  SELECT order_status INTO v_status FROM public.channel_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('not_found', 1); END IF;

  FOR v_p IN
    SELECT DISTINCT p FROM (
      SELECT oi.internal_product_id AS p FROM public.channel_order_items oi
        JOIN public.products pr ON pr.id = oi.internal_product_id AND pr.product_type = 'atomic'
        WHERE oi.order_id = p_order_id
      UNION SELECT b.component_product_id FROM public.channel_order_items oi
        JOIN public.product_combo_components b ON b.combo_product_id = oi.internal_product_id
        WHERE oi.order_id = p_order_id
      UNION SELECT l.product_id FROM public.inventory_cost_ledger l JOIN public.channel_order_items oi ON oi.id = l.source_id
        WHERE oi.order_id = p_order_id AND l.source_type = 'channel_order_item'
      UNION SELECT c.component_product_id FROM public.channel_order_item_cogs_components c
        JOIN public.channel_order_items oi ON oi.id = c.channel_order_item_id
        WHERE oi.order_id = p_order_id
    ) x WHERE p IS NOT NULL ORDER BY 1
  LOOP
    PERFORM public.cost_lock_state(v_p);
  END LOOP;

  FOR v_item IN SELECT id FROM public.channel_order_items WHERE order_id = p_order_id ORDER BY provider_line_key, id LOOP
    IF v_status = 'CANCELLED' THEN
      v_result := public.cost_reverse_order_item(v_item.id);
    ELSE
      v_result := public.cost_apply_order_item(v_item.id);
    END IF;
    v_counts := v_counts || jsonb_build_object(v_result, COALESCE((v_counts ->> v_result)::integer, 0) + 1);
  END LOOP;

  PERFORM public.cost_refresh_order_cogs(p_order_id);
  RETURN v_counts;
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
  -- a combo has no ledger of its own: nothing to rebuild
  IF (SELECT product_type FROM public.products WHERE id = p_product_id) = 'combo' THEN
    RETURN NULL;
  END IF;
  PERFORM public.cost_lock_state(p_product_id);
  SELECT to_jsonb(s) - 'updated_at' INTO v_before FROM public.product_cost_state s WHERE s.product_id = p_product_id;
  v_purch := public.cost_sync_purchases(p_product_id);
  PERFORM public.cost_replay_product(p_product_id);
  PERFORM public.cost_fill_pending_sales(p_product_id);
  PERFORM public.cost_fill_pending_combo_sales(p_product_id);
  PERFORM public.cost_true_up_provisional_sales(p_product_id);
  PERFORM public.cost_true_up_provisional_combo_sales(p_product_id);
  SELECT count(*) INTO v_total FROM public.inventory_cost_ledger WHERE product_id = p_product_id;
  SELECT to_jsonb(s) - 'updated_at' INTO v_after FROM public.product_cost_state s WHERE s.product_id = p_product_id;
  INSERT INTO public.inventory_cost_rebuilds (product_id, reason, triggered_by, purchase_events, total_events, state_before, state_after)
  VALUES (p_product_id, p_reason, p_triggered_by, v_purch, v_total, v_before, v_after);
  RETURN v_after;
END;
$$;


-- ============================================================
-- G. Read models
-- ============================================================
-- Cost overview: atomic products only (+ product_type appended for callers).
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
  COALESCE(s.cost_provisional, false)   AS cost_provisional,
  p.product_type
FROM public.products p
LEFT JOIN public.product_cost_state s ON s.product_id = p.id
WHERE p.product_type = 'atomic';

REVOKE ALL ON public.v_product_cost_overview FROM anon;
GRANT SELECT ON public.v_product_cost_overview TO authenticated, service_role;

-- Combo overview: DERIVED cost / availability (display only — never stored).
--   current_unit_cost = Σ component moving average × BOM qty; NULL when any
--                       component has no cost ("Chưa đủ giá vốn"), never partial
--   available_qty     = min(floor(max(component qty on hand, 0) / BOM qty))
CREATE OR REPLACE VIEW public.v_combo_overview
WITH (security_invoker = true)
AS
SELECT
  p.id                AS combo_product_id,
  p.sku,
  p.name,
  p.unit,
  p.current_price::text AS current_price,
  p.is_active,
  p.note,
  p.created_at,
  COALESCE(b.component_count, 0) AS component_count,
  b.components,
  b.current_unit_cost::text AS current_unit_cost,
  COALESCE(b.cost_provisional, false) AS cost_provisional,
  b.available_qty::text AS available_qty,
  (SELECT count(*) FROM public.channel_product_models m WHERE m.internal_product_id = p.id) AS mapped_models,
  (SELECT count(*) FROM public.channel_order_items oi WHERE oi.internal_product_id = p.id) AS order_lines
FROM public.products p
LEFT JOIN LATERAL (
  SELECT
    count(*) AS component_count,
    jsonb_agg(jsonb_build_object(
      'product_id', c.component_product_id,
      'sku', cp.sku,
      'name', cp.name,
      'quantity', c.quantity::text,
      'is_active', cp.is_active,
      'moving_average_cost', s.moving_average_cost::text,
      'quantity_on_hand', s.quantity_on_hand::text,
      'cost_provisional', COALESCE(s.cost_provisional, false)
    ) ORDER BY cp.sku) AS components,
    CASE WHEN bool_and(s.moving_average_cost IS NOT NULL) THEN public.cost_round_cost(sum(c.quantity * s.moving_average_cost)) END AS current_unit_cost,
    bool_or(COALESCE(s.cost_provisional, false)) AS cost_provisional,
    min(floor(GREATEST(COALESCE(s.quantity_on_hand, 0), 0) / c.quantity)) AS available_qty
  FROM public.product_combo_components c
  JOIN public.products cp ON cp.id = c.component_product_id
  LEFT JOIN public.product_cost_state s ON s.product_id = c.component_product_id
  WHERE c.combo_product_id = p.id
) b ON true
WHERE p.product_type = 'combo';

REVOKE ALL ON public.v_combo_overview FROM anon;
GRANT SELECT ON public.v_combo_overview TO authenticated, service_role;


-- ============================================================
-- H. Privileges (cloud has no default EXECUTE grants — explicit, always)
-- ============================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'guard_product_type()', 'guard_combo_component()', 'guard_atomic_only()', 'guard_order_item_cogs_component()',
    'save_combo_product(uuid, text, text, text, numeric, text, jsonb)',
    'cost_withdraw_combo_components(uuid)', 'cost_apply_combo_order_item(uuid)', 'cost_reverse_combo_order_item(uuid)',
    'cost_fill_pending_combo_sales(uuid)', 'cost_true_up_provisional_combo_sales(uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'save_combo_product(uuid, text, text, text, numeric, text, jsonb)',
    'cost_withdraw_combo_components(uuid)', 'cost_apply_combo_order_item(uuid)', 'cost_reverse_combo_order_item(uuid)',
    'cost_fill_pending_combo_sales(uuid)', 'cost_true_up_provisional_combo_sales(uuid)',
    -- replaced bodies keep their grants; re-granted for clarity
    'cost_apply_order_item(uuid)', 'cost_reverse_order_item(uuid)', 'cost_process_order(uuid)', 'cost_rebuild_product(uuid, text, uuid)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
