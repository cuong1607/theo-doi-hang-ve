-- ============================================================
-- PHASE SHOPEE-ADS-3A.1: hourly TODAY intraday analytics (READ ONLY).
--
--   A. read job types ads_shop_hourly_read / ads_campaign_hourly_read
--      (enqueue_ads_sync_job accepts them; nothing else changes in the queue)
--   B. shopee_ads_shop_hourly_performance      shop × report_date × hour
--   C. shopee_ads_campaign_hourly_performance  campaign × report_date × hour
--      Grain verified in production (ADS-1A): get_all_cpc_ads_hourly_performance /
--      get_product_campaign_hourly_performance return 24 rows (hour 0–23) for a
--      completed day; Σ hourly = daily (counts / GMV exact, expense ±1–2 đ).
--      Hourly rows are OPERATIONAL data (today's intraday view, yesterday's
--      reconciliation), kept ADS_HOURLY_RETENTION_DAYS (default 14) — daily
--      facts stay canonical for every day / 7-day / 30-day report.
--   D. shopee_ads_shop_settings: per-shop hourly switch (default OFF) + the
--      scheduler's hourly slot bookkeeping.
--   E. read RPCs: intraday series per hour, hourly-vs-daily reconciliation.
--   F. retention: prune_shopee_ads_hourly (called by the existing retention run).
--
-- Only primitives are stored; provider ratios (ctr, roas, cpc …) are not —
-- the campaign "cpc" field is expense / broad_order, not cost per click.
-- Nothing here writes to Shopee. Ads jobs remain ads_*_read.
-- ============================================================


-- ============================================================
-- A. job types
-- ============================================================
ALTER TABLE public.channel_sync_jobs DROP CONSTRAINT channel_sync_jobs_sync_type_check;
ALTER TABLE public.channel_sync_jobs ADD CONSTRAINT channel_sync_jobs_sync_type_check
  CHECK (sync_type IN (
    'product', 'order', 'escrow', 'income', 'return', 'payout', 'return_logistics', 'failed_delivery',
    'ads_campaign_read', 'ads_campaign_performance_read', 'ads_shop_performance_read',
    'ads_shop_hourly_read', 'ads_campaign_hourly_read'
  ));

-- Same function as 00065, with the two hourly read types allowed.
CREATE OR REPLACE FUNCTION public.enqueue_ads_sync_job(
  p_shop_id      uuid,
  p_sync_type    text,
  p_lane         text,
  p_mode         text,
  p_priority     integer,
  p_metadata     jsonb,
  p_from         date DEFAULT NULL,
  p_to           date DEFAULT NULL,
  p_not_before   timestamptz DEFAULT NULL,
  p_created_by   uuid DEFAULT NULL,
  p_coalesce     boolean DEFAULT true,
  p_max_attempts integer DEFAULT 5
)
RETURNS TABLE (job_id uuid, created boolean, status text, coalesced boolean, job_lane text, job_priority integer)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_meta  jsonb;
  v_scope text := COALESCE(p_metadata ->> 'adsScope', 'all');
  v_job   public.channel_sync_jobs;
