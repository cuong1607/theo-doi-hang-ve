-- ============================================================
-- PHASE SHOPEE-5: escrow settlement + order-level P&L.
--
--   Shopee get_escrow_detail → adapter + financial dictionary (TS, decimal
--   strings only) → apply_order_escrow() (this file, one transaction, all
--   NUMERIC) → order_financial_components + order_financials
--   → derive_order_financials trigger (profit / reconciliation)
--
-- Sign conventions (unchanged from 00038, restated):
--   order_financials money columns = POSITIVE magnitudes of what the column
--     name says (a 5,000 fee is 5000); total_adjustment_amount, variances and
--     profit columns are signed.
--   order_financial_components.amount = SIGNED by seller impact
--     (+ money to the seller: sales, platform support, compensation;
--      − money away from the seller: discounts the seller funds, fees, taxes,
--      shipping the seller pays, refunds). calculated_settlement is therefore
--     a plain SUM of the components the dictionary marks as part of the
--     settlement formula.
--
-- Final income rule (never rebuilt from components when Shopee states it):
--   actual_shopee_income = COALESCE(escrow_amount_after_adjustment, escrow_amount)
--
-- internal_cogs is owned by the cost engine (00043) — never written here.
-- Every function: SECURITY INVOKER + explicit GRANT to service_role (00044).
-- ============================================================

-- ---------------------------------------------------------------- components
ALTER TABLE public.order_financial_components
  ADD COLUMN component_key          text,
  ADD COLUMN included_in_settlement boolean     NOT NULL DEFAULT false,
  ADD COLUMN updated_at             timestamptz NOT NULL DEFAULT now();

-- Deterministic identity → repeated syncs update, never duplicate.
-- Scalar fields: key = provider field. Array rows (order_adjustment[]):
-- key = field + '#' + position + ':' + content hash (see escrow-adapter.ts).
UPDATE public.order_financial_components SET component_key = COALESCE(provider_field, component_type) || ':' || id::text WHERE component_key IS NULL;
ALTER TABLE public.order_financial_components ALTER COLUMN component_key SET NOT NULL;
-- Sources without a natural key (manual lines) get a unique one.
ALTER TABLE public.order_financial_components ALTER COLUMN component_key SET DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX uq_order_financial_components_key ON public.order_financial_components (order_id, source, component_key);

CREATE TRIGGER set_order_financial_components_updated_at BEFORE UPDATE ON public.order_financial_components
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------- order_financials
ALTER TABLE public.order_financials
  -- Final Shopee income per the rule above (stored for filtering / sorting).
  ADD COLUMN actual_shopee_income      numeric(18,2) GENERATED ALWAYS AS (COALESCE(escrow_amount_after_adjustment, escrow_amount)) STORED,
  -- Sum of escrow components whose meaning is NOT yet verified on real
  -- payloads — kept visible, never silently dropped, never in the formula.
  ADD COLUMN unverified_component_amount numeric(18,2),
  ADD COLUMN settlement_tolerance      numeric(18,2),
  ADD COLUMN escrow_synced_at          timestamptz,
  ADD COLUMN escrow_fingerprint        text,
  ADD COLUMN escrow_last_attempt_at    timestamptz,
  ADD COLUMN escrow_last_error_code    text,
  ADD COLUMN escrow_last_error_message text;

CREATE INDEX idx_order_financials_escrow_synced ON public.order_financials (escrow_synced_at);
CREATE INDEX idx_order_financials_reconciliation ON public.order_financials (reconciliation_status);


