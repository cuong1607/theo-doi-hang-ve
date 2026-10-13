-- ============================================================
-- PHASE SHOPEE-4: inventory cost ledger + Moving Weighted Average COGS.
--
-- ALL cost arithmetic happens here, in PostgreSQL NUMERIC, inside
-- transactions with row locks — exact decimals, no JS floating point, no
-- race between "read average" and "write ledger". The app only calls these
-- functions and reads results as text.
--
-- Model (see docs/shopee-financial-core.md "Inventory Cost & COGS Engine"):
--   inventory_cost_ledger  every cost event of an internal product (history)
--   product_cost_state     current position per product (fast reads)
--   Receipt item ─► purchase_in ─► state ─► order item sale_out ─► COGS snapshot
--
-- Deterministic ordering: events of a product are always evaluated in
--   (event_time, order_key, id) order. An event arriving "in the past"
--   (back-dated receipt, old order synced late) is inserted at its place and
--   the product is REPLAYED, so the moving average never depends on arrival
--   order. Replay rewrites ledger before/after columns (the ledger is the
--   current reconstruction) but NEVER order item COGS snapshots.
--
-- Rounding (centralised): cost_round_cost / cost_round_qty = 4 dp,
--   cost_round_money = 2 dp.
-- Negative inventory: allowed and flagged; a sale with no known average is
--   NOT posted (no fake cost) and stays "COGS chưa tính".
-- ============================================================