BEGIN
  IF p_sync_type NOT IN ('ads_campaign_read', 'ads_campaign_performance_read', 'ads_shop_performance_read', 'ads_shop_hourly_read', 'ads_campaign_hourly_read') THEN
    RAISE EXCEPTION 'not an Ads read job: %', p_sync_type;
  END IF;
  IF p_lane !~ '^ads_[a-z]+$' THEN
    RAISE EXCEPTION 'bad Ads lane: %', p_lane;
  END IF;
  IF (p_from IS NULL) <> (p_to IS NULL) OR p_to < p_from THEN
    RAISE EXCEPTION 'bad Ads range';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('enqueue_ads_sync_job:' || p_shop_id::text || ':' || p_sync_type));

  v_meta := COALESCE(p_metadata, '{}'::jsonb)
         || jsonb_build_object('lane', p_lane)
         || CASE WHEN p_from IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('adsRange', jsonb_build_object('from', p_from::text, 'to', p_to::text)) END
         || CASE WHEN p_not_before IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('notBefore', p_not_before) END;

  IF p_coalesce THEN
    SELECT j.* INTO v_job
    FROM public.channel_sync_jobs j
    WHERE j.shop_id = p_shop_id AND j.sync_type = p_sync_type
      AND j.status IN ('pending', 'running', 'retry')
      AND (j.status = 'running' OR j.priority <= p_priority)
      AND (j.lane <> 'ads_backfill' OR p_lane = 'ads_backfill')
      AND (p_from IS NULL OR (
            j.metadata -> 'adsRange' IS NOT NULL
            AND (j.metadata -> 'adsRange' ->> 'from')::date <= p_from
            AND (j.metadata -> 'adsRange' ->> 'to')::date >= p_to))
      AND (COALESCE(j.metadata ->> 'adsScope', 'all') = 'all' OR COALESCE(j.metadata ->> 'adsScope', 'all') = v_scope)
    ORDER BY (j.status = 'running') DESC, j.priority ASC, j.created_at ASC
    LIMIT 1
    FOR UPDATE;
    IF v_job.id IS NOT NULL THEN
      UPDATE public.channel_sync_jobs j SET priority = LEAST(j.priority, p_priority) WHERE j.id = v_job.id RETURNING * INTO v_job;
      RETURN QUERY SELECT v_job.id, false, v_job.status, true, v_job.lane, v_job.priority;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.channel_sync_jobs (shop_id, sync_type, mode, priority, metadata, created_by, max_attempts, next_attempt_at)
  VALUES (p_shop_id, p_sync_type, p_mode, p_priority, v_meta, p_created_by, p_max_attempts, p_not_before)
  ON CONFLICT (shop_id, sync_type, lane) WHERE status IN ('pending', 'running', 'retry')
  DO NOTHING
  RETURNING * INTO v_job;
  IF v_job.id IS NOT NULL THEN
    RETURN QUERY SELECT v_job.id, true, v_job.status, false, v_job.lane, v_job.priority;
    RETURN;
  END IF;

  SELECT j.* INTO v_job
  FROM public.channel_sync_jobs j
  WHERE j.shop_id = p_shop_id AND j.sync_type = p_sync_type AND j.lane = p_lane
    AND j.status IN ('pending', 'running', 'retry')
  FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Ads enqueue raced with a finishing job; retry';
  END IF;
  IF v_job.status IN ('pending', 'retry') AND COALESCE(v_job.metadata -> 'checkpoint', 'null'::jsonb) = 'null'::jsonb THEN
    UPDATE public.channel_sync_jobs j
    SET priority = LEAST(j.priority, p_priority),
        metadata = j.metadata
          || CASE WHEN p_from IS NULL OR j.metadata -> 'adsRange' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('adsRange', jsonb_build_object(
               'from', LEAST((j.metadata -> 'adsRange' ->> 'from')::date, p_from)::text,
               'to',   GREATEST((j.metadata -> 'adsRange' ->> 'to')::date, p_to)::text)) END
          || CASE WHEN v_scope = 'all' THEN jsonb_build_object('adsScope', 'all') ELSE '{}'::jsonb END
    WHERE j.id = v_job.id
    RETURNING * INTO v_job;
    RETURN QUERY SELECT v_job.id, false, v_job.status, true, v_job.lane, v_job.priority;
    RETURN;
  END IF;
  UPDATE public.channel_sync_jobs j SET priority = LEAST(j.priority, p_priority) WHERE j.id = v_job.id RETURNING * INTO v_job;
  RETURN QUERY SELECT v_job.id, false, v_job.status, false, v_job.lane, v_job.priority;
END;
$$;


