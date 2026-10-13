-- ============================================================
-- PHASE SHOPEE-3: order sync support (fixture-first).
--
--   channel_order_items.provider_line_key
--     OUR derived line identity inside one order, built by the provider adapter:
--       "<order_item_id or ->|<item_id>|<model_id or ->"  (+ "#<n>" ONLY when the
--       same triple repeats inside the same order, n = 2, 3, …).
--     It is unique per order BY CONSTRUCTION, so the UNIQUE index below never
--     rejects a valid provider payload — it only makes re-sync idempotent.
--     It does NOT assert that Shopee's order_item_id is unique (it is not: a
--     bundle deal shares it). If real payloads later prove the key insufficient,
--     add a new key column + backfill in a NEW migration (docs: identity strategy).
--
--   channel_orders.shipping_carrier  shown on the order detail screen.
--     Recipient address / phone / buyer identity are intentionally NOT stored
--     (and not even requested from the API).
--
--   channel_api_snapshots.fingerprint  hash of the MEANINGFUL parts of an order
--     detail payload (status, update_time, line structure). A new snapshot row is
--     kept only when it changes; identical polling just refreshes the latest row.
--
--   v_channel_order_summary  per-order derived metrics computed in SQL (exact
--     NUMERIC, returned as text): item values, quantities, mapping readiness,
--     COGS readiness, financial-sync eligibility. Nothing here is a fee, a
--     settlement or a profit.
-- ============================================================

ALTER TABLE public.channel_order_items ADD COLUMN provider_line_key text;
CREATE UNIQUE INDEX uq_channel_order_items_line_key ON public.channel_order_items (order_id, provider_line_key);

ALTER TABLE public.channel_orders ADD COLUMN shipping_carrier text;

ALTER TABLE public.channel_api_snapshots ADD COLUMN fingerprint text;


CREATE VIEW public.v_channel_order_summary
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
    sum(oi.original_unit_price * oi.quantity)                       AS original_item_value
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
  -- NULL (unknown) as soon as any line lacks a price — never a partial sum.
  CASE WHEN i.lines_missing_price = 0 THEN i.item_gross_value::text END     AS item_gross_value,
  CASE WHEN i.lines_missing_original = 0 THEN i.original_item_value::text END AS original_item_value,
  CASE
    WHEN COALESCE(i.line_count, 0) = 0 THEN 'no_items'
    WHEN i.mapped_lines = i.line_count THEN 'complete'
    WHEN i.mapped_lines = 0 THEN 'unmapped'
    ELSE 'partial'
  END AS mapping_readiness,
  CASE
    WHEN COALESCE(i.line_count, 0) = 0 THEN 'pending'
    WHEN i.mapped_lines < i.line_count THEN 'incomplete'
    WHEN i.costed_lines = i.line_count THEN 'complete'
    ELSE 'pending'
  END AS cogs_readiness,
  (o.order_status = 'COMPLETED') AS financial_sync_eligible
FROM public.channel_orders o
JOIN public.shops s ON s.id = o.shop_id
LEFT JOIN items i ON i.order_id = o.id;

REVOKE ALL ON public.v_channel_order_summary FROM anon;
GRANT SELECT ON public.v_channel_order_summary TO authenticated, service_role;
