-- ============================================================
-- PATCH FINANCIAL CORE: Shopee estimated order revenue + VAT-adjusted
-- purchase cost + estimated profit.
--
-- SCHEMA / FUNCTIONS ONLY. No business data is rewritten by this migration:
--   * estimated revenue fills in as the escrow job fetches (open orders) or
--     re-fetches (completed orders — FINANCIAL_CALCULATION_VERSION bump);
--   * the cost ledger switches to VAT-adjusted cost only when a product is
--     rebuilt (receipt change trigger, or the admin "Dựng lại sổ giá vốn");
--   * historical order COGS snapshots change ONLY through the explicit admin
--     restatement (cost_restate_order_cogs), with an audit row per line.
--
-- A. Shopee estimated order revenue ("Doanh thu đơn hàng ước tính")
--    = get_escrow_detail order_income.escrow_amount, taken directly from
--    Shopee (no fee re-estimation):
--      open orders      fetched by the escrow job in estimate-only mode
--                       (apply_order_estimated_revenue) — never touches the
--                       actual settlement columns / components / status
--      completed orders fallback when no estimate was captured before
--                       completion: the escrow_amount of the settlement
--                       fetch (source 'escrow_settlement'); an existing
--                       estimate is NEVER overwritten by the actual value
--    estimated_profit = estimated_order_revenue − internal_cogs
--    margin           = estimated_profit / channel_total_amount × 100
--                       (in v_channel_order_summary — needs the order total)
--
-- B. VAT-adjusted purchase cost (cost_sync_purchases)
--    receipt_items.unit_price is the PRE-VAT acquisition price (it is the
--    invoice line price a "from receipts" invoice adds VAT on top of; manual
--    company invoices carry the same pre-VAT prices — checked on production
--    data). It is never mutated. Per receipt item:
--      household supplier                    unit_cost = unit_price          (raw)
--      company + day linked to an invoice    unit_cost = unit_price × (1 + invoice.vat_rate/100)
--                                            (invoice_vat — VAT snapshot of THAT invoice)
--      company, no linked invoice            unit_cost = NULL                (vat_pending)
--    The only explicit receipt → invoice mapping is invoice_receipt_days
--    (supplier, receipt day). No date/price heuristics, no default 8 %.
--    A vat_pending purchase makes the moving average UNKNOWN while those
--    units are in the position; sales in that window post their quantity
--    but get no COGS ("cost_pending") until the invoice is linked — then the
--    rebuild fills them in (first fill, not a restatement).
--
-- C. Historical COGS restatement (admin, explicit, audited)
--    cost_restatement_candidates / _summary (dry-run) and
--    cost_restate_order_cogs (apply). guard_order_item_cogs lets ONLY that
--    function rewrite a locked snapshot (transaction-local flag).
--
-- Versions: costing moving-average-v2-vat (channel_order_items.cost_version),
-- financial shopee-fin-v3 (app constant).
-- ============================================================


-- ============================================================
-- A. ESTIMATED ORDER REVENUE
-- ============================================================
ALTER TABLE public.order_financials
  ADD COLUMN estimated_order_revenue      numeric(18,2),
  ADD COLUMN estimated_revenue_source     text CHECK (estimated_revenue_source IN ('escrow_estimate', 'escrow_settlement')),
  ADD COLUMN estimated_revenue_synced_at  timestamptz,
  ADD COLUMN estimate_last_attempt_at     timestamptz,
  ADD COLUMN estimate_last_error_code     text,
  ADD COLUMN estimate_last_error_message  text;

COMMENT ON COLUMN public.order_financials.estimated_order_revenue IS
  'Shopee "Doanh thu đơn hàng ước tính" = get_escrow_detail order_income.escrow_amount. Taken from Shopee, never re-estimated. NULL = not known.';

-- derive_order_financials (00047) + estimated revenue fallback + estimated profit.
CREATE OR REPLACE FUNCTION public.derive_order_financials() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_income   numeric := COALESCE(NEW.escrow_amount_after_adjustment, NEW.escrow_amount);
  v_currency text;