-- ------------------------------------------------------------
-- Tolerance for |actual − calculated| per currency. VND has no minor unit;
-- Shopee rounds each fee to whole đồng, so a few đồng of rounding drift
-- between a sum of rounded fees and the final escrow is "matched".
--   ≤ matched tolerance          → matched
--   ≤ warning tolerance          → warning (explainable rounding / small item)
--   larger                       → mismatch
-- Values are confirmed against real payloads in docs/shopee-financial-validation.md.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.financial_settlement_tolerance(p_currency text, p_level text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_currency = 'VND' AND p_level = 'matched' THEN 10::numeric
    WHEN p_currency = 'VND' AND p_level = 'warning' THEN 1000::numeric
    WHEN p_level = 'matched' THEN 0.05::numeric
    ELSE 1::numeric
  END
$$;


-- ------------------------------------------------------------
-- Derived columns, recomputed on EVERY write of order_financials — whether
-- escrow arrived (apply_order_escrow) or COGS changed (cost engine 00043) —
-- so profit can never be stale against its inputs.
--
--   profit_after_cogs = actual_shopee_income − internal_cogs
--                       (NULL unless BOTH are known; partial COGS is never
--                       written to internal_cogs by the cost engine)
--   actual_profit     = profit_after_cogs (SHOPEE-5: actual = escrow-based
--                       profit after COGS; extra variable costs not modelled)
--   contribution_profit stays NULL: gift / packaging / ads / other costs are
--                       unknown, and unknown is not zero
--   actual_margin     NULL — the sales base is not defined yet (see docs)
--   settlement_variance = actual_shopee_income − calculated_settlement
--   profit_variance   = actual_profit − estimated_profit (both present)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.derive_order_financials() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_income   numeric := COALESCE(NEW.escrow_amount_after_adjustment, NEW.escrow_amount);
  v_currency text;
BEGIN
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

CREATE TRIGGER derive_order_financials BEFORE INSERT OR UPDATE ON public.order_financials
  FOR EACH ROW EXECUTE FUNCTION public.derive_order_financials();


-- ------------------------------------------------------------
-- apply_order_escrow: one escrow payload → canonical rows, atomically.
--
--   p_fields      { order_financials column: decimal string | null } — only
--                 the escrow-owned columns listed below are read; a missing
--                 key / null = unknown (NULL), never 0
--   p_components  [{ component_key, component_type, provider_field, category,
--                    amount (signed decimal string), currency, funded_by,
--                    included_in_settlement, metadata }]
--   p_fingerprint hash of the meaningful payload — unchanged → only the
--                 sync timestamp moves (no rewrite, no new snapshot)
--
-- Components of this order + source that the payload no longer contains are
-- deleted (the raw snapshot history keeps what they were).
-- Returns: changed, reconciliation_status, financial_status.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_order_escrow(
  p_order_id    uuid,
  p_fields      jsonb,
  p_components  jsonb,
  p_fingerprint text,
  p_synced_at   timestamptz,
  p_version     text,
  p_source      text DEFAULT 'shopee_escrow'
)
RETURNS TABLE (changed boolean, reconciliation_status text, financial_status text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fp   text;
  v_calc      numeric;
  v_unverified numeric;
  v_status    text;
  v_fin       text;
  v_order_fin text;
BEGIN
  PERFORM 1 FROM public.channel_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order % not found', p_order_id USING ERRCODE = 'FN001'; END IF;

  SELECT escrow_fingerprint INTO v_prev_fp FROM public.order_financials WHERE order_id = p_order_id;
  IF v_prev_fp IS NOT DISTINCT FROM p_fingerprint AND v_prev_fp IS NOT NULL THEN
    UPDATE public.order_financials
    SET escrow_synced_at = p_synced_at, escrow_last_attempt_at = p_synced_at, escrow_last_error_code = NULL, escrow_last_error_message = NULL
    WHERE order_id = p_order_id
    RETURNING order_financials.reconciliation_status INTO v_status;
    SELECT o.financial_status INTO v_order_fin FROM public.channel_orders o WHERE o.id = p_order_id;
    RETURN QUERY SELECT false, v_status, v_order_fin;
    RETURN;
  END IF;

  -- components: replace this source's set for the order (deterministic keys)
  DELETE FROM public.order_financial_components c
  WHERE c.order_id = p_order_id AND c.source = p_source
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_components) e WHERE e->>'component_key' = c.component_key);

  INSERT INTO public.order_financial_components
    (order_id, component_key, component_type, provider_field, category, amount, currency, funded_by, source, source_synced_at, included_in_settlement, metadata)
  SELECT p_order_id, e->>'component_key', e->>'component_type', e->>'provider_field', e->>'category', (e->>'amount')::numeric,
         e->>'currency', e->>'funded_by', p_source, p_synced_at, COALESCE((e->>'included_in_settlement')::boolean, false), e->'metadata'
  FROM jsonb_array_elements(p_components) e
  ON CONFLICT (order_id, source, component_key) DO UPDATE SET
    component_type = EXCLUDED.component_type,
    provider_field = EXCLUDED.provider_field,
    category = EXCLUDED.category,
    amount = EXCLUDED.amount,
    currency = EXCLUDED.currency,
    funded_by = EXCLUDED.funded_by,
    source_synced_at = EXCLUDED.source_synced_at,
    included_in_settlement = EXCLUDED.included_in_settlement,
    metadata = EXCLUDED.metadata;

  SELECT sum(amount) FILTER (WHERE included_in_settlement),
         sum(amount) FILTER (WHERE NOT included_in_settlement AND COALESCE((metadata->>'unverified')::boolean, false))
  INTO v_calc, v_unverified
  FROM public.order_financial_components WHERE order_id = p_order_id AND source = p_source;

  INSERT INTO public.order_financials (order_id) VALUES (p_order_id) ON CONFLICT (order_id) DO NOTHING;
  UPDATE public.order_financials f SET
    gross_original_value           = (p_fields->>'gross_original_value')::numeric,
    gross_selling_value            = (p_fields->>'gross_selling_value')::numeric,
    seller_discount                = (p_fields->>'seller_discount')::numeric,
    seller_voucher                 = (p_fields->>'seller_voucher')::numeric,
    shopee_discount                = (p_fields->>'shopee_discount')::numeric,
    shopee_voucher                 = (p_fields->>'shopee_voucher')::numeric,
    other_platform_support         = (p_fields->>'other_platform_support')::numeric,
    commission_fee                 = (p_fields->>'commission_fee')::numeric,
    service_fee                    = (p_fields->>'service_fee')::numeric,
    transaction_fee                = (p_fields->>'transaction_fee')::numeric,
    processing_fee                 = (p_fields->>'processing_fee')::numeric,
    campaign_fee                   = (p_fields->>'campaign_fee')::numeric,
    affiliate_fee                  = (p_fields->>'affiliate_fee')::numeric,
    other_platform_fee             = (p_fields->>'other_platform_fee')::numeric,
    buyer_paid_shipping            = (p_fields->>'buyer_paid_shipping')::numeric,
    actual_shipping_fee            = (p_fields->>'actual_shipping_fee')::numeric,
    shipping_rebate                = (p_fields->>'shipping_rebate')::numeric,
    shipping_discount              = (p_fields->>'shipping_discount')::numeric,
    reverse_shipping_fee           = (p_fields->>'reverse_shipping_fee')::numeric,
    return_shipping_fee            = (p_fields->>'return_shipping_fee')::numeric,
    escrow_tax                     = (p_fields->>'escrow_tax')::numeric,
    withholding_vat_tax            = (p_fields->>'withholding_vat_tax')::numeric,
    withholding_pit_tax            = (p_fields->>'withholding_pit_tax')::numeric,
    withholding_cit_tax            = (p_fields->>'withholding_cit_tax')::numeric,
    other_tax                      = (p_fields->>'other_tax')::numeric,
    refund_amount                  = (p_fields->>'refund_amount')::numeric,
    seller_compensation_amount     = (p_fields->>'seller_compensation_amount')::numeric,
    total_adjustment_amount        = (p_fields->>'total_adjustment_amount')::numeric,
    escrow_amount                  = (p_fields->>'escrow_amount')::numeric,
    escrow_amount_after_adjustment = (p_fields->>'escrow_amount_after_adjustment')::numeric,
    calculated_settlement          = v_calc,
    unverified_component_amount    = v_unverified,
    calculation_version            = p_version,
    calculated_at                  = p_synced_at,
    escrow_synced_at               = p_synced_at,
    escrow_fingerprint             = p_fingerprint,
    escrow_last_attempt_at         = p_synced_at,
    escrow_last_error_code         = NULL,
    escrow_last_error_message      = NULL
  WHERE f.order_id = p_order_id
  RETURNING f.reconciliation_status INTO v_status;

  -- Lifecycle: escrow received → settlement_available, unless it does not
  -- reconcile (mismatch). 'released' is set by income/payout sync later and
  -- 'return_adjusted' by returns — neither is downgraded here.
  SELECT o.financial_status INTO v_order_fin FROM public.channel_orders o WHERE o.id = p_order_id;
  v_fin := CASE
    WHEN v_order_fin IN ('released', 'return_adjusted') THEN v_order_fin
    WHEN v_status = 'mismatch' THEN 'mismatch'
    ELSE 'settlement_available'
  END;
  UPDATE public.channel_orders SET financial_status = v_fin WHERE id = p_order_id AND financial_status IS DISTINCT FROM v_fin;
  RETURN QUERY SELECT true, v_status, v_fin;