-- ------------------------------------------------------------
-- 1. Rounding helpers (the one place rounding is defined)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cost_round_cost(v numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT round(v, 4) $$;
CREATE OR REPLACE FUNCTION public.cost_round_qty(v numeric)  RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT round(v, 4) $$;
CREATE OR REPLACE FUNCTION public.cost_round_money(v numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT round(v, 2) $$;

-- Order statuses that move goods out of costing inventory (single source of
-- truth; mirrored by isOrderEligibleForInventoryOut() and tested for parity).
CREATE OR REPLACE FUNCTION public.cost_order_status_eligible(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status IN ('READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED')
$$;


-- ------------------------------------------------------------
-- 2. Tables
-- ------------------------------------------------------------
CREATE TABLE public.inventory_cost_ledger (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid          NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  event_type          text          NOT NULL CHECK (event_type IN (
                                      'opening_balance', 'purchase_in', 'sale_out', 'sale_reversal_in',
                                      'return_in', 'adjustment_in', 'adjustment_out'
                                    )),
  source_type         text          NOT NULL CHECK (source_type IN (
                                      'receipt_item', 'channel_order_item', 'manual_adjustment', 'opening_balance', 'return_item'
                                    )),
  -- Logical reference to the source row (polymorphic → no FK; integrity is
  -- enforced by the functions below + the unique index).
  source_id           uuid,
  source_external_id  text,
  event_time          timestamptz   NOT NULL,
  -- Deterministic tie-break inside the same event_time (see docs).
  order_key           text          NOT NULL,
  quantity_change     numeric(18,4) NOT NULL CHECK (quantity_change <> 0),
  unit_cost           numeric(18,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  movement_cost       numeric(18,2),
  qty_before          numeric(18,4) NOT NULL DEFAULT 0,
  qty_after           numeric(18,4) NOT NULL DEFAULT 0,
  avg_cost_before     numeric(18,4),
  avg_cost_after      numeric(18,4),
  note                text,
  metadata            jsonb,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  -- IN events carry their own (known) unit cost; OUT events are valued at the average.
  CONSTRAINT inventory_cost_ledger_direction CHECK (
    (event_type IN ('opening_balance', 'purchase_in', 'sale_reversal_in', 'return_in', 'adjustment_in')
       AND quantity_change > 0 AND unit_cost IS NOT NULL)
    OR (event_type IN ('sale_out', 'adjustment_out') AND quantity_change < 0)
  )
);

-- Idempotency: one event of a given type per source row. Partial (source_id
-- NOT NULL) because NULLs are distinct in a unique index — manual events
-- without a source are never deduplicated by accident.
CREATE UNIQUE INDEX uq_inventory_cost_ledger_source
  ON public.inventory_cost_ledger (source_type, source_id, event_type)
  WHERE source_id IS NOT NULL;
CREATE INDEX idx_inventory_cost_ledger_order ON public.inventory_cost_ledger (product_id, event_time, order_key, id);
CREATE INDEX idx_inventory_cost_ledger_event_time ON public.inventory_cost_ledger (event_time);
CREATE INDEX idx_inventory_cost_ledger_event_type ON public.inventory_cost_ledger (event_type);
CREATE INDEX idx_inventory_cost_ledger_source_type ON public.inventory_cost_ledger (source_type);
CREATE INDEX idx_inventory_cost_ledger_source_id ON public.inventory_cost_ledger (source_id);

CREATE TABLE public.product_cost_state (
  product_id            uuid          PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  -- COSTING quantity (known receipts − posted sales), NOT verified physical stock.
  quantity_on_hand      numeric(18,4) NOT NULL DEFAULT 0,
  moving_average_cost   numeric(18,4),
  inventory_value       numeric(18,2) NOT NULL DEFAULT 0,
  last_ledger_event_id  uuid          REFERENCES public.inventory_cost_ledger(id) ON DELETE SET NULL,
  last_event_time       timestamptz,
  -- Set when an automatic recalculation failed (the receipt itself was still saved).
  needs_rebuild         boolean       NOT NULL DEFAULT false,
  last_error            text,
  updated_at            timestamptz   NOT NULL DEFAULT now()
);

-- Audit of every recalculation (automatic or manual).
CREATE TABLE public.inventory_cost_rebuilds (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  reason           text        NOT NULL,
  triggered_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  purchase_events  integer     NOT NULL,
  total_events     integer     NOT NULL,
  state_before     jsonb,
  state_after      jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_cost_rebuilds_product ON public.inventory_cost_rebuilds (product_id, created_at DESC);

-- Order item: cancellation reversal marker (the original snapshot stays).
ALTER TABLE public.channel_order_items ADD COLUMN cogs_reversed_at timestamptz;


-- ------------------------------------------------------------
-- 3. Privileges / RLS: readable by active users, written only by functions
-- ------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_cost_ledger', 'product_cost_state', 'inventory_cost_rebuilds'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('CREATE POLICY active_users_select ON public.%I FOR SELECT TO authenticated USING (public.is_active_user())', t);
  END LOOP;
END;
$$;


-- ------------------------------------------------------------
-- 4. Core: lock + replay
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cost_lock_state(p_product_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  INSERT INTO public.product_cost_state (product_id) VALUES (p_product_id) ON CONFLICT (product_id) DO NOTHING;
  PERFORM 1 FROM public.product_cost_state WHERE product_id = p_product_id FOR UPDATE;
END;
$$;

-- Re-evaluates every event of the product in deterministic order and writes
-- the running position. Caller MUST hold the state row lock (cost_lock_state).
--   IN  (unit cost c): if position ≤ 0 or no average → average restarts at c
--                      (the negative units were already costed out);
--                      else avg = round((q·avg + in·c) / (q + in), 4)
--   OUT:               cost = avg (unchanged); NULL avg → NULL cost, qty still moves
CREATE OR REPLACE FUNCTION public.cost_replay_product(p_product_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r       record;
  v_q     numeric := 0;
  v_avg   numeric := NULL;
  v_new_q numeric;
  v_new_a numeric;
  v_mv    numeric;
  v_last  uuid;
  v_lastt timestamptz;
BEGIN
  FOR r IN
    SELECT id, quantity_change, unit_cost, event_time, metadata
    FROM public.inventory_cost_ledger
    WHERE product_id = p_product_id
    ORDER BY event_time, order_key, id
  LOOP
    v_new_q := public.cost_round_qty(v_q + r.quantity_change);
    IF r.quantity_change > 0 THEN
      IF v_q <= 0 OR v_avg IS NULL THEN
        v_new_a := public.cost_round_cost(r.unit_cost);
      ELSE
        v_new_a := public.cost_round_cost((v_q * v_avg + r.quantity_change * r.unit_cost) / v_new_q);
      END IF;
      v_mv := public.cost_round_money(r.quantity_change * r.unit_cost);
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
          metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object('negative_inventory', v_new_q < 0)
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
      last_ledger_event_id = v_last,
      last_event_time = v_lastt,
      needs_rebuild = false,
      last_error = NULL,
      updated_at = now()
  WHERE product_id = p_product_id;
END;
$$;


-- ------------------------------------------------------------
-- 5. Purchases from receipts
--   event_time = receipt_date 00:00 Asia/Ho_Chi_Minh (a day's purchases count
--   before that day's sales); order_key = "1|receipt.created_at|item.created_at|item.id"
--   → receipt_date, receipt.created_at, item.created_at, item.id ordering.
--   Quantity = received_qty, unit cost = receipt_items.unit_price.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cost_sync_purchases(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM public.inventory_cost_ledger l
  WHERE l.product_id = p_product_id
    AND l.event_type = 'purchase_in'
    AND NOT EXISTS (
      SELECT 1 FROM public.receipt_items ri
      WHERE ri.id = l.source_id AND ri.product_id = p_product_id AND ri.received_qty > 0
    );

  INSERT INTO public.inventory_cost_ledger
    (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change, unit_cost)
  SELECT
    p_product_id, 'purchase_in', 'receipt_item', ri.id, r.receipt_no,
    (r.receipt_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'),
    '1|' || to_char(r.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') || '|' ||
      to_char(ri.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') || '|' || ri.id::text,
    ri.received_qty, ri.unit_price
  FROM public.receipt_items ri
  JOIN public.receipts r ON r.id = ri.receipt_id
  WHERE ri.product_id = p_product_id AND ri.received_qty > 0
  ON CONFLICT (source_type, source_id, event_type) WHERE source_id IS NOT NULL
  DO UPDATE SET
    product_id = EXCLUDED.product_id,
    source_external_id = EXCLUDED.source_external_id,
    event_time = EXCLUDED.event_time,
    order_key = EXCLUDED.order_key,
    quantity_change = EXCLUDED.quantity_change,
    unit_cost = EXCLUDED.unit_cost;

  SELECT count(*) INTO v_count FROM public.inventory_cost_ledger WHERE product_id = p_product_id AND event_type = 'purchase_in';
  RETURN v_count;
END;
$$;

-- Rebuild = re-derive purchase events from receipts + replay everything.
-- Sales / reversals / manual events are kept (they are their own sources).
-- Order item COGS snapshots are never touched.
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
  SELECT count(*) INTO v_total FROM public.inventory_cost_ledger WHERE product_id = p_product_id;
  SELECT to_jsonb(s) - 'updated_at' INTO v_after FROM public.product_cost_state s WHERE s.product_id = p_product_id;
  INSERT INTO public.inventory_cost_rebuilds (product_id, reason, triggered_by, purchase_events, total_events, state_before, state_after)
  VALUES (p_product_id, p_reason, p_triggered_by, v_purch, v_total, v_before, v_after);
  RETURN v_after;
END;
$$;

-- Used by triggers: a cost failure must never block saving a receipt. The
-- savepoint rolls back only the cost work; the product is flagged instead.
CREATE OR REPLACE FUNCTION public.cost_rebuild_product_safe(p_product_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  BEGIN
    PERFORM public.cost_rebuild_product(p_product_id, p_reason, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.product_cost_state (product_id) VALUES (p_product_id) ON CONFLICT (product_id) DO NOTHING;
    UPDATE public.product_cost_state SET needs_rebuild = true, last_error = left(SQLERRM, 500), updated_at = now()
    WHERE product_id = p_product_id;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_rebuild_all(p_triggered_by uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p uuid; n integer := 0;
BEGIN
  FOR p IN
    SELECT product_id FROM public.receipt_items
    UNION SELECT product_id FROM public.inventory_cost_ledger
    UNION SELECT product_id FROM public.product_cost_state
    ORDER BY 1
  LOOP
    PERFORM public.cost_rebuild_product(p, 'manual_rebuild_all', p_triggered_by);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- Explicit single receipt item posting (idempotent; same path as the trigger).
CREATE OR REPLACE FUNCTION public.cost_post_receipt_item(p_receipt_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_product uuid; v_qty numeric;
BEGIN
  SELECT product_id, received_qty INTO v_product, v_qty FROM public.receipt_items WHERE id = p_receipt_item_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_qty <= 0 THEN RETURN 'zero_quantity'; END IF;
  PERFORM public.cost_rebuild_product(v_product, 'post_receipt_item', NULL);
  RETURN 'posted';
END;
$$;


-- ------------------------------------------------------------
-- 6. Receipt triggers (statement level, transition tables)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cost_on_receipt_items_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR p IN SELECT DISTINCT product_id FROM new_rows ORDER BY 1 LOOP PERFORM public.cost_rebuild_product_safe(p, 'receipt_item_insert'); END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR p IN SELECT DISTINCT product_id FROM old_rows ORDER BY 1 LOOP PERFORM public.cost_rebuild_product_safe(p, 'receipt_item_delete'); END LOOP;
  ELSE
    FOR p IN
      SELECT DISTINCT x.product_id FROM (
        SELECT n.product_id FROM new_rows n JOIN old_rows o ON o.id = n.id
        WHERE (n.product_id, n.received_qty, n.unit_price) IS DISTINCT FROM (o.product_id, o.received_qty, o.unit_price)
        UNION
        SELECT o.product_id FROM new_rows n JOIN old_rows o ON o.id = n.id
        WHERE (n.product_id, n.received_qty, n.unit_price) IS DISTINCT FROM (o.product_id, o.received_qty, o.unit_price)
      ) x ORDER BY 1
    LOOP
      PERFORM public.cost_rebuild_product_safe(p, 'receipt_item_update');
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cost_receipt_items_insert AFTER INSERT ON public.receipt_items
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cost_on_receipt_items_change();
CREATE TRIGGER cost_receipt_items_update AFTER UPDATE ON public.receipt_items
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cost_on_receipt_items_change();
CREATE TRIGGER cost_receipt_items_delete AFTER DELETE ON public.receipt_items
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cost_on_receipt_items_change();

-- receipt_date / created_at drive event ordering → re-place that receipt's items.
CREATE OR REPLACE FUNCTION public.cost_on_receipt_date_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p uuid;
BEGIN
  IF NEW.receipt_date IS DISTINCT FROM OLD.receipt_date THEN
    FOR p IN SELECT DISTINCT product_id FROM public.receipt_items WHERE receipt_id = NEW.id ORDER BY 1 LOOP
      PERFORM public.cost_rebuild_product_safe(p, 'receipt_date_change');
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cost_receipt_date_change AFTER UPDATE OF receipt_date ON public.receipts
  FOR EACH ROW EXECUTE FUNCTION public.cost_on_receipt_date_change();


-- ------------------------------------------------------------
-- 7. Sales (order items) — COGS snapshot
--   costing moment = paid_at_channel ?? created_at_channel (?? now)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cost_apply_order_item(p_order_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v        record;
  v_led    uuid;
  v_avg    numeric;
  v_after  numeric;
BEGIN
  SELECT oi.id, oi.internal_product_id, oi.quantity, oi.total_cogs, oi.provider_line_key,
         o.order_status, o.external_order_sn, COALESCE(o.paid_at_channel, o.created_at_channel, now()) AS cost_time
  INTO v
  FROM public.channel_order_items oi
  JOIN public.channel_orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id
  FOR UPDATE OF oi;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.total_cogs IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.inventory_cost_ledger WHERE source_type = 'channel_order_item' AND source_id = v.id AND event_type = 'sale_out') THEN
    RETURN 'already';
  END IF;
  IF v.internal_product_id IS NULL THEN RETURN 'unmapped'; END IF;
  IF NOT public.cost_order_status_eligible(v.order_status) THEN RETURN 'ineligible'; END IF;

  PERFORM public.cost_lock_state(v.internal_product_id);
  INSERT INTO public.inventory_cost_ledger
    (product_id, event_type, source_type, source_id, source_external_id, event_time, order_key, quantity_change)
  VALUES
    (v.internal_product_id, 'sale_out', 'channel_order_item', v.id, v.external_order_sn, v.cost_time,
     '2|' || v.external_order_sn || '|' || COALESCE(v.provider_line_key, v.id::text), -v.quantity)
  RETURNING id INTO v_led;
  PERFORM public.cost_replay_product(v.internal_product_id);

  SELECT avg_cost_before, qty_after INTO v_avg, v_after FROM public.inventory_cost_ledger WHERE id = v_led;
  IF v_avg IS NULL THEN
    -- No known cost at this moment: post nothing, never a fake cost.
    DELETE FROM public.inventory_cost_ledger WHERE id = v_led;
    PERFORM public.cost_replay_product(v.internal_product_id);
    RETURN 'no_cost';
  END IF;

  UPDATE public.channel_order_items
  SET cost_method = 'moving_average',
      cost_per_unit_snapshot = v_avg,
      total_cogs = public.cost_round_money(v.quantity * v_avg),
      cogs_calculated_at = now()
  WHERE id = v.id;
  RETURN CASE WHEN v_after < 0 THEN 'calculated_negative' ELSE 'calculated' END;
END;
$$;

-- Cancellation: append a reversal IN at the item's ORIGINAL snapshot cost.
-- The sale_out event is never deleted; the snapshot stays (cogs_reversed_at set).
CREATE OR REPLACE FUNCTION public.cost_reverse_order_item(p_order_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v record;
BEGIN
  SELECT oi.id, oi.internal_product_id, oi.quantity, oi.cost_per_unit_snapshot, oi.cogs_reversed_at, oi.provider_line_key,
         o.external_order_sn, COALESCE(o.updated_at_channel, now()) AS rev_time,
         l.product_id AS ledger_product
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

-- Whole order: lock every involved product state in a stable order first
-- (no deadlock between concurrent orders), then post/reverse each line and
-- refresh order_financials.internal_cogs (only when EVERY line is costed).
CREATE OR REPLACE FUNCTION public.cost_process_order(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_status  text;
  v_item    record;
  v_result  text;
  v_counts  jsonb := '{}'::jsonb;
  v_p       uuid;
  v_lines   integer;
  v_costed  integer;
  v_sum     numeric;
BEGIN
  SELECT order_status INTO v_status FROM public.channel_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('not_found', 1); END IF;

  FOR v_p IN
    SELECT DISTINCT p FROM (
      SELECT internal_product_id AS p FROM public.channel_order_items WHERE order_id = p_order_id AND internal_product_id IS NOT NULL
      UNION SELECT l.product_id FROM public.inventory_cost_ledger l JOIN public.channel_order_items oi ON oi.id = l.source_id
        WHERE oi.order_id = p_order_id AND l.source_type = 'channel_order_item'
    ) x ORDER BY 1
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

  SELECT count(*), count(total_cogs), sum(total_cogs) FILTER (WHERE cogs_reversed_at IS NULL)
  INTO v_lines, v_costed, v_sum
  FROM public.channel_order_items WHERE order_id = p_order_id;
  IF v_lines > 0 AND v_costed = v_lines THEN
    INSERT INTO public.order_financials (order_id, internal_cogs) VALUES (p_order_id, COALESCE(v_sum, 0))
    ON CONFLICT (order_id) DO UPDATE SET internal_cogs = EXCLUDED.internal_cogs;
  ELSE
    UPDATE public.order_financials SET internal_cogs = NULL WHERE order_id = p_order_id AND internal_cogs IS NOT NULL;
  END IF;
  RETURN v_counts;
END;
$$;

-- Opening balance / manual adjustment (future baseline import; admin, server-side only).
CREATE OR REPLACE FUNCTION public.cost_post_manual_event(
  p_product_id uuid, p_event_type text, p_quantity numeric, p_unit_cost numeric, p_event_time timestamptz, p_note text
) RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_event_type NOT IN ('opening_balance', 'adjustment_in', 'adjustment_out') THEN
    RAISE EXCEPTION 'Loại sự kiện thủ công không hợp lệ: %', p_event_type;
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Số lượng phải > 0.'; END IF;
  PERFORM public.cost_lock_state(p_product_id);
  INSERT INTO public.inventory_cost_ledger
    (product_id, event_type, source_type, event_time, order_key, quantity_change, unit_cost, note)
  VALUES
    (p_product_id, p_event_type,
     CASE WHEN p_event_type = 'opening_balance' THEN 'opening_balance' ELSE 'manual_adjustment' END,
     p_event_time,
     CASE WHEN p_event_type = 'opening_balance' THEN '0|' ELSE '4|' END || gen_random_uuid()::text,
     CASE WHEN p_event_type = 'adjustment_out' THEN -p_quantity ELSE p_quantity END,
     CASE WHEN p_event_type = 'adjustment_out' THEN NULL ELSE p_unit_cost END,
     p_note)
  RETURNING id INTO v_id;
  PERFORM public.cost_replay_product(p_product_id);
  RETURN v_id;
END;
$$;


-- ------------------------------------------------------------
-- 8. COGS snapshot immutability on order items
--   Once costed, a line's product, quantity and cost fields cannot change
--   (CG001) and the line cannot be deleted on its own (CG002). Deleting the
--   whole order/shop still cascades (the parent row is already gone).
-- ------------------------------------------------------------
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
  IF OLD.cost_per_unit_snapshot IS NOT NULL AND (
       NEW.internal_product_id IS DISTINCT FROM OLD.internal_product_id
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.cost_method IS DISTINCT FROM OLD.cost_method
    OR NEW.cost_per_unit_snapshot IS DISTINCT FROM OLD.cost_per_unit_snapshot
    OR NEW.total_cogs IS DISTINCT FROM OLD.total_cogs
    OR NEW.cogs_calculated_at IS DISTINCT FROM OLD.cogs_calculated_at
  ) THEN
    RAISE EXCEPTION 'Giá vốn của dòng đơn đã được chốt — không được thay đổi.' USING ERRCODE = 'CG001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_order_item_cogs
  BEFORE UPDATE OR DELETE ON public.channel_order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_item_cogs();


-- ------------------------------------------------------------
-- 9. Function privileges: server (service_role) only
-- ------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'cost_lock_state(uuid)', 'cost_replay_product(uuid)', 'cost_sync_purchases(uuid)',
    'cost_rebuild_product(uuid, text, uuid)', 'cost_rebuild_product_safe(uuid, text)', 'cost_rebuild_all(uuid)',
    'cost_post_receipt_item(uuid)', 'cost_apply_order_item(uuid)', 'cost_reverse_order_item(uuid)',
    'cost_process_order(uuid)', 'cost_post_manual_event(uuid, text, numeric, numeric, timestamptz, text)',
    'cost_on_receipt_items_change()', 'cost_on_receipt_date_change()', 'guard_order_item_cogs()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'cost_rebuild_product(uuid, text, uuid)', 'cost_rebuild_all(uuid)', 'cost_post_receipt_item(uuid)',
    'cost_apply_order_item(uuid)', 'cost_reverse_order_item(uuid)', 'cost_process_order(uuid)',
    'cost_post_manual_event(uuid, text, numeric, numeric, timestamptz, text)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;


-- ------------------------------------------------------------
-- 10. Read models
-- ------------------------------------------------------------
CREATE VIEW public.v_product_cost_overview
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
     AND EXISTS (SELECT 1 FROM public.inventory_cost_ledger l WHERE l.product_id = p.id)) AS missing_cost
FROM public.products p
LEFT JOIN public.product_cost_state s ON s.product_id = p.id;

REVOKE ALL ON public.v_product_cost_overview FROM anon;
GRANT SELECT ON public.v_product_cost_overview TO authenticated, service_role;

-- Order summary: COGS readiness now reflects real costing.
--   complete   every line has total_cogs
--   partial    some lines
--   incomplete none (no mapping, no known cost, not yet posted)
-- total_cogs only when complete (excluding reversed lines); partial sum for diagnostics.
CREATE OR REPLACE VIEW public.v_channel_order_summary
WITH (security_invoker = true)
AS
WITH items AS (
  SELECT
    oi.order_id,
    count(*)                                                        AS line_count,
    count(*) FILTER (WHERE oi.internal_product_id IS NOT NULL)      AS mapped_lines,
    count(*) FILTER (WHERE oi.total_cogs IS NOT NULL)               AS costed_lines,
    count(*) FILTER (WHERE oi.discounted_unit_price IS NULL)        AS lines_missing_price,
    count(*) FILTER (WHERE oi.original_unit_price IS NULL)          AS lines_missing_original,
    sum(oi.quantity)                                                AS total_item_quantity,
    sum(oi.discounted_unit_price * oi.quantity)                     AS item_gross_value,
    sum(oi.original_unit_price * oi.quantity)                       AS original_item_value,
    sum(oi.total_cogs) FILTER (WHERE oi.cogs_reversed_at IS NULL)   AS cogs_sum,
    count(*) FILTER (WHERE oi.cogs_reversed_at IS NOT NULL)         AS reversed_lines
  FROM public.channel_order_items oi
  GROUP BY oi.order_id
)
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
  COALESCE(i.reversed_lines, 0) AS reversed_lines
FROM public.channel_orders o
JOIN public.shops s ON s.id = o.shop_id
LEFT JOIN items i ON i.order_id = o.id;
