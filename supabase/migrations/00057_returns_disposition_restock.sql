-- ============================================================
-- PHASE SHOPEE-6: returns + refunds + disposition + inventory restock + COGS
-- reversal. Three layers kept apart:
--
--   1. OPERATIONAL return (channel_returns / channel_return_items, synced by
--      the return job): status, reason, items — each item linked to the
--      ORIGINAL order line (channel_order_item_id; matched by provider
--      item/model id, never by name). Refund amounts here are operational /
--      reconciliation only.
--   2. FINANCIAL refund: Shopee escrow stays the source of truth
--      (actual_shopee_income already contains refunds / adjustments; the
--      refund component is info-only in the dictionary; seller compensation
--      stays its own column). Nothing here subtracts a refund again.
--   3. INVENTORY / COGS: ONLY disposition 'restock' moves stock. Each restock
--      episode is a channel_return_restocks row (stable id) per restored
--      ATOMIC product:
--        atomic line → product = the line's historical internal_product_id,
--                      unit cost = the line's cost_per_unit_snapshot
--        combo line  → per channel_order_item_cogs_components row (historical
--                      BOM + component cost) — never the current BOM / cost
--      ledger: return_in (source 'channel_return_restock', source_id =
--      episode) at that cost. Leaving 'restock' adds a compensating
--      adjustment_out of the same quantity at the same cost (history kept);
--      re-entering 'restock' starts a new episode. Idempotent through the
--      ledger unique key + one ACTIVE episode per (return item, product).
--      Σ active restocked order-line quantity ≤ sold quantity (row-locked).
--
--   order_financials.reversed_cogs = Σ active episode cost;
--   net_cogs = internal_cogs − reversed_cogs;
--   profit_after_cogs / actual_profit = actual_shopee_income − net_cogs.
--   financial_status 'return_adjusted' once a non-cancelled return exists
--   and the settlement is known. Original sale snapshots are never touched.
-- ============================================================


-- ============================================================
-- A. Operational return columns
-- ============================================================
ALTER TABLE public.channel_returns
  ADD COLUMN is_terminal        boolean NOT NULL DEFAULT false,
  ADD COLUMN completed_at       timestamptz,
  ADD COLUMN negotiation_status text,
  ADD COLUMN return_refund_type text;
CREATE INDEX idx_channel_returns_open ON public.channel_returns (shop_id, last_synced_at) WHERE NOT is_terminal;

ALTER TABLE public.channel_return_items
  ADD COLUMN channel_order_item_id  uuid REFERENCES public.channel_order_items(id) ON DELETE RESTRICT,
  ADD COLUMN item_name              text,
  ADD COLUMN disposition_changed_at timestamptz,
  ADD COLUMN disposition_changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX idx_channel_return_items_order_item ON public.channel_return_items (channel_order_item_id);