END;
$$;

-- A failed / not-ready attempt is recorded so the candidate query backs off.
CREATE OR REPLACE FUNCTION public.record_order_escrow_attempt(p_order_id uuid, p_error_code text, p_error_message text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  INSERT INTO public.order_financials (order_id) VALUES (p_order_id) ON CONFLICT (order_id) DO NOTHING;
  UPDATE public.order_financials
  SET escrow_last_attempt_at = p_at, escrow_last_error_code = left(p_error_code, 100), escrow_last_error_message = left(p_error_message, 500)
  WHERE order_id = p_order_id;
END;
$$;


-- ------------------------------------------------------------
-- Orders that need an escrow fetch now (bounded, oldest need first):
--   eligible status (p_statuses, default COMPLETED)
--   AND ( never synced
--         OR provider changed the order after our last escrow fetch
--         OR still inside the refresh window after completion and the last
--            fetch is older than the refresh interval )
--   AND not attempted-with-error within the backoff
-- Stable old orders drop out — only repair (explicit order list) refetches.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_orders_needing_escrow_sync(
  p_shop_id            uuid,
  p_limit              integer,
  p_now                timestamptz DEFAULT now(),
  p_statuses           text[] DEFAULT ARRAY['COMPLETED'],
  p_refresh_window_days integer DEFAULT 14,
  p_refresh_interval_hours integer DEFAULT 24,
  p_error_backoff_hours integer DEFAULT 6
)
RETURNS TABLE (order_id uuid, external_order_sn text, reason text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT o.id, o.external_order_sn,
    CASE
      WHEN f.escrow_synced_at IS NULL THEN 'never_synced'
      WHEN o.updated_at_channel > f.escrow_synced_at THEN 'order_changed'
      ELSE 'refresh_window'
    END
  FROM public.channel_orders o
  LEFT JOIN public.order_financials f ON f.order_id = o.id
  WHERE o.shop_id = p_shop_id
    AND o.order_status = ANY (p_statuses)
    AND (
      f.escrow_synced_at IS NULL
      OR o.updated_at_channel > f.escrow_synced_at
      OR (COALESCE(o.updated_at_channel, o.created_at_channel) > p_now - make_interval(days => p_refresh_window_days)
          AND f.escrow_synced_at < p_now - make_interval(hours => p_refresh_interval_hours))
    )
    AND NOT (
      f.escrow_last_error_code IS NOT NULL
      AND f.escrow_last_attempt_at > p_now - make_interval(hours => p_error_backoff_hours)
    )
  ORDER BY f.escrow_synced_at NULLS FIRST, o.updated_at_channel
  LIMIT GREATEST(p_limit, 0)
$$;


-- ------------------------------------------------------------
-- Order list: financial columns + filters (one LEFT JOIN on the 1:1
-- order_financials row; same LATERAL line aggregation as 00045).
-- ------------------------------------------------------------
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
  END AS profit_state
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


-- ------------------------------------------------------------
-- Summary for the filtered order list, computed in SQL. Totals only add
-- AUTHORITATIVE values (income / COGS / profit present); counts expose what
-- is missing instead of treating it as 0.
-- Filters mirror order-queries.ts (NULL = no filter).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_channel_order_financial_summary(
  p_shop_id          uuid DEFAULT NULL,
  p_date_from        timestamptz DEFAULT NULL,
  p_date_to          timestamptz DEFAULT NULL,
  p_order_status     text DEFAULT NULL,
  p_financial_status text DEFAULT NULL,
  p_mapping          text DEFAULT NULL,
  p_order_sn         text DEFAULT NULL,
  p_profit_state     text DEFAULT NULL,
  p_reconciliation   text DEFAULT NULL,
  p_settlement_state text DEFAULT NULL,
  p_cogs_readiness   text DEFAULT NULL,
  p_order_ids        uuid[] DEFAULT NULL
)
RETURNS TABLE (
  order_count            bigint,
  with_income            bigint,
  income_sum             text,
  with_cogs              bigint,
  cogs_sum               text,
  with_profit            bigint,
  profit_sum             text,
  missing_settlement     bigint,
  missing_cogs           bigint,
  mismatch_count         bigint
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE v.shopee_net_income IS NOT NULL),
    COALESCE(sum(v.shopee_net_income::numeric), 0)::text,
    count(*) FILTER (WHERE v.internal_cogs IS NOT NULL),
    COALESCE(sum(v.internal_cogs::numeric), 0)::text,
    count(*) FILTER (WHERE v.profit_after_cogs IS NOT NULL),
    COALESCE(sum(v.profit_after_cogs::numeric), 0)::text,
    count(*) FILTER (WHERE v.shopee_net_income IS NULL),
    count(*) FILTER (WHERE v.internal_cogs IS NULL),
    count(*) FILTER (WHERE v.reconciliation_status = 'mismatch')
  FROM public.v_channel_order_summary v
  WHERE (p_shop_id IS NULL OR v.shop_id = p_shop_id)
    AND (p_date_from IS NULL OR v.created_at_channel >= p_date_from)
    AND (p_date_to IS NULL OR v.created_at_channel < p_date_to)
    AND (p_order_status IS NULL OR v.order_status = p_order_status)
    AND (p_financial_status IS NULL OR v.financial_status = p_financial_status)
    AND (p_mapping IS NULL OR v.mapping_readiness = p_mapping)
    AND (p_order_sn IS NULL OR v.external_order_sn ILIKE '%' || p_order_sn || '%')
    AND (p_profit_state IS NULL OR v.profit_state = p_profit_state)
    AND (p_reconciliation IS NULL OR v.reconciliation_status = p_reconciliation)
    AND (p_settlement_state IS NULL OR v.settlement_state = p_settlement_state)
    AND (p_cogs_readiness IS NULL OR v.cogs_readiness = p_cogs_readiness)
    AND (p_order_ids IS NULL OR v.order_id = ANY (p_order_ids))
$$;


REVOKE EXECUTE ON FUNCTION public.apply_order_escrow(uuid, jsonb, jsonb, text, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_order_escrow_attempt(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_orders_needing_escrow_sync(uuid, integer, timestamptz, text[], integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_order_escrow(uuid, jsonb, jsonb, text, timestamptz, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_order_escrow_attempt(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_orders_needing_escrow_sync(uuid, integer, timestamptz, text[], integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.financial_settlement_tolerance(text, text) TO service_role;