-- ============================================================
-- B. shop hourly performance (grain: shop × report_date × hour)
-- ============================================================
CREATE TABLE public.shopee_ads_shop_hourly_performance (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  -- shop-local report date as returned by Shopee ("DD-MM-YYYY")
  report_date       date          NOT NULL,
  report_hour       smallint      NOT NULL CHECK (report_hour BETWEEN 0 AND 23),
  expense           numeric(18,2) NOT NULL DEFAULT 0 CHECK (expense >= 0),
  impression        bigint        NOT NULL DEFAULT 0 CHECK (impression >= 0),
  clicks            bigint        NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  direct_order      bigint        NOT NULL DEFAULT 0 CHECK (direct_order >= 0),
  broad_order       bigint        NOT NULL DEFAULT 0 CHECK (broad_order >= 0),
  direct_gmv        numeric(18,2) NOT NULL DEFAULT 0 CHECK (direct_gmv >= 0),
  broad_gmv         numeric(18,2) NOT NULL DEFAULT 0 CHECK (broad_gmv >= 0),
  direct_item_sold  bigint        NOT NULL DEFAULT 0 CHECK (direct_item_sold >= 0),
  broad_item_sold   bigint        NOT NULL DEFAULT 0 CHECK (broad_item_sold >= 0),
  last_synced_at    timestamptz   NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, report_date, report_hour)
);
-- the unique key (shop_id, report_date, report_hour) already serves (shop_id, report_date) lookups;
-- the explicit index below is the documented minimal one (cheap: ≤ 24 rows per shop and day)
CREATE INDEX idx_shopee_ads_shp_shop_date ON public.shopee_ads_shop_hourly_performance (shop_id, report_date);


-- ============================================================
-- C. campaign hourly performance (grain: campaign × report_date × hour)
-- ============================================================
CREATE TABLE public.shopee_ads_campaign_hourly_performance (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid          NOT NULL,
  campaign_id       uuid          NOT NULL,
  report_date       date          NOT NULL,
  report_hour       smallint      NOT NULL CHECK (report_hour BETWEEN 0 AND 23),
  expense           numeric(18,2) NOT NULL DEFAULT 0 CHECK (expense >= 0),
  impression        bigint        NOT NULL DEFAULT 0 CHECK (impression >= 0),
  clicks            bigint        NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  direct_order      bigint        NOT NULL DEFAULT 0 CHECK (direct_order >= 0),
  broad_order       bigint        NOT NULL DEFAULT 0 CHECK (broad_order >= 0),
  direct_gmv        numeric(18,2) NOT NULL DEFAULT 0 CHECK (direct_gmv >= 0),
  broad_gmv         numeric(18,2) NOT NULL DEFAULT 0 CHECK (broad_gmv >= 0),
  -- campaign payload field *_order_amount (≈ units sold, LIKELY — same as the daily table)
  direct_item_sold  bigint        NOT NULL DEFAULT 0 CHECK (direct_item_sold >= 0),
  broad_item_sold   bigint        NOT NULL DEFAULT 0 CHECK (broad_item_sold >= 0),
  last_synced_at    timestamptz   NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, report_date, report_hour),
  -- composite FK (ADS-1B): an hourly row can never point at another shop's campaign
  FOREIGN KEY (campaign_id, shop_id) REFERENCES public.shopee_ads_campaigns (id, shop_id) ON DELETE CASCADE
);
CREATE INDEX idx_shopee_ads_chp_shop_date ON public.shopee_ads_campaign_hourly_performance (shop_id, report_date);
CREATE INDEX idx_shopee_ads_chp_campaign_date ON public.shopee_ads_campaign_hourly_performance (campaign_id, report_date);

CREATE TRIGGER set_shopee_ads_shp_updated_at BEFORE UPDATE ON public.shopee_ads_shop_hourly_performance     FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_shopee_ads_chp_updated_at BEFORE UPDATE ON public.shopee_ads_campaign_hourly_performance FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shopee_ads_shop_hourly_performance', 'shopee_ads_campaign_hourly_performance'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    -- cloud has no default grants: explicit
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY active_users_select ON public.%I FOR SELECT TO authenticated USING (public.is_active_user())', t);
  END LOOP;
END;
$$;