-- one row per (return, provider item/model, original order line)
CREATE UNIQUE INDEX uq_channel_return_items_identity
  ON public.channel_return_items (return_id, external_item_id, COALESCE(external_model_id, ''), COALESCE(channel_order_item_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Returns that could not be stored yet (e.g. their order could not be
-- fetched): re-tried by the next return jobs with the explicit reason; the
-- row disappears once the return is stored.
CREATE TABLE public.channel_return_sync_retries (
  shop_id            uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  external_return_sn text        NOT NULL,
  external_order_sn  text,
  reason             text        NOT NULL,
  message            text,
  attempts           integer     NOT NULL DEFAULT 1 CHECK (attempts > 0),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_attempt_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, external_return_sn)
);
ALTER TABLE public.channel_return_sync_retries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_return_sync_retries FROM anon, authenticated;
GRANT SELECT ON public.channel_return_sync_retries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_return_sync_retries TO service_role;
CREATE POLICY active_users_select ON public.channel_return_sync_retries FOR SELECT TO authenticated USING (public.is_active_user());

CREATE TABLE public.channel_return_disposition_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  return_item_id   uuid        NOT NULL REFERENCES public.channel_return_items(id) ON DELETE CASCADE,
  old_disposition  text        NOT NULL,
  new_disposition  text        NOT NULL,
  reason           text,
  inventory_effect text        NOT NULL CHECK (inventory_effect IN ('none', 'restocked', 'restock_reversed')),
  cogs_delta       numeric(18,2) NOT NULL DEFAULT 0,
  changed_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_return_disposition_events_item ON public.channel_return_disposition_events (return_item_id, changed_at DESC);
ALTER TABLE public.channel_return_disposition_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_return_disposition_events FROM anon, authenticated;
GRANT SELECT ON public.channel_return_disposition_events TO authenticated;
GRANT SELECT, INSERT ON public.channel_return_disposition_events TO service_role;
CREATE POLICY active_users_select ON public.channel_return_disposition_events FOR SELECT TO authenticated USING (public.is_active_user());


-- ============================================================
-- B. Restock episodes + ledger source
-- ============================================================
CREATE TABLE public.channel_return_restocks (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_item_id        uuid          NOT NULL REFERENCES public.channel_return_items(id) ON DELETE RESTRICT,
  channel_order_item_id uuid          NOT NULL REFERENCES public.channel_order_items(id) ON DELETE RESTRICT,
  product_id            uuid          NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  cogs_component_id     uuid          REFERENCES public.channel_order_item_cogs_components(id) ON DELETE RESTRICT,
  order_quantity        numeric(18,4) NOT NULL CHECK (order_quantity > 0),
  quantity              numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost             numeric(18,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost            numeric(18,2) NOT NULL,
  restocked_at          timestamptz   NOT NULL DEFAULT now(),
  restocked_by          uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  reversed_at           timestamptz,
  reversed_by           uuid          REFERENCES public.profiles(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.channel_return_restocks IS
  'One restock episode of a return item for one ATOMIC product (combo lines: one per historical component). order_quantity = returned order-line units; quantity / unit_cost = atomic stock restored at the ORIGINAL snapshot cost. reversed_at = compensated by an adjustment_out.';
CREATE UNIQUE INDEX uq_return_restocks_active ON public.channel_return_restocks (return_item_id, product_id) WHERE reversed_at IS NULL;
CREATE INDEX idx_return_restocks_order_item ON public.channel_return_restocks (channel_order_item_id) WHERE reversed_at IS NULL;
ALTER TABLE public.channel_return_restocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_return_restocks FROM anon, authenticated;
GRANT SELECT ON public.channel_return_restocks TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.channel_return_restocks TO service_role;
CREATE POLICY active_users_select ON public.channel_return_restocks FOR SELECT TO authenticated USING (public.is_active_user());

ALTER TABLE public.inventory_cost_ledger DROP CONSTRAINT inventory_cost_ledger_source_type_check;
ALTER TABLE public.inventory_cost_ledger ADD CONSTRAINT inventory_cost_ledger_source_type_check CHECK (
  source_type IN ('receipt_item', 'channel_order_item', 'channel_order_item_component', 'channel_return_restock', 'manual_adjustment', 'opening_balance', 'return_item')
);


-- ============================================================
-- C. Replay: a restock reversal leaves at its ORIGINAL cost (00054 + branch)
-- ============================================================
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
    SELECT id, quantity_change, unit_cost, event_time, metadata, cost_basis, source_type, event_type
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
    ELSIF r.source_type = 'channel_return_restock' AND r.unit_cost IS NOT NULL THEN
      -- SHOPEE-6: compensating OUT of a restock — takes back exactly the value it added
      v_mv := public.cost_round_money(-r.quantity_change * r.unit_cost);
      IF v_avg IS NULL THEN
        v_new_a := NULL;
      ELSIF v_new_q > 0 THEN
        v_new_a := public.cost_round_cost(GREATEST((v_q * v_avg + r.quantity_change * r.unit_cost) / v_new_q, 0));
      ELSE
        v_new_a := v_avg;
      END IF;
      UPDATE public.inventory_cost_ledger
      SET qty_before = v_q, qty_after = v_new_q, avg_cost_before = v_avg, avg_cost_after = v_new_a, movement_cost = v_mv,
          metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object('negative_inventory', v_new_q < 0)
      WHERE id = r.id;
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
-- D. Financials: reversed / net COGS
-- ============================================================
ALTER TABLE public.order_financials
  ADD COLUMN reversed_cogs numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN net_cogs      numeric(18,2) GENERATED ALWAYS AS (internal_cogs - reversed_cogs) STORED;
COMMENT ON COLUMN public.order_financials.reversed_cogs IS 'SHOPEE-6: COGS restored by RESTOCKED returns (Σ active channel_return_restocks.total_cost). damaged / lost / disposed / pending never reverse COGS.';

-- 00052 body; actual profit now over NET COGS (refund already inside the escrow income).
CREATE OR REPLACE FUNCTION public.derive_order_financials() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_income   numeric := COALESCE(NEW.escrow_amount_after_adjustment, NEW.escrow_amount);
  v_currency text;
  v_net      numeric := NEW.internal_cogs - COALESCE(NEW.reversed_cogs, 0);
BEGIN
  IF NEW.estimated_order_revenue IS NULL AND NEW.escrow_amount IS NOT NULL THEN
    NEW.estimated_order_revenue := NEW.escrow_amount;
    NEW.estimated_revenue_source := 'escrow_settlement';
    NEW.estimated_revenue_synced_at := COALESCE(NEW.escrow_synced_at, now());
  END IF;
  NEW.estimated_profit := CASE WHEN NEW.estimated_order_revenue IS NOT NULL AND NEW.internal_cogs IS NOT NULL
                               THEN NEW.estimated_order_revenue - NEW.internal_cogs END;

  NEW.profit_after_cogs := CASE WHEN v_income IS NOT NULL AND v_net IS NOT NULL THEN v_income - v_net END;
  NEW.actual_profit := NEW.profit_after_cogs;
  NEW.contribution_profit := NULL;
  NEW.actual_margin := NULL;
  NEW.profit_variance := CASE WHEN NEW.actual_profit IS NOT NULL AND NEW.estimated_profit IS NOT NULL THEN NEW.actual_profit - NEW.estimated_profit END;

  IF v_income IS NOT NULL AND NEW.calculated_settlement IS NOT NULL THEN
    SELECT o.currency INTO v_currency FROM public.channel_orders o WHERE o.id = NEW.order_id;
    NEW.settlement_variance := v_income - NEW.calculated_settlement;
    NEW.settlement_tolerance := public.financial_settlement_tolerance(v_currency, 'matched');
    NEW.reconciliation_status := CASE
      WHEN abs(NEW.settlement_variance) <= public.financial_settlement_tolerance(v_currency, 'matched') THEN 'matched'
      WHEN abs(NEW.settlement_variance) <= public.financial_settlement_tolerance(v_currency, 'warning') THEN 'warning'
      ELSE 'mismatch'
    END;
  ELSE
    NEW.settlement_variance := NULL;
    NEW.settlement_tolerance := NULL;
    NEW.reconciliation_status := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Recalculate the return layer of one order: reversed COGS + status.
CREATE OR REPLACE FUNCTION public.recalculate_return_adjusted_financials(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_rev     numeric;
  v_returns boolean;
  v_income  numeric;
  v_status  text;
  v_recon   text;
BEGIN
  SELECT COALESCE(sum(rs.total_cost), 0) INTO v_rev
  FROM public.channel_return_restocks rs
  JOIN public.channel_order_items oi ON oi.id = rs.channel_order_item_id
  WHERE oi.order_id = p_order_id AND rs.reversed_at IS NULL;

  INSERT INTO public.order_financials (order_id, reversed_cogs) VALUES (p_order_id, v_rev)
  ON CONFLICT (order_id) DO UPDATE SET reversed_cogs = EXCLUDED.reversed_cogs
  WHERE public.order_financials.reversed_cogs IS DISTINCT FROM EXCLUDED.reversed_cogs;

  SELECT EXISTS (SELECT 1 FROM public.channel_returns r WHERE r.order_id = p_order_id AND COALESCE(r.status, '') <> 'CANCELLED') INTO v_returns;
  SELECT f.actual_shopee_income, f.reconciliation_status INTO v_income, v_recon FROM public.order_financials f WHERE f.order_id = p_order_id;
  SELECT o.financial_status INTO v_status FROM public.channel_orders o WHERE o.id = p_order_id;

  IF v_returns AND v_income IS NOT NULL AND v_status <> 'return_adjusted' THEN
    UPDATE public.channel_orders SET financial_status = 'return_adjusted' WHERE id = p_order_id;
    v_status := 'return_adjusted';
  ELSIF NOT v_returns AND v_status = 'return_adjusted' THEN
    -- every return cancelled: back to the settlement view
    v_status := CASE WHEN v_income IS NULL THEN 'pending' WHEN v_recon = 'mismatch' THEN 'mismatch' ELSE 'settlement_available' END;
    UPDATE public.channel_orders SET financial_status = v_status WHERE id = p_order_id;
  END IF;
  RETURN jsonb_build_object('reversed_cogs', v_rev::text, 'financial_status', v_status);
END;
$$;


-- ============================================================
-- E. Return sync write path (one transaction per return)
-- ============================================================
-- Upserts the return and its items. Items are matched to ORIGINAL order lines
-- by provider item/model id; a quantity spread over several lines of the same
-- unit is allocated in line order up to each line's quantity. Existing rows
-- keep their disposition; a quantity can never drop below what was restocked.
CREATE OR REPLACE FUNCTION public.apply_channel_return(p_shop_id uuid, p_order_id uuid, p_return jsonb, p_items jsonb, p_synced_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_return_id uuid;
  v_created   boolean;
  it          record;
  ln          record;
  v_left      numeric;
  v_take      numeric;
  v_unmatched integer := 0;
  v_items     integer := 0;
  v_restocked numeric;
  v_keep      uuid[] := ARRAY[]::uuid[];
  v_row       uuid;
BEGIN
  INSERT INTO public.channel_returns AS r
    (shop_id, order_id, external_return_sn, status, reason, text_reason, refund_amount, currency, needs_logistics, tracking_number,
     reverse_logistics_status, seller_compensation_status, seller_compensation_amount, negotiation_status, return_refund_type,
     created_at_channel, updated_at_channel, is_terminal, completed_at, last_synced_at)
  VALUES
    (p_shop_id, p_order_id, p_return ->> 'external_return_sn', p_return ->> 'status', p_return ->> 'reason', p_return ->> 'text_reason',
     (p_return ->> 'refund_amount')::numeric, p_return ->> 'currency', (p_return ->> 'needs_logistics')::boolean, p_return ->> 'tracking_number',
     p_return ->> 'reverse_logistics_status', p_return ->> 'seller_compensation_status', (p_return ->> 'seller_compensation_amount')::numeric,
     p_return ->> 'negotiation_status', p_return ->> 'return_refund_type',
     (p_return ->> 'created_at_channel')::timestamptz, (p_return ->> 'updated_at_channel')::timestamptz,
     COALESCE((p_return ->> 'is_terminal')::boolean, false), (p_return ->> 'completed_at')::timestamptz, p_synced_at)
  ON CONFLICT (shop_id, external_return_sn) DO UPDATE SET
    order_id = EXCLUDED.order_id, status = EXCLUDED.status, reason = EXCLUDED.reason, text_reason = EXCLUDED.text_reason,
    refund_amount = EXCLUDED.refund_amount, currency = EXCLUDED.currency, needs_logistics = EXCLUDED.needs_logistics,
    tracking_number = EXCLUDED.tracking_number, reverse_logistics_status = EXCLUDED.reverse_logistics_status,
    seller_compensation_status = EXCLUDED.seller_compensation_status, seller_compensation_amount = EXCLUDED.seller_compensation_amount,
    negotiation_status = EXCLUDED.negotiation_status, return_refund_type = EXCLUDED.return_refund_type,
    created_at_channel = EXCLUDED.created_at_channel, updated_at_channel = EXCLUDED.updated_at_channel,
    is_terminal = EXCLUDED.is_terminal, completed_at = COALESCE(r.completed_at, EXCLUDED.completed_at), last_synced_at = EXCLUDED.last_synced_at
  RETURNING id, (xmax = 0) INTO v_return_id, v_created;

  FOR it IN
    SELECT x ->> 'external_item_id' AS item_id, NULLIF(x ->> 'external_model_id', '') AS model_id, x ->> 'item_sku' AS item_sku,
           x ->> 'variation_sku' AS variation_sku, x ->> 'item_name' AS item_name, (x ->> 'quantity')::numeric AS qty,
           (x ->> 'refund_amount')::numeric AS refund
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) x
  LOOP
    v_left := it.qty;
    FOR ln IN
      SELECT oi.id, oi.quantity, oi.internal_product_id,
             oi.quantity - COALESCE((
               SELECT sum(ri.quantity) FROM public.channel_return_items ri JOIN public.channel_returns rr ON rr.id = ri.return_id
               WHERE ri.channel_order_item_id = oi.id AND rr.id <> v_return_id AND COALESCE(rr.status, '') <> 'CANCELLED'
             ), 0) AS room
      FROM public.channel_order_items oi
      WHERE oi.order_id = p_order_id
        AND oi.external_item_id = it.item_id
        AND COALESCE(NULLIF(oi.external_model_id, ''), '0') = COALESCE(it.model_id, '0')
      ORDER BY oi.provider_line_key, oi.id
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_left, GREATEST(ln.room, 0));
      CONTINUE WHEN v_take <= 0;
      SELECT COALESCE(sum(rs.order_quantity) FILTER (WHERE rs.cogs_component_id IS NULL), 0)
             + COALESCE(max(rs.order_quantity) FILTER (WHERE rs.cogs_component_id IS NOT NULL), 0)
      INTO v_restocked
      FROM public.channel_return_restocks rs JOIN public.channel_return_items ri ON ri.id = rs.return_item_id
      WHERE ri.return_id = v_return_id AND ri.channel_order_item_id = ln.id AND rs.reversed_at IS NULL;
      v_take := GREATEST(v_take, v_restocked);
      INSERT INTO public.channel_return_items AS ri
        (return_id, external_item_id, external_model_id, internal_product_id, item_sku, variation_sku, item_name, quantity, refund_amount, channel_order_item_id)
      VALUES (v_return_id, it.item_id, it.model_id, ln.internal_product_id, it.item_sku, it.variation_sku, it.item_name, v_take, it.refund, ln.id)
      ON CONFLICT (return_id, external_item_id, COALESCE(external_model_id, ''), COALESCE(channel_order_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET quantity = EXCLUDED.quantity, refund_amount = EXCLUDED.refund_amount, item_sku = EXCLUDED.item_sku,
                    variation_sku = EXCLUDED.variation_sku, item_name = EXCLUDED.item_name
      RETURNING id INTO v_row;
      v_keep := v_keep || v_row;
      v_left := v_left - v_take;
      v_items := v_items + 1;
    END LOOP;
    IF v_left > 0 THEN
      -- no (remaining) original line for this unit: kept visible, never restockable
      INSERT INTO public.channel_return_items AS ri
        (return_id, external_item_id, external_model_id, internal_product_id, item_sku, variation_sku, item_name, quantity, refund_amount, channel_order_item_id)
      VALUES (v_return_id, it.item_id, it.model_id, NULL, it.item_sku, it.variation_sku, it.item_name, v_left, it.refund, NULL)
      ON CONFLICT (return_id, external_item_id, COALESCE(external_model_id, ''), COALESCE(channel_order_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET quantity = EXCLUDED.quantity, refund_amount = EXCLUDED.refund_amount
      RETURNING id INTO v_row;
      v_keep := v_keep || v_row;
      v_unmatched := v_unmatched + 1;
    END IF;
  END LOOP;

  -- items the provider no longer lists: removed unless they carry inventory history
  DELETE FROM public.channel_return_items ri
  WHERE ri.return_id = v_return_id AND NOT (ri.id = ANY (v_keep))
    AND NOT EXISTS (SELECT 1 FROM public.channel_return_restocks rs WHERE rs.return_item_id = ri.id)
    AND NOT EXISTS (SELECT 1 FROM public.channel_return_disposition_events e WHERE e.return_item_id = ri.id);

  PERFORM public.recalculate_return_adjusted_financials(p_order_id);
  RETURN jsonb_build_object('return_id', v_return_id, 'created', v_created, 'items', v_items, 'unmatched', v_unmatched);
END;
$$;


-- ============================================================
-- F. Disposition → inventory (centralized, transactional)
-- ============================================================
-- Restock: return_in per atomic product at the ORIGINAL snapshot cost.
CREATE OR REPLACE FUNCTION public.apply_return_inventory_effect(p_return_item_id uuid, p_by uuid) RETURNS numeric
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  ri        record;
  oi        record;
  c         record;
  o         record;
  v_done    numeric;
  v_id      uuid;
  v_total   numeric := 0;
  v_cost    numeric;
BEGIN
  SELECT * INTO ri FROM public.channel_return_items WHERE id = p_return_item_id;
  IF ri.channel_order_item_id IS NULL THEN
    RAISE EXCEPTION 'Dòng trả hàng không khớp dòng đơn gốc — không nhập lại kho được.' USING ERRCODE = 'RT001';
  END IF;
  -- serialize every restock of this order line (cumulative guard)
  SELECT id, order_id, quantity, internal_product_id, cost_per_unit_snapshot, total_cogs, cogs_reversed_at, cost_method, provider_line_key
  INTO oi FROM public.channel_order_items WHERE id = ri.channel_order_item_id FOR UPDATE;
  IF oi.cogs_reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Đơn đã huỷ và đã hoàn kho — không nhập lại lần nữa.' USING ERRCODE = 'RT002';
  END IF;
  IF oi.total_cogs IS NULL THEN
    RAISE EXCEPTION 'Dòng đơn chưa có giá vốn gốc — chưa nhập lại kho được (cần COGS snapshot).' USING ERRCODE = 'RT003';
  END IF;
  SELECT COALESCE(sum(x.oq), 0) INTO v_done FROM (
    SELECT rs.return_item_id, max(rs.order_quantity) AS oq
    FROM public.channel_return_restocks rs
    WHERE rs.channel_order_item_id = oi.id AND rs.reversed_at IS NULL AND rs.return_item_id <> ri.id
    GROUP BY rs.return_item_id
  ) x;
  IF v_done + ri.quantity > oi.quantity THEN
    RAISE EXCEPTION 'Tổng số lượng nhập lại (%) vượt số lượng đã bán (%).', v_done + ri.quantity, oi.quantity USING ERRCODE = 'RT004';
  END IF;
  SELECT ord.external_order_sn, r.external_return_sn INTO o
  FROM public.channel_orders ord JOIN public.channel_returns r ON r.order_id = ord.id WHERE ord.id = oi.order_id AND r.id = ri.return_id;

  IF EXISTS (SELECT 1 FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = oi.id) THEN
    FOR c IN SELECT * FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = oi.id ORDER BY component_product_id LOOP
      PERFORM public.cost_lock_state(c.component_product_id);
    END LOOP;
    FOR c IN SELECT * FROM public.channel_order_item_cogs_components WHERE channel_order_item_id = oi.id ORDER BY component_product_id LOOP
      IF EXISTS (SELECT 1 FROM public.channel_return_restocks WHERE return_item_id = ri.id AND product_id = c.component_product_id AND reversed_at IS NULL) THEN
        CONTINUE;
      END IF;
      v_cost := public.cost_round_money(public.cost_round_qty(c.component_quantity_per_combo * ri.quantity) * c.cost_per_unit_snapshot);
      INSERT INTO public.channel_return_restocks
        (return_item_id, channel_order_item_id, product_id, cogs_component_id, order_quantity, quantity, unit_cost, total_cost, restocked_by)
      VALUES (ri.id, oi.id, c.component_product_id, c.id, ri.quantity, public.cost_round_qty(c.component_quantity_per_combo * ri.quantity), c.cost_per_unit_snapshot, v_cost, p_by)
      RETURNING id INTO v_id;
      INSERT INTO public.inventory_cost_ledger
        (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change, unit_cost, note, metadata)
      VALUES (c.component_product_id, 'return_in', 'channel_return_restock', v_id, o.external_return_sn, now(),
              '4|' || o.external_order_sn || '|' || o.external_return_sn || '|' || c.component_sku_snapshot || '|' || v_id::text,
              public.cost_round_qty(c.component_quantity_per_combo * ri.quantity), c.cost_per_unit_snapshot,
              'Trả hàng (combo) — nhập lại kho theo giá vốn thành phần gốc',
              jsonb_build_object('return_item_id', ri.id, 'order_item_id', oi.id, 'combo_product_id', c.combo_product_id, 'cogs_component_id', c.id))
      ON CONFLICT (source_type, source_id, event_type) WHERE source_id IS NOT NULL DO NOTHING;
      PERFORM public.cost_replay_product(c.component_product_id);
      v_total := v_total + v_cost;
    END LOOP;
  ELSE
    IF EXISTS (SELECT 1 FROM public.channel_return_restocks WHERE return_item_id = ri.id AND product_id = oi.internal_product_id AND reversed_at IS NULL) THEN
      RETURN 0;
    END IF;
    PERFORM public.cost_lock_state(oi.internal_product_id);
    v_cost := public.cost_round_money(ri.quantity * oi.cost_per_unit_snapshot);
    INSERT INTO public.channel_return_restocks
      (return_item_id, channel_order_item_id, product_id, cogs_component_id, order_quantity, quantity, unit_cost, total_cost, restocked_by)
    VALUES (ri.id, oi.id, oi.internal_product_id, NULL, ri.quantity, ri.quantity, oi.cost_per_unit_snapshot, v_cost, p_by)
    RETURNING id INTO v_id;
    INSERT INTO public.inventory_cost_ledger
      (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change, unit_cost, note, metadata)
    VALUES (oi.internal_product_id, 'return_in', 'channel_return_restock', v_id, o.external_return_sn, now(),
            '4|' || o.external_order_sn || '|' || o.external_return_sn || '|' || v_id::text,
            ri.quantity, oi.cost_per_unit_snapshot,
            'Trả hàng — nhập lại kho theo giá vốn gốc của đơn',
            jsonb_build_object('return_item_id', ri.id, 'order_item_id', oi.id))
    ON CONFLICT (source_type, source_id, event_type) WHERE source_id IS NOT NULL DO NOTHING;
    PERFORM public.cost_replay_product(oi.internal_product_id);
    v_total := v_cost;
  END IF;
  RETURN v_total;
END;
$$;

-- Leaving 'restock': compensating adjustment_out of every active episode.
CREATE OR REPLACE FUNCTION public.reverse_return_inventory_effect(p_return_item_id uuid, p_by uuid) RETURNS numeric
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  rs      record;
  v_total numeric := 0;
BEGIN
  FOR rs IN SELECT product_id FROM public.channel_return_restocks WHERE return_item_id = p_return_item_id AND reversed_at IS NULL ORDER BY product_id LOOP
    PERFORM public.cost_lock_state(rs.product_id);
  END LOOP;
  FOR rs IN
    SELECT s.*, r.external_return_sn
    FROM public.channel_return_restocks s
    JOIN public.channel_return_items ri ON ri.id = s.return_item_id
    JOIN public.channel_returns r ON r.id = ri.return_id
    WHERE s.return_item_id = p_return_item_id AND s.reversed_at IS NULL
    ORDER BY s.product_id
    FOR UPDATE OF s
  LOOP
    INSERT INTO public.inventory_cost_ledger
      (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change, unit_cost, note, metadata)
    VALUES (rs.product_id, 'adjustment_out', 'channel_return_restock', rs.id, rs.external_return_sn, now(),
            '5|' || rs.external_return_sn || '|' || rs.id::text, -rs.quantity, rs.unit_cost,
            'Huỷ nhập lại kho hàng trả (đổi xử lý) — theo giá vốn gốc',
            jsonb_build_object('return_item_id', rs.return_item_id, 'order_item_id', rs.channel_order_item_id))
    ON CONFLICT (source_type, source_id, event_type) WHERE source_id IS NOT NULL DO NOTHING;
    UPDATE public.channel_return_restocks SET reversed_at = now(), reversed_by = p_by WHERE id = rs.id;
    PERFORM public.cost_replay_product(rs.product_id);
    v_total := v_total + rs.total_cost;
  END LOOP;
  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_return_item_disposition(p_return_item_id uuid, p_disposition text, p_reason text, p_by uuid)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  ri       record;
  v_old    text;
  v_effect text := 'none';
  v_delta  numeric := 0;
  v_order  uuid;
  v_fin    jsonb;
BEGIN
  IF p_disposition NOT IN ('pending', 'restock', 'damaged', 'lost', 'disposed') THEN
    RAISE EXCEPTION 'Cách xử lý không hợp lệ.' USING ERRCODE = 'RT010';
  END IF;
  SELECT i.id, i.inventory_disposition, i.channel_order_item_id, r.order_id
  INTO ri
  FROM public.channel_return_items i JOIN public.channel_returns r ON r.id = i.return_id
  WHERE i.id = p_return_item_id
  FOR UPDATE OF i;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy dòng trả hàng.' USING ERRCODE = 'RT011'; END IF;
  v_old := ri.inventory_disposition;
  v_order := ri.order_id;
  IF v_old = p_disposition THEN
    RETURN jsonb_build_object('changed', false, 'disposition', v_old, 'inventory_effect', 'none', 'cogs_delta', '0');
  END IF;

  IF p_disposition = 'restock' THEN
    v_delta := public.apply_return_inventory_effect(ri.id, p_by);
    v_effect := 'restocked';
  ELSIF v_old = 'restock' THEN
    v_delta := -public.reverse_return_inventory_effect(ri.id, p_by);
    v_effect := 'restock_reversed';
  END IF;

  UPDATE public.channel_return_items
  SET inventory_disposition = p_disposition, disposition_changed_at = now(), disposition_changed_by = p_by
  WHERE id = ri.id;
  INSERT INTO public.channel_return_disposition_events (return_item_id, old_disposition, new_disposition, reason, inventory_effect, cogs_delta, changed_by)
  VALUES (ri.id, v_old, p_disposition, NULLIF(btrim(p_reason), ''), v_effect, v_delta, p_by);
  v_fin := public.recalculate_return_adjusted_financials(v_order);
  RETURN jsonb_build_object('changed', true, 'old', v_old, 'disposition', p_disposition, 'inventory_effect', v_effect, 'cogs_delta', v_delta::text,
                            'reversed_cogs', v_fin ->> 'reversed_cogs');
END;
$$;


-- ============================================================
-- G. Read model for the returns screens
-- ============================================================
CREATE OR REPLACE VIEW public.v_channel_return_summary
WITH (security_invoker = true)
AS
SELECT
  r.id                       AS return_id,
  r.shop_id,
  s.shop_name,
  r.order_id,
  o.external_order_sn,
  r.external_return_sn,
  r.status,
  r.is_terminal,
  r.reason,
  r.text_reason,
  r.refund_amount::text      AS refund_amount,
  r.seller_compensation_amount::text AS seller_compensation_amount,
  r.currency,
  r.created_at_channel,
  r.updated_at_channel,
  r.last_synced_at,
  COALESCE(i.item_rows, 0)   AS item_rows,
  i.total_quantity::text     AS total_quantity,
  COALESCE(i.pending_rows, 0) AS pending_rows,
  COALESCE(i.restock_rows, 0) AS restock_rows,
  COALESCE(i.unmatched_rows, 0) AS unmatched_rows,
  i.dispositions,
  COALESCE(rs.reversed_cogs, 0)::text AS reversed_cogs,
  o.financial_status,
  f.actual_shopee_income::text AS actual_shopee_income
FROM public.channel_returns r
JOIN public.shops s ON s.id = r.shop_id
JOIN public.channel_orders o ON o.id = r.order_id
LEFT JOIN public.order_financials f ON f.order_id = r.order_id
LEFT JOIN LATERAL (
  SELECT count(*) AS item_rows, sum(ri.quantity) AS total_quantity,
         count(*) FILTER (WHERE ri.inventory_disposition = 'pending') AS pending_rows,
         count(*) FILTER (WHERE ri.inventory_disposition = 'restock') AS restock_rows,
         count(*) FILTER (WHERE ri.channel_order_item_id IS NULL) AS unmatched_rows,
         array_agg(DISTINCT ri.inventory_disposition) AS dispositions
  FROM public.channel_return_items ri WHERE ri.return_id = r.id
) i ON true
LEFT JOIN LATERAL (
  SELECT sum(x.total_cost) AS reversed_cogs
  FROM public.channel_return_restocks x JOIN public.channel_return_items ri ON ri.id = x.return_item_id
  WHERE ri.return_id = r.id AND x.reversed_at IS NULL
) rs ON true;

REVOKE ALL ON public.v_channel_return_summary FROM anon;
GRANT SELECT ON public.v_channel_return_summary TO authenticated, service_role;


-- ============================================================
-- H. Privileges (cloud has no default EXECUTE grants — explicit, always)
-- ============================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'recalculate_return_adjusted_financials(uuid)',
    'apply_channel_return(uuid, uuid, jsonb, jsonb, timestamptz)',
    'apply_return_inventory_effect(uuid, uuid)', 'reverse_return_inventory_effect(uuid, uuid)',
    'set_return_item_disposition(uuid, text, text, uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.cost_replay_product(uuid) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.derive_order_financials() TO service_role';
END;
$$;

NOTIFY pgrst, 'reload schema';
