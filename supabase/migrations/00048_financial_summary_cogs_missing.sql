-- ============================================================
-- PHASE SHOPEE-5 fix: "Thieu gia von" filter on /shopee/orders.
--
-- The list filter used cogs_readiness = 'incomplete', which skipped orders
-- whose lines are only PARTIALLY costed - their internal_cogs is still NULL,
-- so they were counted in the "missing COGS" summary tile but not listed.
-- New p_cogs_missing = (internal_cogs IS NULL), the same rule as the tile.
-- Signature changes -> drop + recreate, explicit grants (cloud has no
-- default EXECUTE grants).
-- ============================================================

DROP FUNCTION IF EXISTS public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[]);

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
  p_cogs_missing     boolean DEFAULT NULL
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
$$;

REVOKE EXECUTE ON FUNCTION public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_channel_order_financial_summary(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, uuid[], boolean) TO service_role;