-- ============================================================
-- D. per-shop hourly switch + slot bookkeeping
-- ============================================================
ALTER TABLE public.shopee_ads_shop_settings
  -- rollout switch: OFF for every shop until an admin enables it (pilot first)
  ADD COLUMN ads_hourly_enabled           boolean NOT NULL DEFAULT false,
  ADD COLUMN hourly_enabled_at            timestamptz,
  ADD COLUMN last_hot_hourly_slot_at      timestamptz,
  ADD COLUMN last_hourly_finalize_slot_at timestamptz;


-- ============================================================
-- E. read RPCs (service_role only)
-- ============================================================
-- Shop hourly primitives per (date, hour), summed across the selected shops.
-- Ratios are derived by the caller from these sums (ratio-of-sums).
CREATE FUNCTION public.ads_dashboard_shop_hourly(p_shop_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  report_date date, report_hour smallint, expense numeric, impression bigint, clicks bigint,
  direct_order bigint, broad_order bigint, direct_gmv numeric, broad_gmv numeric,
  direct_item_sold bigint, broad_item_sold bigint, shops_with_data integer, shop_ids uuid[], last_synced_at timestamptz
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT f.report_date, f.report_hour,
         sum(f.expense), sum(f.impression)::bigint, sum(f.clicks)::bigint,
         sum(f.direct_order)::bigint, sum(f.broad_order)::bigint, sum(f.direct_gmv), sum(f.broad_gmv),
         sum(f.direct_item_sold)::bigint, sum(f.broad_item_sold)::bigint,
         count(DISTINCT f.shop_id)::integer, array_agg(DISTINCT f.shop_id), max(f.last_synced_at)
  FROM public.shopee_ads_shop_hourly_performance f
  WHERE f.shop_id = ANY (p_shop_ids) AND f.report_date BETWEEN p_from AND p_to
  GROUP BY f.report_date, f.report_hour
  ORDER BY f.report_date, f.report_hour;
$$;

-- Hourly vs daily, per shop × date: Σ hourly shop primitives next to the daily
-- shop row, and a campaign-level comparison (Σ hourly per campaign vs its daily
-- row; only campaigns that have hourly rows that day). The status
-- (MATCH / ROUNDING_DIFFERENCE / MISMATCH / IN_PROGRESS / INSUFFICIENT_DATA)
-- is decided by the caller (documented tolerance, docs/shopee-ads-hourly.md).
CREATE FUNCTION public.ads_dashboard_hourly_reconciliation(p_shop_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  shop_id uuid, report_date date, hours integer,
  h_expense numeric, h_impression bigint, h_clicks bigint, h_direct_order bigint, h_broad_order bigint,
  h_direct_gmv numeric, h_broad_gmv numeric, h_direct_item_sold bigint, h_broad_item_sold bigint,
  has_daily boolean,
  d_expense numeric, d_impression bigint, d_clicks bigint, d_direct_order bigint, d_broad_order bigint,
  d_direct_gmv numeric, d_broad_gmv numeric, d_direct_item_sold bigint, d_broad_item_sold bigint,
  campaigns_compared integer, campaigns_incomplete integer, campaigns_metric_mismatch integer,
  campaign_max_abs_expense_delta numeric, campaign_expense_delta numeric
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH h AS (
    SELECT f.shop_id, f.report_date, count(*)::integer AS hours,
           sum(f.expense) AS expense, sum(f.impression)::bigint AS impression, sum(f.clicks)::bigint AS clicks,
           sum(f.direct_order)::bigint AS direct_order, sum(f.broad_order)::bigint AS broad_order,
           sum(f.direct_gmv) AS direct_gmv, sum(f.broad_gmv) AS broad_gmv,
           sum(f.direct_item_sold)::bigint AS direct_item_sold, sum(f.broad_item_sold)::bigint AS broad_item_sold
    FROM public.shopee_ads_shop_hourly_performance f
    WHERE f.shop_id = ANY (p_shop_ids) AND f.report_date BETWEEN p_from AND p_to
    GROUP BY f.shop_id, f.report_date
  ), ch AS (
    SELECT f.shop_id, f.campaign_id, f.report_date, count(*)::integer AS hours,
           sum(f.expense) AS expense, sum(f.impression) AS impression, sum(f.clicks) AS clicks,
           sum(f.direct_order) AS direct_order, sum(f.broad_order) AS broad_order,
           sum(f.direct_gmv) AS direct_gmv, sum(f.broad_gmv) AS broad_gmv
    FROM public.shopee_ads_campaign_hourly_performance f
    WHERE f.shop_id = ANY (p_shop_ids) AND f.report_date BETWEEN p_from AND p_to
    GROUP BY f.shop_id, f.campaign_id, f.report_date
  ), cmp AS (
    SELECT ch.shop_id, ch.report_date,
           count(*)::integer AS compared,
           count(*) FILTER (WHERE ch.hours < 24)::integer AS incomplete,
           count(*) FILTER (WHERE d.id IS NULL
                              OR ch.impression <> d.impression OR ch.clicks <> d.clicks
                              OR ch.direct_order <> d.direct_order OR ch.broad_order <> d.broad_order
                              OR ch.direct_gmv <> d.direct_gmv OR ch.broad_gmv <> d.broad_gmv)::integer AS mismatch,
           max(abs(ch.expense - COALESCE(d.expense, 0))) AS max_abs_expense_delta,
           sum(ch.expense - COALESCE(d.expense, 0)) AS expense_delta
    FROM ch
    LEFT JOIN public.shopee_ads_campaign_daily_performance d ON d.campaign_id = ch.campaign_id AND d.report_date = ch.report_date
    GROUP BY ch.shop_id, ch.report_date
  )
  SELECT h.shop_id, h.report_date, h.hours,
         h.expense, h.impression, h.clicks, h.direct_order, h.broad_order, h.direct_gmv, h.broad_gmv, h.direct_item_sold, h.broad_item_sold,
         d.id IS NOT NULL,
         d.expense, d.impression, d.clicks, d.direct_order, d.broad_order, d.direct_gmv, d.broad_gmv, d.direct_item_sold, d.broad_item_sold,
         COALESCE(cmp.compared, 0), COALESCE(cmp.incomplete, 0), COALESCE(cmp.mismatch, 0),
         cmp.max_abs_expense_delta, cmp.expense_delta
  FROM h
  LEFT JOIN public.shopee_ads_shop_daily_performance d ON d.shop_id = h.shop_id AND d.report_date = h.report_date
  LEFT JOIN cmp ON cmp.shop_id = h.shop_id AND cmp.report_date = h.report_date
  ORDER BY h.shop_id, h.report_date;
$$;


-- ============================================================
-- F. retention (bounded per call; the scheduler's retention run calls it)
-- ============================================================
-- Removes hourly rows older than p_retention_days (report date). Never today's
-- or yesterday's rows: the retention is clamped to ≥ 2 days.
CREATE FUNCTION public.prune_shopee_ads_hourly(p_retention_days integer, p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_cutoff date := current_date - GREATEST(COALESCE(p_retention_days, 14), 2);
  v_shop integer;
  v_campaign integer;
BEGIN
  WITH victims AS (
    SELECT f.id FROM public.shopee_ads_campaign_hourly_performance f WHERE f.report_date < v_cutoff LIMIT p_limit
  )
  DELETE FROM public.shopee_ads_campaign_hourly_performance f USING victims v WHERE f.id = v.id;
  GET DIAGNOSTICS v_campaign = ROW_COUNT;
  WITH victims AS (
    SELECT f.id FROM public.shopee_ads_shop_hourly_performance f WHERE f.report_date < v_cutoff LIMIT p_limit
  )
  DELETE FROM public.shopee_ads_shop_hourly_performance f USING victims v WHERE f.id = v.id;
  GET DIAGNOSTICS v_shop = ROW_COUNT;
  RETURN v_campaign + v_shop;
END;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'enqueue_ads_sync_job(uuid, text, text, text, integer, jsonb, date, date, timestamptz, uuid, boolean, integer)',
    'ads_dashboard_shop_hourly(uuid[], date, date)',
    'ads_dashboard_hourly_reconciliation(uuid[], date, date)',
    'prune_shopee_ads_hourly(integer, integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
