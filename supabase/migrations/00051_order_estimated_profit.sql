-- ============================================================
-- PATCH: simple estimated profit on the Shopee order list.
--
--   estimated_profit        = channel_total_amount − internal_cogs
--   estimated_margin_pct    = estimated_profit / channel_total_amount × 100
--                             (1 decimal; NULL when the total is 0 / NULL)
--   estimated_profit_state  = 'profit' (≥ 0) | 'loss' (< 0) | 'insufficient'
--
-- A pre-settlement estimate only: it ignores Shopee fees, taxes and other
-- deductions. Actual profit (profit_after_cogs, from escrow) is unchanged.
-- All math in NUMERIC; values leave the view as text (repo convention).
--
-- The view keeps every existing column in place (CREATE OR REPLACE may only
-- append columns); the summary RPC gains p_estimated_state so the KPI tiles
-- follow the new list filter (signature change → drop + recreate + grants).
-- ============================================================

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
  -- PATCH: estimated profit (order value − COGS), NULL when either is unknown
  (o.channel_total_amount - f.internal_cogs)::text AS estimated_profit,
  CASE
    WHEN o.channel_total_amount IS NULL OR o.channel_total_amount = 0 OR f.internal_cogs IS NULL THEN NULL
    ELSE round((o.channel_total_amount - f.internal_cogs) / o.channel_total_amount * 100, 1)::text
  END AS estimated_margin_pct,
  CASE
    WHEN o.channel_total_amount IS NULL OR f.internal_cogs IS NULL THEN 'insufficient'
    WHEN o.channel_total_amount - f.internal_cogs < 0 THEN 'loss'
    ELSE 'profit'
  END AS estimated_profit_state
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


DROP FUNCTION IF EXISTS public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[], boolean);

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
  p_order_ids        uuid[] DEFAULT NULL,
  p_cogs_missing     boolean DEFAULT NULL,
  p_estimated_state  text DEFAULT NULL
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
    AND (p_cogs_missing IS NULL OR (v.internal_cogs IS NULL) = p_cogs_missing)
    AND (p_estimated_state IS NULL OR v.estimated_profit_state = p_estimated_state)
$$;

REVOKE EXECUTE ON FUNCTION public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[], boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[], boolean, text) TO service_role;
