-- ============================================================
-- PHASE SHOPEE-8: management analytics — a READ MODEL.
--
-- No second financial engine: every number below is read from the
-- canonical columns written by SHOPEE-3..7:
--   order value         channel_orders.channel_total_amount
--   est. Shopee revenue order_financials.estimated_order_revenue
--   actual income       order_financials.actual_shopee_income
--   original COGS       order_financials.internal_cogs (complete orders only)
--   reversed / net COGS order_financials.reversed_cogs / net_cogs (SHOPEE-6)
--   estimated profit    estimated_order_revenue − internal_cogs (same rule as
--                       v_channel_order_summary, 00051/00052)
--   actual profit       order_financials.actual_profit (= income − net COGS)
-- Margin (both): Σ profit / Σ channel_total_amount × 100, over the orders
-- that HAVE that profit (weighted — never an average of order margins).
-- Missing data is never 0: every sum comes with its order count (coverage).
--
-- Dates: sales / profit by order creation day in Asia/Ho_Chi_Minh
-- (analytics_tz); cash by release / payout time; returns by return
-- creation time (rates by the orders' creation cohort).
-- Sales = analytics_is_sales_status (paid, not cancelled — the cost
-- engine's set + TO_RETURN: a return is an adjustment, not a deletion).
--
-- Performance: plain SQL over existing indexes (shop_id, created_at_channel)
-- + per-order LATERAL lookups; measured on 20k orders (docs) — no
-- materialized tables.
-- ============================================================


-- ============================================================
-- A. Central settings + helpers
-- ============================================================
CREATE TABLE public.analytics_settings (
  id                         boolean   PRIMARY KEY DEFAULT true CHECK (id),
  low_margin_threshold_pct   numeric   NOT NULL DEFAULT 10,
  margin_band_edges          numeric[] NOT NULL DEFAULT '{0,10,20,30}',
  release_aging_edges_days   integer[] NOT NULL DEFAULT '{1,3,7}',
  min_sample_units           integer   NOT NULL DEFAULT 5 CHECK (min_sample_units >= 1),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.analytics_settings IS
  'SHOPEE-8: single row. Management thresholds (low margin warning, margin bands, release aging buckets, minimum sample for rate rankings). Edit with SQL; every query reads them from here.';
INSERT INTO public.analytics_settings (id) VALUES (true);

CREATE OR REPLACE FUNCTION public.analytics_tz() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'Asia/Ho_Chi_Minh'::text $$;

/** VN calendar day → its first instant. */
CREATE OR REPLACE FUNCTION public.analytics_day_start(p_day date) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT (p_day::timestamp AT TIME ZONE public.analytics_tz()) $$;

/** Orders that count as sales (paid, not cancelled). */
CREATE OR REPLACE FUNCTION public.analytics_is_sales_status(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT public.cost_order_status_eligible(p_status) OR p_status = 'TO_RETURN'
$$;

/** Weighted margin, one decimal; NULL when the base is not positive. */
CREATE OR REPLACE FUNCTION public.analytics_margin(p_profit numeric, p_base numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_profit IS NULL OR p_base IS NULL OR p_base <= 0 THEN NULL ELSE round(p_profit / p_base * 100, 1) END
$$;


-- ============================================================
-- B. Per-order read model
-- ============================================================
CREATE OR REPLACE VIEW public.v_analytics_orders WITH (security_invoker = true) AS
SELECT
  o.id                    AS order_id,
  o.shop_id,
  o.currency,
  o.external_order_sn,
  o.order_status,
  o.financial_status,
  o.created_at_channel,
  (o.created_at_channel AT TIME ZONE public.analytics_tz())::date AS business_date,
  public.analytics_is_sales_status(o.order_status)                AS is_sales,
  (o.order_status = 'CANCELLED')                                  AS is_cancelled,
  o.channel_total_amount  AS order_value,
  i.units,
  i.line_count,
  i.mapped_lines,
  i.priced_lines,
  f.estimated_order_revenue AS estimated_revenue,
  f.internal_cogs           AS original_cogs,
  COALESCE(f.reversed_cogs, 0) AS reversed_cogs,
  f.net_cogs,
  CASE WHEN f.estimated_order_revenue IS NOT NULL AND f.internal_cogs IS NOT NULL THEN f.estimated_order_revenue - f.internal_cogs END AS estimated_profit,
  f.actual_shopee_income    AS actual_income,
  f.actual_profit,
  f.reconciliation_status,
  r.return_count,
  r.returned_units
FROM public.channel_orders o
LEFT JOIN public.order_financials f ON f.order_id = o.id
CROSS JOIN LATERAL (
  SELECT count(*) AS line_count,
         count(*) FILTER (WHERE oi.internal_product_id IS NOT NULL) AS mapped_lines,
         count(*) FILTER (WHERE oi.discounted_unit_price IS NOT NULL) AS priced_lines,
         COALESCE(sum(oi.quantity), 0) AS units
  FROM public.channel_order_items oi WHERE oi.order_id = o.id
) i
CROSS JOIN LATERAL (
  SELECT count(DISTINCT cr.id) AS return_count, COALESCE(sum(ri.quantity) FILTER (WHERE ri.channel_order_item_id IS NOT NULL), 0) AS returned_units
  FROM public.channel_returns cr LEFT JOIN public.channel_return_items ri ON ri.return_id = cr.id
  WHERE cr.order_id = o.id AND COALESCE(cr.status, '') <> 'CANCELLED'
) r;

/** The filtered order set every RPC starts from (shop-scoped, one currency, VN days, inclusive). */
CREATE OR REPLACE FUNCTION public.analytics_orders_in(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS SETOF public.v_analytics_orders
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT * FROM public.v_analytics_orders v
  WHERE v.shop_id = ANY (p_shop_ids)
    AND v.currency = p_currency
    AND v.created_at_channel >= public.analytics_day_start(p_from)
    AND v.created_at_channel <  public.analytics_day_start(p_to + 1)
$$;

/**
 * Per-line read model for SKU analytics. Order-level money is ALLOCATED to
 * lines by the line's share of the order's item value (discounted price ×
 * qty) — a display allocation, never written back. A line gets an
 * allocated estimated / actual figure only when its ORDER has that profit
 * (so Σ lines = order totals) and every line of the order is priced.
 */
CREATE OR REPLACE FUNCTION public.analytics_lines_in(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS TABLE (
  order_id uuid, shop_id uuid, line_id uuid, product_id uuid, quantity numeric,
  line_value numeric, alloc_order_value numeric, line_cogs numeric, line_reversed_cogs numeric,
  alloc_estimated_revenue numeric, estimated_profit numeric, alloc_actual_income numeric, actual_profit numeric,
  returned_units numeric
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH o AS (
    SELECT * FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) WHERE is_sales
  ), l AS (
    SELECT o.order_id, o.shop_id, oi.id AS line_id, oi.internal_product_id AS product_id, oi.quantity,
           oi.discounted_unit_price * oi.quantity AS line_value,
           sum(oi.discounted_unit_price * oi.quantity) OVER (PARTITION BY o.order_id) AS order_items_value,
           (o.priced_lines = o.line_count) AS fully_priced,
           o.order_value, o.estimated_revenue, o.estimated_profit, o.actual_income, o.actual_profit,
           oi.total_cogs AS line_cogs,
           COALESCE((SELECT sum(rs.total_cost) FROM public.channel_return_restocks rs WHERE rs.channel_order_item_id = oi.id AND rs.reversed_at IS NULL), 0) AS line_reversed_cogs,
           COALESCE((SELECT sum(ri.quantity) FROM public.channel_return_items ri JOIN public.channel_returns cr ON cr.id = ri.return_id
                     WHERE ri.channel_order_item_id = oi.id AND COALESCE(cr.status, '') <> 'CANCELLED'), 0) AS returned_units
    FROM o JOIN public.channel_order_items oi ON oi.order_id = o.order_id
  )
  SELECT l.order_id, l.shop_id, l.line_id, l.product_id, l.quantity, l.line_value,
    CASE WHEN l.fully_priced AND l.order_items_value > 0 THEN l.order_value * l.line_value / l.order_items_value END,
    l.line_cogs, l.line_reversed_cogs,
    CASE WHEN l.estimated_profit IS NOT NULL AND l.fully_priced AND l.order_items_value > 0 THEN l.estimated_revenue * l.line_value / l.order_items_value END,
    CASE WHEN l.estimated_profit IS NOT NULL AND l.fully_priced AND l.order_items_value > 0 THEN l.estimated_revenue * l.line_value / l.order_items_value - l.line_cogs END,
    CASE WHEN l.actual_profit IS NOT NULL AND l.fully_priced AND l.order_items_value > 0 THEN l.actual_income * l.line_value / l.order_items_value END,
    CASE WHEN l.actual_profit IS NOT NULL AND l.fully_priced AND l.order_items_value > 0 THEN l.actual_income * l.line_value / l.order_items_value - (l.line_cogs - l.line_reversed_cogs) END,
    l.returned_units
  FROM l
$$;


-- ============================================================
-- C. Executive summary + trend
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_summary(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH a AS (SELECT * FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency)),
  s AS (SELECT * FROM a WHERE is_sales)
  SELECT jsonb_build_object(
    'orders_created',            (SELECT count(*) FROM a),
    'order_count',               (SELECT count(*) FROM s),
    'cancelled_count',           (SELECT count(*) FROM a WHERE is_cancelled),
    'units',                     (SELECT COALESCE(sum(units), 0)::text FROM s),
    'order_value',               (SELECT COALESCE(sum(order_value), 0)::text FROM s),
    'order_value_orders',        (SELECT count(*) FROM s WHERE order_value IS NOT NULL),
    'estimated_revenue',         (SELECT sum(estimated_revenue)::text FROM s),
    'estimated_revenue_orders',  (SELECT count(*) FROM s WHERE estimated_revenue IS NOT NULL),
    'estimated_profit',          (SELECT sum(estimated_profit)::text FROM s),
    'estimated_profit_orders',   (SELECT count(*) FROM s WHERE estimated_profit IS NOT NULL),
    'estimated_margin',          (SELECT public.analytics_margin(sum(estimated_profit), sum(order_value))::text FROM s WHERE estimated_profit IS NOT NULL),
    'actual_income',             (SELECT sum(actual_income)::text FROM s),
    'actual_income_orders',      (SELECT count(*) FROM s WHERE actual_income IS NOT NULL),
    'actual_profit',             (SELECT sum(actual_profit)::text FROM s),
    'actual_profit_orders',      (SELECT count(*) FROM s WHERE actual_profit IS NOT NULL),
    'actual_margin',             (SELECT public.analytics_margin(sum(actual_profit), sum(order_value))::text FROM s WHERE actual_profit IS NOT NULL),
    'original_cogs',             (SELECT sum(original_cogs)::text FROM s),
    'reversed_cogs',             (SELECT sum(reversed_cogs) FILTER (WHERE original_cogs IS NOT NULL)::text FROM s),
    'net_cogs',                  (SELECT sum(net_cogs)::text FROM s),
    'cogs_orders',               (SELECT count(*) FROM s WHERE original_cogs IS NOT NULL),
    'missing_cogs_orders',       (SELECT count(*) FROM s WHERE original_cogs IS NULL),
    'unmapped_orders',           (SELECT count(*) FROM s WHERE mapped_lines < line_count OR line_count = 0),
    'missing_estimated_orders',  (SELECT count(*) FROM s WHERE estimated_revenue IS NULL),
    'awaiting_actual_orders',    (SELECT count(*) FROM s WHERE order_status = 'COMPLETED' AND actual_income IS NULL),
    'mismatch_orders',           (SELECT count(*) FROM s WHERE reconciliation_status = 'mismatch'),
    'loss_actual_orders',        (SELECT count(*) FROM s WHERE actual_profit < 0),
    'loss_estimated_orders',     (SELECT count(*) FROM s WHERE actual_profit IS NULL AND estimated_profit < 0),
    'orders_with_returns',       (SELECT count(*) FROM s WHERE return_count > 0),
    'returned_units',            (SELECT COALESCE(sum(returned_units), 0)::text FROM s)
  )
$$;

CREATE OR REPLACE FUNCTION public.analytics_trend(p_shop_ids uuid[], p_from date, p_to date, p_currency text, p_bucket text)
RETURNS TABLE (
  bucket text, orders bigint, order_value text, estimated_revenue text,
  estimated_profit text, estimated_profit_orders bigint, estimated_margin text,
  actual_profit text, actual_profit_orders bigint, actual_margin text
)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_step interval;
BEGIN
  IF p_bucket NOT IN ('hour', 'day', 'week', 'month') THEN RAISE EXCEPTION 'bucket không hợp lệ: %', p_bucket USING ERRCODE = 'AN001'; END IF;
  v_step := ('1 ' || p_bucket)::interval;
  RETURN QUERY
  WITH s AS (
    SELECT date_trunc(p_bucket, v.created_at_channel AT TIME ZONE public.analytics_tz()) AS b, v.*
    FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) v WHERE v.is_sales
  ), series AS (
    SELECT generate_series(date_trunc(p_bucket, p_from::timestamp), date_trunc(p_bucket, (p_to + 1)::timestamp - interval '1 second'), v_step) AS b
  )
  SELECT
    CASE WHEN p_bucket = 'hour' THEN to_char(g.b, 'YYYY-MM-DD"T"HH24:00') ELSE to_char(g.b, 'YYYY-MM-DD') END,
    count(s.order_id),
    COALESCE(sum(s.order_value), 0)::text,
    sum(s.estimated_revenue)::text,
    sum(s.estimated_profit)::text,
    count(s.estimated_profit),
    public.analytics_margin(sum(s.estimated_profit), sum(s.order_value) FILTER (WHERE s.estimated_profit IS NOT NULL))::text,
    sum(s.actual_profit)::text,
    count(s.actual_profit),
    public.analytics_margin(sum(s.actual_profit), sum(s.order_value) FILTER (WHERE s.actual_profit IS NOT NULL))::text
  FROM series g LEFT JOIN s ON s.b = g.b
  GROUP BY g.b ORDER BY g.b;
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_order_status_mix(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS TABLE (order_status text, orders bigint, order_value text, is_sales boolean)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT v.order_status, count(*), COALESCE(sum(v.order_value), 0)::text, bool_and(v.is_sales)
  FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) v
  GROUP BY v.order_status ORDER BY count(*) DESC
$$;


-- ============================================================
-- D. Products (sellable SKU = the line's internal product; combo stays combo)
-- ============================================================
DROP FUNCTION IF EXISTS public.analytics_products(uuid[], date, date, text, text, text, boolean, text, boolean, integer, integer, uuid);
CREATE OR REPLACE FUNCTION public.analytics_products(
  p_shop_ids uuid[], p_from date, p_to date, p_currency text,
  p_type text DEFAULT NULL, p_search text DEFAULT NULL, p_attention boolean DEFAULT false,
  p_sort text DEFAULT 'estimated_profit', p_desc boolean DEFAULT true, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0,
  p_product_id uuid DEFAULT NULL,
  p_margin_threshold numeric DEFAULT NULL
)
RETURNS TABLE (
  product_id uuid, sku text, name text, product_type text,
  units text, orders bigint, lines bigint, order_value text, estimated_revenue text, cogs text,
  estimated_profit text, estimated_lines bigint, estimated_margin text,
  actual_profit text, actual_lines bigint, actual_margin text,
  returned_units text, return_rate text, small_sample boolean, cost_flag text,
  total_count bigint
)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_threshold numeric;
  v_min int;
BEGIN
  IF p_sort NOT IN ('units', 'order_value', 'estimated_profit', 'actual_profit', 'estimated_margin', 'actual_margin', 'return_rate', 'cogs') THEN
    RAISE EXCEPTION 'sort không hợp lệ: %', p_sort USING ERRCODE = 'AN002';
  END IF;
  SELECT COALESCE(p_margin_threshold, low_margin_threshold_pct), min_sample_units INTO v_threshold, v_min FROM public.analytics_settings WHERE id;
  RETURN QUERY
  WITH agg AS (
    SELECT l.product_id,
      sum(l.quantity) AS units, count(DISTINCT l.order_id) AS orders, count(*) AS lines,
      sum(l.alloc_order_value) AS order_value,
      sum(l.alloc_estimated_revenue) AS estimated_revenue,
      sum(l.line_cogs) AS cogs, count(l.line_cogs) AS costed_lines,
      sum(l.estimated_profit) AS est_profit, count(l.estimated_profit) AS est_lines,
      sum(l.alloc_order_value) FILTER (WHERE l.estimated_profit IS NOT NULL) AS est_base,
      sum(l.actual_profit) AS act_profit, count(l.actual_profit) AS act_lines,
      sum(l.alloc_order_value) FILTER (WHERE l.actual_profit IS NOT NULL) AS act_base,
      sum(l.returned_units) AS returned_units
    FROM public.analytics_lines_in(p_shop_ids, p_from, p_to, p_currency) l
    WHERE l.product_id IS NOT NULL AND (p_product_id IS NULL OR l.product_id = p_product_id)
    GROUP BY l.product_id
  ), r AS (
    SELECT p.id, p.sku, p.name, p.product_type, a.*,
      public.analytics_margin(a.est_profit, a.est_base) AS est_margin,
      public.analytics_margin(a.act_profit, a.act_base) AS act_margin,
      CASE WHEN a.units > 0 THEN round(a.returned_units / a.units * 100, 1) END AS ret_rate,
      CASE
        WHEN a.costed_lines < a.lines THEN 'cogs_missing'
        WHEN p.product_type = 'atomic' AND (cs.product_id IS NULL OR cs.moving_average_cost IS NULL) THEN 'no_cost_state'
        WHEN p.product_type = 'atomic' AND cs.quantity_on_hand < 0 THEN 'negative_stock'
        WHEN p.product_type = 'atomic' AND cs.cost_provisional THEN 'provisional'
      END AS cost_flag
    FROM agg a JOIN public.products p ON p.id = a.product_id
    LEFT JOIN public.product_cost_state cs ON cs.product_id = p.id
    WHERE (p_type IS NULL OR p.product_type = p_type)
      AND (p_search IS NULL OR p.sku ILIKE '%' || p_search || '%' OR p.name ILIKE '%' || p_search || '%')
  ), f AS (
    SELECT * FROM r
    WHERE NOT p_attention
       OR r.est_profit < 0 OR r.act_profit < 0
       OR r.est_margin < v_threshold OR r.act_margin < v_threshold
  )
  SELECT f.id, f.sku, f.name, f.product_type,
    f.units::text, f.orders, f.lines, round(f.order_value, 2)::text, round(f.estimated_revenue, 2)::text, f.cogs::text,
    round(f.est_profit, 2)::text, f.est_lines, f.est_margin::text,
    round(f.act_profit, 2)::text, f.act_lines, f.act_margin::text,
    f.returned_units::text, f.ret_rate::text, (f.units < v_min), f.cost_flag,
    count(*) OVER ()
  FROM f
  ORDER BY
    CASE WHEN p_desc THEN CASE p_sort
      WHEN 'units' THEN f.units WHEN 'order_value' THEN f.order_value WHEN 'estimated_profit' THEN f.est_profit
      WHEN 'actual_profit' THEN f.act_profit WHEN 'estimated_margin' THEN f.est_margin WHEN 'actual_margin' THEN f.act_margin
      WHEN 'return_rate' THEN f.ret_rate WHEN 'cogs' THEN f.cogs END END DESC NULLS LAST,
    CASE WHEN NOT p_desc THEN CASE p_sort
      WHEN 'units' THEN f.units WHEN 'order_value' THEN f.order_value WHEN 'estimated_profit' THEN f.est_profit
      WHEN 'actual_profit' THEN f.act_profit WHEN 'estimated_margin' THEN f.est_margin WHEN 'actual_margin' THEN f.act_margin
      WHEN 'return_rate' THEN f.ret_rate WHEN 'cogs' THEN f.cogs END END ASC NULLS LAST,
    f.sku
  LIMIT LEAST(GREATEST(p_limit, 1), 500) OFFSET GREATEST(p_offset, 0);
END;
$$;

/** Secondary: real (atomic) units consumed — atomic lines + historical combo component snapshots. */
CREATE OR REPLACE FUNCTION public.analytics_atomic_consumption(p_shop_ids uuid[], p_from date, p_to date, p_currency text, p_limit integer DEFAULT 20)
RETURNS TABLE (product_id uuid, sku text, name text, direct_units text, via_combo_units text, total_units text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH l AS (SELECT * FROM public.analytics_lines_in(p_shop_ids, p_from, p_to, p_currency) WHERE product_id IS NOT NULL),
  u AS (
    SELECT l.product_id AS pid, l.quantity AS direct, 0::numeric AS via
    FROM l JOIN public.products p ON p.id = l.product_id WHERE p.product_type = 'atomic'
    UNION ALL
    SELECT c.component_product_id, 0, c.total_component_quantity
    FROM l JOIN public.channel_order_item_cogs_components c ON c.channel_order_item_id = l.line_id
  )
  SELECT p.id, p.sku, p.name, sum(u.direct)::text, sum(u.via)::text, (sum(u.direct) + sum(u.via))::text
  FROM u JOIN public.products p ON p.id = u.pid
  GROUP BY p.id, p.sku, p.name
  ORDER BY sum(u.direct) + sum(u.via) DESC, p.sku
  LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;


-- ============================================================
-- E. Profitability: loss orders, margin bands
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_loss_orders(p_shop_ids uuid[], p_from date, p_to date, p_currency text, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
RETURNS TABLE (order_id uuid, shop_id uuid, external_order_sn text, created_at_channel timestamptz, order_status text,
               order_value text, estimated_profit text, actual_profit text, loss_state text, margin text, total_count bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT v.order_id, v.shop_id, v.external_order_sn, v.created_at_channel, v.order_status,
    v.order_value::text, v.estimated_profit::text, v.actual_profit::text,
    CASE WHEN v.actual_profit IS NOT NULL THEN 'actual_loss' ELSE 'estimated_loss' END,
    public.analytics_margin(COALESCE(v.actual_profit, v.estimated_profit), v.order_value)::text,
    count(*) OVER ()
  FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) v
  WHERE v.is_sales AND (v.actual_profit < 0 OR (v.actual_profit IS NULL AND v.estimated_profit < 0))
  ORDER BY COALESCE(v.actual_profit, v.estimated_profit) ASC, v.created_at_channel DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;

/** Orders per margin band (edges from analytics_settings); basis estimated | actual. */
CREATE OR REPLACE FUNCTION public.analytics_margin_bands(p_shop_ids uuid[], p_from date, p_to date, p_currency text, p_basis text)
RETURNS TABLE (band_index integer, lower_pct numeric, upper_pct numeric, orders bigint, order_value text, profit text)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_edges numeric[];
BEGIN
  IF p_basis NOT IN ('estimated', 'actual') THEN RAISE EXCEPTION 'basis không hợp lệ: %', p_basis USING ERRCODE = 'AN003'; END IF;
  SELECT margin_band_edges INTO v_edges FROM public.analytics_settings WHERE id;
  RETURN QUERY
  WITH s AS (
    SELECT v.order_value, CASE WHEN p_basis = 'actual' THEN v.actual_profit ELSE v.estimated_profit END AS profit
    FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) v WHERE v.is_sales
  ), m AS (
    SELECT s.*, s.profit / s.order_value * 100 AS pct FROM s WHERE s.profit IS NOT NULL AND s.order_value > 0
  ), bands AS (
    SELECT g.i, CASE WHEN g.i = 1 THEN NULL ELSE v_edges[g.i - 1] END AS lo, CASE WHEN g.i > cardinality(v_edges) THEN NULL ELSE v_edges[g.i] END AS hi
    FROM generate_series(1, cardinality(v_edges) + 1) AS g(i)
  )
  SELECT b.i, b.lo, b.hi, count(m.pct), COALESCE(sum(m.order_value), 0)::text, COALESCE(sum(m.profit), 0)::text
  FROM bands b LEFT JOIN m ON (b.lo IS NULL OR m.pct >= b.lo) AND (b.hi IS NULL OR m.pct < b.hi)
  GROUP BY b.i, b.lo, b.hi ORDER BY b.i;
END;
$$;


-- ============================================================
-- F. Returns (events by return creation day; rates by order cohort)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_returns(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH ri AS (
    SELECT ri.*, cr.refund_amount AS return_refund, cr.id AS rid,
           CASE WHEN oi.quantity > 0 THEN oi.total_cogs / oi.quantity END AS unit_cogs
    FROM public.channel_returns cr
    JOIN public.channel_orders o ON o.id = cr.order_id
    LEFT JOIN public.channel_return_items ri ON ri.return_id = cr.id
    LEFT JOIN public.channel_order_items oi ON oi.id = ri.channel_order_item_id
    WHERE cr.shop_id = ANY (p_shop_ids) AND o.currency = p_currency
      AND COALESCE(cr.status, '') <> 'CANCELLED'
      AND cr.created_at_channel >= public.analytics_day_start(p_from) AND cr.created_at_channel < public.analytics_day_start(p_to + 1)
  ), rs AS (
    SELECT COALESCE(sum(rs.total_cost), 0) AS reversed
    FROM public.channel_return_restocks rs WHERE rs.reversed_at IS NULL AND rs.return_item_id IN (SELECT id FROM ri WHERE id IS NOT NULL)
  ), cohort AS (
    SELECT COALESCE(sum(units), 0) AS units, COALESCE(sum(returned_units), 0) AS returned, count(*) AS orders, count(*) FILTER (WHERE return_count > 0) AS orders_ret
    FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) WHERE is_sales
  )
  SELECT jsonb_build_object(
    'return_count',          (SELECT count(DISTINCT rid) FROM ri),
    'returned_units',        (SELECT COALESCE(sum(quantity), 0)::text FROM ri WHERE channel_order_item_id IS NOT NULL),
    'unmatched_units',       (SELECT COALESCE(sum(quantity), 0)::text FROM ri WHERE id IS NOT NULL AND channel_order_item_id IS NULL),
    'refund_amount_reference',(SELECT COALESCE(sum(x.rr), 0)::text FROM (SELECT DISTINCT rid, return_refund AS rr FROM ri) x),
    'restocked_units',       (SELECT COALESCE(sum(quantity) FILTER (WHERE inventory_disposition = 'restock'), 0)::text FROM ri),
    'damaged_units',         (SELECT COALESCE(sum(quantity) FILTER (WHERE inventory_disposition = 'damaged'), 0)::text FROM ri),
    'lost_units',            (SELECT COALESCE(sum(quantity) FILTER (WHERE inventory_disposition = 'lost'), 0)::text FROM ri),
    'disposed_units',        (SELECT COALESCE(sum(quantity) FILTER (WHERE inventory_disposition = 'disposed'), 0)::text FROM ri),
    'pending_units',         (SELECT COALESCE(sum(quantity) FILTER (WHERE inventory_disposition = 'pending'), 0)::text FROM ri),
    'cogs_involved',         (SELECT COALESCE(round(sum(unit_cogs * quantity), 2), 0)::text FROM ri),
    'cogs_involved_missing', (SELECT count(*) FROM ri WHERE id IS NOT NULL AND unit_cogs IS NULL),
    'cogs_reversed',         (SELECT reversed::text FROM rs),
    'cogs_not_recovered',    (SELECT COALESCE(round(sum(unit_cogs * quantity) FILTER (WHERE inventory_disposition IN ('damaged', 'lost', 'disposed')), 2), 0)::text FROM ri),
    'cogs_pending',          (SELECT COALESCE(round(sum(unit_cogs * quantity) FILTER (WHERE inventory_disposition = 'pending'), 2), 0)::text FROM ri),
    'cohort_units',          (SELECT units::text FROM cohort),
    'cohort_returned_units', (SELECT returned::text FROM cohort),
    'unit_return_rate',      (SELECT CASE WHEN units > 0 THEN round(returned / units * 100, 1)::text END FROM cohort),
    'cohort_orders',         (SELECT orders FROM cohort),
    'cohort_orders_with_returns', (SELECT orders_ret FROM cohort),
    'order_return_rate',     (SELECT CASE WHEN orders > 0 THEN round(orders_ret::numeric / orders * 100, 1)::text END FROM cohort)
  )
$$;


-- ============================================================
-- G. Cash (release / payout dates) — SHOPEE-7 tables, read only
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_cashflow(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_edges integer[]; v_aging jsonb; v_out jsonb;
BEGIN
  SELECT release_aging_edges_days INTO v_edges FROM public.analytics_settings WHERE id;
  WITH p AS (
    SELECT v.order_id, v.expected_amount::numeric AS expected, extract(epoch FROM now() - v.completed_at_channel) / 86400.0 AS age_days
    FROM public.v_order_income_status v
    WHERE v.shop_id = ANY (p_shop_ids) AND v.currency = p_currency AND v.income_status = 'pending'
  ), b AS (
    SELECT g.i, CASE WHEN g.i = 1 THEN 0 ELSE v_edges[g.i - 1] END AS lo, CASE WHEN g.i > cardinality(v_edges) THEN NULL ELSE v_edges[g.i] END AS hi
    FROM generate_series(1, cardinality(v_edges) + 1) g(i)
  )
  SELECT jsonb_agg(jsonb_build_object('bucket', b.i, 'lower_days', b.lo, 'upper_days', b.hi, 'orders', x.n, 'amount', x.amt::text, 'without_amount', x.nul) ORDER BY b.i)
  INTO v_aging
  FROM b CROSS JOIN LATERAL (
    SELECT count(p.order_id) AS n, COALESCE(sum(p.expected), 0) AS amt, count(p.order_id) FILTER (WHERE p.expected IS NULL) AS nul
    FROM p WHERE p.age_days IS NOT NULL
      AND ((b.i = 1 AND floor(p.age_days) <= b.hi) OR (b.i > 1 AND floor(p.age_days) > b.lo AND (b.hi IS NULL OR floor(p.age_days) <= b.hi)))
  ) x;

  SELECT jsonb_build_object(
    'pending_orders',        (SELECT count(*) FROM public.v_order_income_status v WHERE v.shop_id = ANY (p_shop_ids) AND v.currency = p_currency AND v.income_status = 'pending'),
    'pending_amount',        (SELECT COALESCE(sum(v.expected_amount::numeric), 0)::text FROM public.v_order_income_status v WHERE v.shop_id = ANY (p_shop_ids) AND v.currency = p_currency AND v.income_status = 'pending'),
    'pending_without_amount',(SELECT count(*) FROM public.v_order_income_status v WHERE v.shop_id = ANY (p_shop_ids) AND v.currency = p_currency AND v.income_status = 'pending' AND v.expected_amount IS NULL),
    'stale_orders',          (SELECT count(*) FROM public.v_order_income_status v WHERE v.shop_id = ANY (p_shop_ids) AND v.currency = p_currency AND v.release_stale),
    'released_amount',       (SELECT COALESCE(sum(r.released_amount), 0)::text FROM public.order_income_releases r
                              WHERE r.shop_id = ANY (p_shop_ids) AND r.income_currency = p_currency
                                AND r.actual_payout_time >= public.analytics_day_start(p_from) AND r.actual_payout_time < public.analytics_day_start(p_to + 1)),
    'released_orders',       (SELECT count(*) FROM public.order_income_releases r
                              WHERE r.shop_id = ANY (p_shop_ids) AND r.income_currency = p_currency
                                AND r.actual_payout_time >= public.analytics_day_start(p_from) AND r.actual_payout_time < public.analytics_day_start(p_to + 1)),
    'release_mismatch_orders',(SELECT count(*) FROM public.order_income_releases r WHERE r.shop_id = ANY (p_shop_ids) AND r.income_currency = p_currency AND r.release_status = 'mismatch'),
    'payout_amount',         (SELECT COALESCE(sum(b.payout_amount), 0)::text FROM public.payout_batches b
                              WHERE b.shop_id = ANY (p_shop_ids) AND b.payout_currency = p_currency AND b.payout_status = 'completed'
                                AND b.payout_time >= public.analytics_day_start(p_from) AND b.payout_time < public.analytics_day_start(p_to + 1)),
    'payout_count',          (SELECT count(*) FROM public.payout_batches b
                              WHERE b.shop_id = ANY (p_shop_ids) AND b.payout_currency = p_currency AND b.payout_status = 'completed'
                                AND b.payout_time >= public.analytics_day_start(p_from) AND b.payout_time < public.analytics_day_start(p_to + 1)),
    'payouts_by_status',     (SELECT COALESCE(jsonb_object_agg(s, n), '{}'::jsonb) FROM (
                                SELECT b.reconciliation_status AS s, count(*) AS n FROM public.payout_batches b
                                WHERE b.shop_id = ANY (p_shop_ids) AND b.payout_currency = p_currency
                                  AND b.payout_time >= public.analytics_day_start(p_from) AND b.payout_time < public.analytics_day_start(p_to + 1)
                                GROUP BY b.reconciliation_status) x),
    'open_mismatch_payouts', (SELECT count(*) FROM public.payout_batches b WHERE b.shop_id = ANY (p_shop_ids) AND b.payout_currency = p_currency
                                AND b.reconciliation_status = 'mismatch' AND b.resolution_status IN ('open', 'investigating')),
    'open_mismatch_value',   (SELECT COALESCE(sum(abs(b.difference_amount)), 0)::text FROM public.payout_batches b WHERE b.shop_id = ANY (p_shop_ids) AND b.payout_currency = p_currency
                                AND b.reconciliation_status = 'mismatch' AND b.resolution_status IN ('open', 'investigating')),
    'open_incomplete_payouts',(SELECT count(*) FROM public.payout_batches b WHERE b.shop_id = ANY (p_shop_ids) AND b.payout_currency = p_currency AND b.reconciliation_status = 'incomplete'),
    'aging',                 COALESCE(v_aging, '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END;
$$;

/** Cash by day: released (release time) and paid out (payout time) — never by order date. */
CREATE OR REPLACE FUNCTION public.analytics_cashflow_trend(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS TABLE (bucket text, released_amount text, released_orders bigint, payout_amount text, payouts bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH days AS (SELECT generate_series(p_from, p_to, interval '1 day')::date AS d),
  rel AS (
    SELECT (r.actual_payout_time AT TIME ZONE public.analytics_tz())::date AS d, sum(r.released_amount) AS amt, count(*) AS n
    FROM public.order_income_releases r
    WHERE r.shop_id = ANY (p_shop_ids) AND r.income_currency = p_currency
      AND r.actual_payout_time >= public.analytics_day_start(p_from) AND r.actual_payout_time < public.analytics_day_start(p_to + 1)
    GROUP BY 1
  ), pay AS (
    SELECT (b.payout_time AT TIME ZONE public.analytics_tz())::date AS d, sum(b.payout_amount) AS amt, count(*) AS n
    FROM public.payout_batches b
    WHERE b.shop_id = ANY (p_shop_ids) AND b.payout_currency = p_currency AND b.payout_status = 'completed'
      AND b.payout_time >= public.analytics_day_start(p_from) AND b.payout_time < public.analytics_day_start(p_to + 1)
    GROUP BY 1
  )
  SELECT to_char(days.d, 'YYYY-MM-DD'), COALESCE(rel.amt, 0)::text, COALESCE(rel.n, 0), COALESCE(pay.amt, 0)::text, COALESCE(pay.n, 0)
  FROM days LEFT JOIN rel ON rel.d = days.d LEFT JOIN pay ON pay.d = days.d
  ORDER BY days.d
$$;

/** Drilldown of one aging bucket (orders awaiting release, oldest first). */
CREATE OR REPLACE FUNCTION public.analytics_pending_release_orders(p_shop_ids uuid[], p_currency text, p_min_days numeric, p_max_days numeric, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
RETURNS TABLE (order_id uuid, shop_id uuid, external_order_sn text, completed_at_channel timestamptz, age_days numeric, expected_amount text, release_stale boolean, total_count bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT v.order_id, v.shop_id, v.external_order_sn, v.completed_at_channel,
    round((extract(epoch FROM now() - v.completed_at_channel) / 86400.0)::numeric, 1), v.expected_amount, v.release_stale, count(*) OVER ()
  FROM public.v_order_income_status v
  WHERE v.shop_id = ANY (p_shop_ids) AND v.currency = p_currency AND v.income_status = 'pending'
    -- whole days since completion: floor(age) > p_min_days (exclusive) and <= p_max_days (same buckets as analytics_cashflow)
    AND v.completed_at_channel IS NOT NULL
    AND (p_min_days IS NULL OR floor(extract(epoch FROM now() - v.completed_at_channel) / 86400.0) > p_min_days)
    AND (p_max_days IS NULL OR floor(extract(epoch FROM now() - v.completed_at_channel) / 86400.0) <= p_max_days)
  ORDER BY v.completed_at_channel ASC NULLS LAST
  LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;


-- ============================================================
-- H. Data quality + shop comparison
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_data_quality(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH s AS (SELECT * FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) WHERE is_sales),
  models AS (SELECT * FROM public.v_channel_model_listing m WHERE m.shop_id = ANY (p_shop_ids)),
  sold_atomic AS (
    SELECT DISTINCT oi.internal_product_id AS pid FROM s JOIN public.channel_order_items oi ON oi.order_id = s.order_id
    JOIN public.products p ON p.id = oi.internal_product_id AND p.product_type = 'atomic'
    UNION
    SELECT DISTINCT c.component_product_id FROM s JOIN public.channel_order_items oi ON oi.order_id = s.order_id
    JOIN public.channel_order_item_cogs_components c ON c.channel_order_item_id = oi.id
  )
  SELECT jsonb_build_object(
    'orders',                    (SELECT count(*) FROM s),
    'unmapped_orders',           (SELECT count(*) FROM s WHERE mapped_lines < line_count OR line_count = 0),
    'missing_cogs_orders',       (SELECT count(*) FROM s WHERE original_cogs IS NULL),
    'missing_estimated_orders',  (SELECT count(*) FROM s WHERE estimated_revenue IS NULL),
    'awaiting_actual_orders',    (SELECT count(*) FROM s WHERE order_status = 'COMPLETED' AND actual_income IS NULL),
    'mismatch_orders',           (SELECT count(*) FROM s WHERE reconciliation_status = 'mismatch'),
    'financial_status',          (SELECT COALESCE(jsonb_object_agg(financial_status, n), '{}'::jsonb) FROM (SELECT financial_status, count(*) AS n FROM s GROUP BY 1) x),
    'returns_pending_disposition',(SELECT count(*) FROM public.channel_return_items ri JOIN public.channel_returns cr ON cr.id = ri.return_id
                                   WHERE cr.shop_id = ANY (p_shop_ids) AND COALESCE(cr.status, '') <> 'CANCELLED' AND ri.inventory_disposition = 'pending'),
    'payouts_incomplete',        (SELECT count(*) FROM public.payout_batches b WHERE b.shop_id = ANY (p_shop_ids) AND b.reconciliation_status = 'incomplete'),
    'payouts_mismatch',          (SELECT count(*) FROM public.payout_batches b WHERE b.shop_id = ANY (p_shop_ids) AND b.reconciliation_status = 'mismatch' AND b.resolution_status IN ('open', 'investigating')),
    'models_active',             (SELECT count(*) FROM models WHERE is_active),
    'models_mapped',             (SELECT count(*) FROM models WHERE is_active AND mapping_status IN ('auto_mapped', 'manual_mapped')),
    'models_unmapped',           (SELECT count(*) FROM models WHERE is_active AND mapping_status IN ('unmapped', 'mapping_conflict')),
    'unmapped_models_in_orders', (SELECT count(DISTINCT oi.channel_model_id) FROM s JOIN public.channel_order_items oi ON oi.order_id = s.order_id WHERE oi.internal_product_id IS NULL),
    'sold_products_no_cost',     (SELECT count(*) FROM sold_atomic sa LEFT JOIN public.product_cost_state cs ON cs.product_id = sa.pid WHERE cs.product_id IS NULL OR cs.moving_average_cost IS NULL),
    'products_negative_stock',   (SELECT count(*) FROM public.product_cost_state cs WHERE cs.quantity_on_hand < 0),
    'products_vat_pending',      (SELECT count(*) FROM public.product_cost_state cs WHERE cs.vat_pending),
    'products_provisional',      (SELECT count(*) FROM public.product_cost_state cs WHERE cs.cost_provisional),
    'products_needs_rebuild',    (SELECT count(*) FROM public.product_cost_state cs WHERE cs.needs_rebuild)
  )
$$;

CREATE OR REPLACE FUNCTION public.analytics_shop_comparison(p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS TABLE (shop_id uuid, shop_name text, orders bigint, order_value text, estimated_revenue text, estimated_profit text, estimated_profit_orders bigint,
               actual_profit text, actual_profit_orders bigint, estimated_margin text, actual_margin text, units text, returned_units text, unit_return_rate text,
               pending_release_amount text, payout_mismatch bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH s AS (SELECT * FROM public.analytics_orders_in(p_shop_ids, p_from, p_to, p_currency) WHERE is_sales)
  SELECT sh.id, sh.shop_name,
    count(s.order_id), COALESCE(sum(s.order_value), 0)::text, sum(s.estimated_revenue)::text,
    sum(s.estimated_profit)::text, count(s.estimated_profit), sum(s.actual_profit)::text, count(s.actual_profit),
    public.analytics_margin(sum(s.estimated_profit), sum(s.order_value) FILTER (WHERE s.estimated_profit IS NOT NULL))::text,
    public.analytics_margin(sum(s.actual_profit), sum(s.order_value) FILTER (WHERE s.actual_profit IS NOT NULL))::text,
    COALESCE(sum(s.units), 0)::text, COALESCE(sum(s.returned_units), 0)::text,
    CASE WHEN sum(s.units) > 0 THEN round(sum(s.returned_units) / sum(s.units) * 100, 1)::text END,
    (SELECT COALESCE(sum(v.expected_amount::numeric), 0)::text FROM public.v_order_income_status v WHERE v.shop_id = sh.id AND v.currency = p_currency AND v.income_status = 'pending'),
    (SELECT count(*) FROM public.payout_batches b WHERE b.shop_id = sh.id AND b.reconciliation_status = 'mismatch' AND b.resolution_status IN ('open', 'investigating'))
  FROM public.shops sh LEFT JOIN s ON s.shop_id = sh.id
  WHERE sh.id = ANY (p_shop_ids)
  GROUP BY sh.id, sh.shop_name
  ORDER BY sum(COALESCE(s.actual_profit, 0)) DESC, sh.shop_name
$$;

/** Product detail: per-day trend of one sellable SKU. */
CREATE OR REPLACE FUNCTION public.analytics_product_trend(p_product_id uuid, p_shop_ids uuid[], p_from date, p_to date, p_currency text)
RETURNS TABLE (bucket text, units text, order_value text, estimated_profit text, actual_profit text, estimated_margin text, actual_margin text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH l AS (
    SELECT (o.created_at_channel AT TIME ZONE public.analytics_tz())::date AS d, x.*
    FROM public.analytics_lines_in(p_shop_ids, p_from, p_to, p_currency) x JOIN public.channel_orders o ON o.id = x.order_id
    WHERE x.product_id = p_product_id
  ), days AS (SELECT generate_series(p_from, p_to, interval '1 day')::date AS d)
  SELECT to_char(days.d, 'YYYY-MM-DD'), COALESCE(sum(l.quantity), 0)::text, COALESCE(round(sum(l.alloc_order_value), 2), 0)::text,
    round(sum(l.estimated_profit), 2)::text, round(sum(l.actual_profit), 2)::text,
    public.analytics_margin(sum(l.estimated_profit), sum(l.alloc_order_value) FILTER (WHERE l.estimated_profit IS NOT NULL))::text,
    public.analytics_margin(sum(l.actual_profit), sum(l.alloc_order_value) FILTER (WHERE l.actual_profit IS NOT NULL))::text
  FROM days LEFT JOIN l ON l.d = days.d
  GROUP BY days.d ORDER BY days.d
$$;

/** Atomic cost history (moving average after each ledger event), bounded. */
CREATE OR REPLACE FUNCTION public.analytics_cost_history(p_product_id uuid, p_limit integer DEFAULT 200)
RETURNS TABLE (event_time timestamptz, event_type text, quantity_change text, unit_cost text, avg_cost_after text, qty_after text, cost_basis text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT * FROM (
    SELECT l.event_time, l.event_type, l.quantity_change::text, l.unit_cost::text, l.avg_cost_after::text, l.qty_after::text, l.cost_basis
    FROM public.inventory_cost_ledger l WHERE l.product_id = p_product_id
    ORDER BY l.event_time DESC, l.order_key DESC, l.id DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  ) x ORDER BY x.event_time
$$;


-- ============================================================
-- I. Indexes (justified by the RPCs above)
-- ============================================================
-- return events by shop + creation day already: idx_channel_returns_shop_created
-- releases by shop + time: idx_order_income_releases_shop_time; payouts: idx_payout_batches_shop_time
-- restocks per line: idx_return_restocks_order_item; cost ledger per product + time:
CREATE INDEX IF NOT EXISTS idx_inventory_cost_ledger_product_time ON public.inventory_cost_ledger (product_id, event_time);


-- ============================================================
-- J. Privileges
-- ============================================================
ALTER TABLE public.analytics_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_settings FROM anon, authenticated;
GRANT SELECT ON public.analytics_settings TO authenticated;
GRANT SELECT, UPDATE ON public.analytics_settings TO service_role;
CREATE POLICY active_users_select ON public.analytics_settings FOR SELECT TO authenticated USING (public.is_active_user());
GRANT SELECT ON public.v_analytics_orders TO authenticated, service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'analytics_tz()', 'analytics_day_start(date)', 'analytics_is_sales_status(text)', 'analytics_margin(numeric, numeric)',
    'analytics_orders_in(uuid[], date, date, text)', 'analytics_lines_in(uuid[], date, date, text)',
    'analytics_summary(uuid[], date, date, text)', 'analytics_trend(uuid[], date, date, text, text)',
    'analytics_order_status_mix(uuid[], date, date, text)',
    'analytics_products(uuid[], date, date, text, text, text, boolean, text, boolean, integer, integer, uuid, numeric)',
    'analytics_atomic_consumption(uuid[], date, date, text, integer)',
    'analytics_loss_orders(uuid[], date, date, text, integer, integer)',
    'analytics_margin_bands(uuid[], date, date, text, text)',
    'analytics_returns(uuid[], date, date, text)',
    'analytics_cashflow(uuid[], date, date, text)', 'analytics_cashflow_trend(uuid[], date, date, text)',
    'analytics_pending_release_orders(uuid[], text, numeric, numeric, integer, integer)',
    'analytics_data_quality(uuid[], date, date, text)', 'analytics_shop_comparison(uuid[], date, date, text)',
    'analytics_product_trend(uuid, uuid[], date, date, text)', 'analytics_cost_history(uuid, integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