BEGIN
  -- Completed order fetched without a prior estimate: Shopee's escrow_amount
  -- is the best estimate available. Never replaces an existing estimate.
  IF NEW.estimated_order_revenue IS NULL AND NEW.escrow_amount IS NOT NULL THEN
    NEW.estimated_order_revenue := NEW.escrow_amount;
    NEW.estimated_revenue_source := 'escrow_settlement';
    NEW.estimated_revenue_synced_at := COALESCE(NEW.escrow_synced_at, now());
  END IF;
  NEW.estimated_profit := CASE WHEN NEW.estimated_order_revenue IS NOT NULL AND NEW.internal_cogs IS NOT NULL
                               THEN NEW.estimated_order_revenue - NEW.internal_cogs END;
  -- The margin needs channel_total_amount (an order column) → computed in
  -- v_channel_order_summary (estimated_margin_pct); estimated_margin is not written.

  NEW.profit_after_cogs := CASE WHEN v_income IS NOT NULL AND NEW.internal_cogs IS NOT NULL THEN v_income - NEW.internal_cogs END;
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

-- Estimate-only write for an OPEN order. Touches only the estimate columns:
-- no components, no actual settlement, no financial_status. Once the order
-- has a settlement (escrow_synced_at) a late estimate is ignored.
-- Returns 'applied' | 'unchanged' | 'settled'.
CREATE OR REPLACE FUNCTION public.apply_order_estimated_revenue(p_order_id uuid, p_amount numeric, p_synced_at timestamptz)
RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_prev    numeric;
  v_settled timestamptz;
BEGIN
  IF p_amount IS NULL THEN RAISE EXCEPTION 'estimated revenue must not be NULL' USING ERRCODE = 'FN002'; END IF;
  PERFORM 1 FROM public.channel_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order % not found', p_order_id USING ERRCODE = 'FN001'; END IF;
  INSERT INTO public.order_financials (order_id) VALUES (p_order_id) ON CONFLICT (order_id) DO NOTHING;
  SELECT f.estimated_order_revenue, f.escrow_synced_at INTO v_prev, v_settled FROM public.order_financials f WHERE f.order_id = p_order_id;
  IF v_settled IS NOT NULL THEN
    UPDATE public.order_financials
    SET estimate_last_attempt_at = p_synced_at, estimate_last_error_code = NULL, estimate_last_error_message = NULL
    WHERE order_id = p_order_id;
    RETURN 'settled';
  END IF;
  UPDATE public.order_financials
  SET estimated_order_revenue = p_amount,
      estimated_revenue_source = 'escrow_estimate',
      estimated_revenue_synced_at = p_synced_at,
      estimate_last_attempt_at = p_synced_at,
      estimate_last_error_code = NULL,
      estimate_last_error_message = NULL
  WHERE order_id = p_order_id;
  RETURN CASE WHEN v_prev IS DISTINCT FROM p_amount THEN 'applied' ELSE 'unchanged' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_order_estimate_attempt(p_order_id uuid, p_error_code text, p_error_message text, p_at timestamptz)
RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  INSERT INTO public.order_financials (order_id) VALUES (p_order_id) ON CONFLICT (order_id) DO NOTHING;
  UPDATE public.order_financials
  SET estimate_last_attempt_at = p_at, estimate_last_error_code = p_error_code, estimate_last_error_message = left(p_error_message, 500)
  WHERE order_id = p_order_id;
END;
$$;

