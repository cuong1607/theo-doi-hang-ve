-- ============================================================
-- PHASE LOCAL-LIVE-1 §41/§43: per-product historical COGS restatement
-- preview (DRY-RUN, read-only).
--
-- Same candidate rule as cost_restatement_candidates (00052): costed, not
-- reversed order lines whose locked snapshot differs from what the CURRENT
-- ledger reconstruction gives at the same sale moment — scoped to ONE
-- product, plus the order's estimated revenue / internal COGS / estimated
-- profit so the caller can show old vs new estimated profit.
-- Nothing is written; restating stays the explicit cost_restate_order_cogs.
-- ============================================================

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
  -- order level, over this product's candidate lines of the order;
  -- NULL when any of them has no new cost (VAT pending) or the order has
  -- no estimated revenue / internal COGS yet (unknown ≠ zero).
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
      AND l.avg_cost_before IS DISTINCT FROM oi.cost_per_unit_snapshot
  ), d AS (
    SELECT c.*,
           -- sum() skips NULLs, so require every line of the order to be known
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

-- Privileges (cloud has no default EXECUTE grants — explicit, always)
REVOKE EXECUTE ON FUNCTION public.cost_restatement_preview_product(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cost_restatement_preview_product(uuid) TO service_role;