-- Open orders whose estimate is missing, stale or older than the order.
-- Never an order that already has its settlement (actual path owns it).
CREATE OR REPLACE FUNCTION public.get_orders_needing_escrow_estimate(
  p_shop_id                 uuid,
  p_limit                   integer,
  p_now                     timestamptz DEFAULT now(),
  p_statuses                text[] DEFAULT ARRAY['READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE'],
  p_refresh_interval_hours  integer DEFAULT 12,
  p_error_backoff_hours     integer DEFAULT 6
)
RETURNS TABLE (order_id uuid, external_order_sn text, reason text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT o.id, o.external_order_sn,
    CASE
      WHEN f.estimated_revenue_synced_at IS NULL THEN 'never_estimated'
      WHEN o.updated_at_channel > f.estimated_revenue_synced_at THEN 'order_changed'
      ELSE 'refresh_interval'
    END
  FROM public.channel_orders o
  LEFT JOIN public.order_financials f ON f.order_id = o.id
  WHERE o.shop_id = p_shop_id
    AND o.order_status = ANY (p_statuses)
    AND f.escrow_synced_at IS NULL
    AND (
      f.estimated_revenue_synced_at IS NULL
      OR o.updated_at_channel > f.estimated_revenue_synced_at
      OR f.estimated_revenue_synced_at < p_now - make_interval(hours => p_refresh_interval_hours)
    )
    AND NOT (
      f.estimate_last_error_code IS NOT NULL
      AND f.estimate_last_attempt_at > p_now - make_interval(hours => p_error_backoff_hours)
    )
  ORDER BY f.estimated_revenue_synced_at NULLS FIRST, o.created_at_channel DESC NULLS LAST
  LIMIT GREATEST(p_limit, 0)
$$;

CREATE OR REPLACE FUNCTION public.count_orders_needing_escrow_estimate(
  p_shop_id                 uuid,
  p_now                     timestamptz DEFAULT now(),
  p_statuses                text[] DEFAULT ARRAY['READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE'],
  p_refresh_interval_hours  integer DEFAULT 12,
  p_error_backoff_hours     integer DEFAULT 6
)
RETURNS bigint
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT count(*) FROM public.get_orders_needing_escrow_estimate(p_shop_id, 2147483647, p_now, p_statuses, p_refresh_interval_hours, p_error_backoff_hours)
$$;

REVOKE EXECUTE ON FUNCTION public.apply_order_estimated_revenue(uuid, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_order_estimate_attempt(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_orders_needing_escrow_estimate(uuid, integer, timestamptz, text[], integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.count_orders_needing_escrow_estimate(uuid, timestamptz, text[], integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_order_estimated_revenue(uuid, numeric, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_order_estimate_attempt(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_orders_needing_escrow_estimate(uuid, integer, timestamptz, text[], integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_orders_needing_escrow_estimate(uuid, timestamptz, text[], integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.derive_order_financials() TO service_role;


-- ============================================================
-- B. VAT-ADJUSTED PURCHASE COST
-- ============================================================
CREATE OR REPLACE FUNCTION public.cost_costing_version() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'moving-average-v2-vat'::text $$;

ALTER TABLE public.inventory_cost_ledger
  -- purchase audit: raw receipt price, VAT snapshot, how unit_cost was derived
  ADD COLUMN base_unit_cost numeric(18,4),
  ADD COLUMN vat_rate       numeric(5,2),
  ADD COLUMN cost_basis     text CHECK (cost_basis IS NULL OR cost_basis IN ('raw', 'invoice_vat', 'vat_pending')),
  ADD COLUMN invoice_id     uuid;

COMMENT ON COLUMN public.inventory_cost_ledger.cost_basis IS
  'purchase_in only: raw = receipt price (household) · invoice_vat = price × (1 + invoice VAT) · vat_pending = company receipt not linked to an invoice (cost unknown). NULL = posted before moving-average-v2-vat.';

ALTER TABLE public.inventory_cost_ledger DROP CONSTRAINT inventory_cost_ledger_direction;
ALTER TABLE public.inventory_cost_ledger ADD CONSTRAINT inventory_cost_ledger_direction CHECK (
  (event_type IN ('opening_balance', 'purchase_in', 'sale_reversal_in', 'return_in', 'adjustment_in')
     AND quantity_change > 0
     AND (unit_cost IS NOT NULL OR (event_type = 'purchase_in' AND cost_basis = 'vat_pending')))
  OR (event_type IN ('sale_out', 'adjustment_out') AND quantity_change < 0)
);
ALTER TABLE public.inventory_cost_ledger ADD CONSTRAINT inventory_cost_ledger_vat_pending_cost CHECK (
  cost_basis IS DISTINCT FROM 'vat_pending' OR unit_cost IS NULL
);

ALTER TABLE public.product_cost_state
  -- the current position holds VAT-pending units → moving average unknown
  ADD COLUMN vat_pending boolean NOT NULL DEFAULT false;

ALTER TABLE public.channel_order_items
  -- costing version that produced the snapshot (NULL = before moving-average-v2-vat)
  ADD COLUMN cost_version text;

-- Purchases from receipts with the VAT policy above. Recomputed from the RAW
-- receipt price every time → VAT can never be applied twice.
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
      WHEN inv.id IS NULL OR inv.vat_rate IS NULL THEN NULL
      ELSE public.cost_round_cost(ri.unit_price * (1 + inv.vat_rate / 100))
    END,
    ri.unit_price,
    CASE WHEN s.supplier_type = 'company' THEN inv.vat_rate END,
    CASE
      WHEN COALESCE(s.supplier_type, 'business_household') <> 'company' THEN 'raw'
      WHEN inv.id IS NULL OR inv.vat_rate IS NULL THEN 'vat_pending'
      ELSE 'invoice_vat'
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

-- Replay (00043) + VAT-pending units:
--   IN, cost unknown (vat_pending)  → average unknown ("pending") from here
--   IN, known cost, position ≤ 0    → average restarts at that cost (pending
--                                     units, if any, are already sold out)
--   IN, known cost, while pending   → average stays unknown
--   OUT                             → cost = average (NULL while pending);
--                                     metadata.cost_pending marks it
CREATE OR REPLACE FUNCTION public.cost_replay_product(p_product_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r       record;
  v_q     numeric := 0;
  v_avg   numeric := NULL;
  v_pend  boolean := false;
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
      IF r.unit_cost IS NULL THEN
        v_new_a := NULL;
        v_pend := true;
        v_mv := NULL;
      ELSIF v_q <= 0 OR (v_avg IS NULL AND NOT v_pend) THEN
        v_new_a := public.cost_round_cost(r.unit_cost);
        v_pend := false;
        v_mv := public.cost_round_money(r.quantity_change * r.unit_cost);
      ELSIF v_pend THEN
        v_new_a := NULL;
        v_mv := public.cost_round_money(r.quantity_change * r.unit_cost);
      ELSE
        v_new_a := public.cost_round_cost((v_q * v_avg + r.quantity_change * r.unit_cost) / v_new_q);
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
          metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object('negative_inventory', v_new_q < 0, 'cost_pending', v_pend)
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
      last_ledger_event_id = v_last,
      last_event_time = v_lastt,
      needs_rebuild = false,
      last_error = NULL,
      updated_at = now()
  WHERE product_id = p_product_id;
END;
$$;

-- internal_cogs of an order: only when EVERY line is costed (00043 rule).
CREATE OR REPLACE FUNCTION public.cost_refresh_order_cogs(p_order_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_lines  integer;
  v_costed integer;
  v_sum    numeric;
BEGIN
  SELECT count(*), count(total_cogs), sum(total_cogs) FILTER (WHERE cogs_reversed_at IS NULL)
  INTO v_lines, v_costed, v_sum
  FROM public.channel_order_items WHERE order_id = p_order_id;
  IF v_lines > 0 AND v_costed = v_lines THEN
    INSERT INTO public.order_financials (order_id, internal_cogs) VALUES (p_order_id, COALESCE(v_sum, 0))
    ON CONFLICT (order_id) DO UPDATE SET internal_cogs = EXCLUDED.internal_cogs
    WHERE public.order_financials.internal_cogs IS DISTINCT FROM EXCLUDED.internal_cogs;
  ELSE
    UPDATE public.order_financials SET internal_cogs = NULL WHERE order_id = p_order_id AND internal_cogs IS NOT NULL;
  END IF;
END;
$$;

-- Sale → COGS snapshot (00043) + VAT-pending sales:
--   'cost_pending'     sale posted (quantity moves) but its cost is unknown
--                      because VAT-pending units are in the position
--   'calculated_late'  a pending sale whose cost became known (invoice
--                      linked) gets its FIRST snapshot — not a restatement
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

  SELECT l.id, l.product_id, l.avg_cost_before INTO v_led
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
          cost_version = public.cost_costing_version()
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
      cost_version = public.cost_costing_version()
  WHERE id = v.id;
  RETURN CASE WHEN v_after < 0 THEN 'calculated_negative' ELSE 'calculated' END;
END;
$$;

-- Cancellation (00043) + a cancelled VAT-pending sale (never costed): its
-- sale_out is withdrawn instead of reversed at an unknown cost.
CREATE OR REPLACE FUNCTION public.cost_reverse_order_item(p_order_item_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v record;
BEGIN
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

  PERFORM public.cost_refresh_order_cogs(p_order_id);
  RETURN v_counts;
END;
$$;

-- After a rebuild: VAT-pending sales of the product whose cost is now known
-- get their first snapshot; their orders' internal_cogs is refreshed.
CREATE OR REPLACE FUNCTION public.cost_fill_pending_sales(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r       record;
  v_n     integer := 0;
  v_order uuid;
  v_orders uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR r IN
    SELECT oi.id, oi.order_id, oi.quantity, l.avg_cost_before
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
        cost_version = public.cost_costing_version()
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
  SELECT count(*) INTO v_total FROM public.inventory_cost_ledger WHERE product_id = p_product_id;
  SELECT to_jsonb(s) - 'updated_at' INTO v_after FROM public.product_cost_state s WHERE s.product_id = p_product_id;
  INSERT INTO public.inventory_cost_rebuilds (product_id, reason, triggered_by, purchase_events, total_events, state_before, state_after)
  VALUES (p_product_id, p_reason, p_triggered_by, v_purch, v_total, v_before, v_after);
  RETURN v_after;
END;
$$;

-- VAT inputs changed → rebuild the products received on the affected days.
-- SECURITY DEFINER: these tables are written by several server paths; the
-- rebuild must never fail on the caller's function privileges (00044).
CREATE OR REPLACE FUNCTION public.cost_on_invoice_days_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR p IN
      SELECT DISTINCT ri.product_id FROM new_rows d
      JOIN public.receipts r ON r.supplier_id = d.supplier_id AND r.receipt_date = d.receipt_date
      JOIN public.receipt_items ri ON ri.receipt_id = r.id
      ORDER BY 1
    LOOP PERFORM public.cost_rebuild_product_safe(p, 'invoice_link_insert'); END LOOP;
  ELSE
    FOR p IN
      SELECT DISTINCT ri.product_id FROM old_rows d
      JOIN public.receipts r ON r.supplier_id = d.supplier_id AND r.receipt_date = d.receipt_date
      JOIN public.receipt_items ri ON ri.receipt_id = r.id
      ORDER BY 1
    LOOP PERFORM public.cost_rebuild_product_safe(p, 'invoice_link_delete'); END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cost_invoice_days_insert AFTER INSERT ON public.invoice_receipt_days
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cost_on_invoice_days_change();
CREATE TRIGGER cost_invoice_days_delete AFTER DELETE ON public.invoice_receipt_days
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cost_on_invoice_days_change();

CREATE OR REPLACE FUNCTION public.cost_on_invoice_vat_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p uuid;
BEGIN
  FOR p IN
    SELECT DISTINCT ri.product_id FROM public.invoice_receipt_days d
    JOIN public.receipts r ON r.supplier_id = d.supplier_id AND r.receipt_date = d.receipt_date
    JOIN public.receipt_items ri ON ri.receipt_id = r.id
    WHERE d.invoice_id = NEW.id
    ORDER BY 1
  LOOP PERFORM public.cost_rebuild_product_safe(p, 'invoice_vat_change'); END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cost_invoice_vat_change AFTER UPDATE OF vat_rate ON public.invoices
  FOR EACH ROW WHEN (OLD.vat_rate IS DISTINCT FROM NEW.vat_rate) EXECUTE FUNCTION public.cost_on_invoice_vat_change();

CREATE OR REPLACE FUNCTION public.cost_on_supplier_type_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p uuid;
BEGIN
  FOR p IN
    SELECT DISTINCT ri.product_id FROM public.receipts r
    JOIN public.receipt_items ri ON ri.receipt_id = r.id
    WHERE r.supplier_id = NEW.id
    ORDER BY 1
  LOOP PERFORM public.cost_rebuild_product_safe(p, 'supplier_type_change'); END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cost_supplier_type_change AFTER UPDATE OF supplier_type ON public.suppliers
  FOR EACH ROW WHEN (OLD.supplier_type IS DISTINCT FROM NEW.supplier_type) EXECUTE FUNCTION public.cost_on_supplier_type_change();


-- ============================================================
-- C. HISTORICAL COGS RESTATEMENT (explicit, audited)
-- ============================================================
CREATE TABLE public.cogs_restatements (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid          NOT NULL,
  order_id           uuid          NOT NULL REFERENCES public.channel_orders(id) ON DELETE CASCADE,
  order_item_id      uuid          NOT NULL REFERENCES public.channel_order_items(id) ON DELETE CASCADE,
  product_id         uuid          REFERENCES public.products(id) ON DELETE SET NULL,
  old_cost_per_unit  numeric(18,4) NOT NULL,
  new_cost_per_unit  numeric(18,4) NOT NULL,
  old_total_cogs     numeric(18,2) NOT NULL,
  new_total_cogs     numeric(18,2) NOT NULL,
  old_cost_version   text,
  new_cost_version   text          NOT NULL,
  reason             text          NOT NULL CHECK (btrim(reason) <> ''),
  adjusted_by        uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  adjusted_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX idx_cogs_restatements_order ON public.cogs_restatements (order_id, adjusted_at DESC);
CREATE INDEX idx_cogs_restatements_batch ON public.cogs_restatements (batch_id);

ALTER TABLE public.cogs_restatements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cogs_restatements FROM anon, authenticated;
GRANT SELECT ON public.cogs_restatements TO authenticated;
GRANT SELECT, INSERT ON public.cogs_restatements TO service_role;
CREATE POLICY active_users_select ON public.cogs_restatements FOR SELECT TO authenticated USING (public.is_active_user());

-- Snapshot guard (00043) + the restatement path: only while
-- cost_restate_order_cogs runs (transaction-local flag) may a locked
-- snapshot change. Deleting a costed line stays forbidden.
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
     ) THEN
    RAISE EXCEPTION 'Giá vốn của dòng đơn đã được chốt — không được thay đổi.' USING ERRCODE = 'CG001';
  END IF;
  RETURN NEW;
END;
$$;

-- Dry-run: costed (not reversed) lines whose snapshot differs from what the
-- CURRENT ledger reconstruction gives at the same sale moment.
-- restatable = false → the new cost is not known (VAT pending).
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
    AND l.avg_cost_before IS DISTINCT FROM oi.cost_per_unit_snapshot
  ORDER BY o.created_at_channel DESC NULLS LAST, oi.id
  LIMIT GREATEST(p_limit, 0)
$$;

CREATE OR REPLACE FUNCTION public.cost_restatement_summary()
RETURNS TABLE (
  affected_lines    bigint,
  affected_orders   bigint,
  restatable_lines  bigint,
  pending_lines     bigint,
  old_total_cogs    text,
  new_total_cogs    text,
  difference        text
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT count(*),
         count(DISTINCT c.order_id),
         count(*) FILTER (WHERE c.restatable),
         count(*) FILTER (WHERE NOT c.restatable),
         COALESCE(sum(c.old_total_cogs::numeric) FILTER (WHERE c.restatable), 0)::text,
         COALESCE(sum(c.new_total_cogs::numeric) FILTER (WHERE c.restatable), 0)::text,
         COALESCE(sum(c.difference::numeric) FILTER (WHERE c.restatable), 0)::text
  FROM public.cost_restatement_candidates(2147483647) c
$$;

-- Apply: restates the given lines (re-checked here: still a restatable
-- candidate) to the current reconstruction, one audit row each, then
-- refreshes internal_cogs (→ estimated / actual profit via the trigger).
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
-- D. Privileges (cloud has no default EXECUTE grants — explicit, always)
-- ============================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'cost_costing_version()', 'cost_refresh_order_cogs(uuid)', 'cost_fill_pending_sales(uuid)',
    'cost_on_invoice_days_change()', 'cost_on_invoice_vat_change()', 'cost_on_supplier_type_change()',
    'cost_restatement_candidates(integer)', 'cost_restatement_summary()', 'cost_restate_order_cogs(uuid[], text, uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'cost_costing_version()', 'cost_refresh_order_cogs(uuid)', 'cost_fill_pending_sales(uuid)',
    'cost_restatement_candidates(integer)', 'cost_restatement_summary()', 'cost_restate_order_cogs(uuid[], text, uuid)',
    -- replaced bodies keep their grants; re-granted for clarity
    'cost_sync_purchases(uuid)', 'cost_replay_product(uuid)', 'cost_apply_order_item(uuid)', 'cost_reverse_order_item(uuid)',
    'cost_process_order(uuid)', 'cost_rebuild_product(uuid, text, uuid)', 'cost_rebuild_product_safe(uuid, text)', 'cost_lock_state(uuid)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;


-- ============================================================
-- E. Read models
-- ============================================================
-- 00043 view + vat_pending (appended).
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
  COALESCE(s.vat_pending, false)        AS vat_pending
FROM public.products p
LEFT JOIN public.product_cost_state s ON s.product_id = p.id;

REVOKE ALL ON public.v_product_cost_overview FROM anon;
GRANT SELECT ON public.v_product_cost_overview TO authenticated, service_role;

-- 00051 view: estimated profit now uses Shopee's estimated order revenue
-- (same column names/types), + estimated revenue columns appended.
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
  -- SHOPEE-5 financials (NULL = not known yet — never 0)
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
  -- Estimated profit = Shopee estimated order revenue − internal COGS
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
  f.estimated_revenue_synced_at
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
    count(*) FILTER (WHERE oi.cogs_reversed_at IS NOT NULL)         AS reversed_lines
  FROM public.channel_order_items oi
  WHERE oi.order_id = o.id
) i;

REVOKE ALL ON public.v_channel_order_summary FROM anon;
GRANT SELECT ON public.v_channel_order_summary TO authenticated, service_role;

-- PostgREST caches the schema; new columns / functions must be visible at once.
NOTIFY pgrst, 'reload schema';
