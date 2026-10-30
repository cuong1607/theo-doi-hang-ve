-- ============================================================
-- PHASE SHOPEE-ADS-3A.2: product enrichment for Ads (READ ONLY, cache-first).
--
--   A. read job type ads_product_enrichment_read (enqueue_ads_sync_job accepts it)
--   B. shopee_ads_products  shop × provider_item_id — current metadata of the
--      items ADVERTISED by Ads campaigns only (never the whole shop catalogue).
--      Source verified in production: GET /api/v2/product/get_item_base_info
--      (item_name, item_sku, item_status, image.image_url_list / image_id_list;
--      ≤ 50 ids per call). Image URLs are https://cf.shopee.vn/file/<image_id>
--      without a query string (no signature / expiry) — stored as given.
--      The canonical DB row is the cache: an item is re-read only when it is
--      unknown, older than ADS_PRODUCT_ENRICHMENT_TTL_HOURS, or on an admin
--      refresh. A row is never deleted because an item disappeared: the
--      campaign history keeps its provider_item_id.
--   C. shopee_ads_shop_settings: per-shop enrichment switch (default OFF) +
--      the scheduler's slot bookkeeping.
--   D. RPCs: enrichment candidates / status (service_role), and
--      ads_dashboard_campaigns now returns the advertised items' metadata
--      (one aggregated request, no N+1).
--
-- shopee_ads_campaign_products stays the only campaign ↔ item mapping; its
-- item_name_snapshot column is left unused (the canonical current name is
-- shopee_ads_products.product_name). No legacy product table is touched.
-- Nothing here writes to Shopee.
-- ============================================================


-- ============================================================
-- A. job type
-- ============================================================
ALTER TABLE public.channel_sync_jobs DROP CONSTRAINT channel_sync_jobs_sync_type_check;
ALTER TABLE public.channel_sync_jobs ADD CONSTRAINT channel_sync_jobs_sync_type_check
  CHECK (sync_type IN (
    'product', 'order', 'escrow', 'income', 'return', 'payout', 'return_logistics', 'failed_delivery',
    'ads_campaign_read', 'ads_campaign_performance_read', 'ads_shop_performance_read',
    'ads_shop_hourly_read', 'ads_campaign_hourly_read',
    'ads_product_enrichment_read'
  ));

-- Same function as 00067, with the enrichment read type allowed.
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
  IF p_sync_type NOT IN ('ads_campaign_read', 'ads_campaign_performance_read', 'ads_shop_performance_read', 'ads_shop_hourly_read', 'ads_campaign_hourly_read', 'ads_product_enrichment_read') THEN
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
-- B. Ads product metadata (grain: shop × provider_item_id)
-- ============================================================
CREATE TABLE public.shopee_ads_products (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  -- provider ids are 64-bit integers: kept as text (never a JS number), same as campaign_products
  provider_item_id   text        NOT NULL CHECK (provider_item_id ~ '^[0-9]{1,20}$'),
  product_name       text,
  -- first image as returned (verified host cf.shopee.vn, no query string); anything else is not stored
  image_url          text        CHECK (image_url IS NULL OR image_url ~ '^https://[a-z0-9.-]+/file/[A-Za-z0-9_-]+$'),
  item_sku           text,
  -- raw provider value (verified: NORMAL / UNLIST / SELLER_DELETE; others stored as-is)
  provider_status    text,
  -- enriched     = the provider returned this item (metadata above is current)
  -- not_returned = the last read did not return it (metadata of an earlier read is kept; NOT a claim of deletion)
  enrichment_status  text        NOT NULL CHECK (enrichment_status IN ('enriched', 'not_returned')),
  last_enriched_at   timestamptz,
  -- last read attempt (returned or not): drives the TTL, so a missing item is not re-read every cycle
  last_checked_at    timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider_item_id)
);
-- the unique key serves the campaign join (shop_id, provider_item_id) and per-shop scans; no other index needed

CREATE TRIGGER set_shopee_ads_products_updated_at BEFORE UPDATE ON public.shopee_ads_products
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.shopee_ads_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shopee_ads_products FROM anon, authenticated;
-- cloud has no default grants: explicit
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopee_ads_products TO service_role;
GRANT SELECT ON public.shopee_ads_products TO authenticated;
CREATE POLICY active_users_select ON public.shopee_ads_products FOR SELECT TO authenticated USING (public.is_active_user());


-- ============================================================
-- C. per-shop enrichment switch + slot bookkeeping
-- ============================================================
ALTER TABLE public.shopee_ads_shop_settings
  -- rollout switch: OFF for every shop until an admin enables it (pilot first)
  ADD COLUMN ads_product_enrichment_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN product_enrichment_enabled_at   timestamptz,
  ADD COLUMN last_product_enrichment_slot_at timestamptz;


-- ============================================================
-- D. RPCs (service_role only)
-- ============================================================
-- Need-set of ONE shop: distinct items referenced by its Ads campaigns that are
-- unknown, or last checked before p_stale_before (p_force: every referenced item).
-- Unknown items first, then the oldest checks.
CREATE FUNCTION public.ads_product_enrichment_candidates(p_shop_id uuid, p_stale_before timestamptz, p_force boolean DEFAULT false, p_limit integer DEFAULT 2000)
RETURNS TABLE (provider_item_id text, reason text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH ref AS (
    SELECT DISTINCT cp.provider_item_id FROM public.shopee_ads_campaign_products cp WHERE cp.shop_id = p_shop_id
  )
  SELECT ref.provider_item_id,
         CASE WHEN p.id IS NULL THEN 'missing' WHEN p.last_checked_at < p_stale_before THEN 'stale' ELSE 'forced' END
  FROM ref
  LEFT JOIN public.shopee_ads_products p ON p.shop_id = p_shop_id AND p.provider_item_id = ref.provider_item_id
  WHERE p.id IS NULL OR p.last_checked_at < p_stale_before OR p_force
  ORDER BY (p.id IS NULL) DESC, p.last_checked_at ASC NULLS FIRST, ref.provider_item_id
  LIMIT GREATEST(p_limit, 1);
$$;

-- Per shop: referenced items and their cache state (admin panel, scheduler need check).
CREATE FUNCTION public.ads_product_enrichment_summary(p_shop_ids uuid[], p_stale_before timestamptz)
RETURNS TABLE (shop_id uuid, referenced integer, enriched integer, not_returned integer, missing integer, stale integer, with_image integer, with_sku integer, last_enriched_at timestamptz)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH ref AS (
    SELECT DISTINCT cp.shop_id, cp.provider_item_id FROM public.shopee_ads_campaign_products cp WHERE cp.shop_id = ANY (p_shop_ids)
  )
  SELECT ref.shop_id,
         count(*)::integer,
         count(*) FILTER (WHERE p.enrichment_status = 'enriched')::integer,
         count(*) FILTER (WHERE p.enrichment_status = 'not_returned')::integer,
         count(*) FILTER (WHERE p.id IS NULL)::integer,
         count(*) FILTER (WHERE p.last_checked_at < p_stale_before)::integer,
         count(*) FILTER (WHERE p.image_url IS NOT NULL)::integer,
         count(*) FILTER (WHERE p.item_sku IS NOT NULL)::integer,
         max(p.last_enriched_at)
  FROM ref
  LEFT JOIN public.shopee_ads_products p ON p.shop_id = ref.shop_id AND p.provider_item_id = ref.provider_item_id
  GROUP BY ref.shop_id;
$$;

-- Campaign table: + the advertised items' current metadata (scoped by shop).
-- The return type changes → drop + create (same arguments, same grants below).
DROP FUNCTION public.ads_dashboard_campaigns(uuid[], date, date);
CREATE FUNCTION public.ads_dashboard_campaigns(p_shop_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  campaign_id uuid, shop_id uuid, provider_campaign_id text, campaign_name text,
  provider_status text, provider_ad_type text, provider_bidding_method text, provider_placement text,
  daily_budget numeric, roas_target numeric, provider_start_at timestamptz, provider_end_at timestamptz,
  last_synced_at timestamptz, item_ids text[],
  expense numeric, impression bigint, clicks bigint, direct_order bigint, broad_order bigint,
  direct_gmv numeric, broad_gmv numeric, direct_item_sold bigint, broad_item_sold bigint,
  days_with_rows integer, daily jsonb,
  -- [{i: item id, n: name, img: image url, sku, st: provider status, es: enrichment status}] (null fields = not known)
  products jsonb
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.id, c.shop_id, c.provider_campaign_id, c.campaign_name,
         c.provider_status, c.provider_ad_type, c.provider_bidding_method, c.provider_placement,
         c.daily_budget, c.roas_target, c.provider_start_at, c.provider_end_at, c.last_synced_at,
         COALESCE((SELECT array_agg(p.provider_item_id ORDER BY p.provider_item_id) FROM public.shopee_ads_campaign_products p WHERE p.campaign_id = c.id), ARRAY[]::text[]),
         COALESCE(sum(f.expense), 0), COALESCE(sum(f.impression), 0)::bigint, COALESCE(sum(f.clicks), 0)::bigint,
         COALESCE(sum(f.direct_order), 0)::bigint, COALESCE(sum(f.broad_order), 0)::bigint,
         COALESCE(sum(f.direct_gmv), 0), COALESCE(sum(f.broad_gmv), 0),
         COALESCE(sum(f.direct_item_sold), 0)::bigint, COALESCE(sum(f.broad_item_sold), 0)::bigint,
         count(f.id)::integer,
         COALESCE(jsonb_agg(jsonb_build_object('d', f.report_date, 'e', f.expense, 'g', f.broad_gmv) ORDER BY f.report_date) FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb),
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object('i', cp.provider_item_id, 'n', ap.product_name, 'img', ap.image_url, 'sku', ap.item_sku, 'st', ap.provider_status, 'es', ap.enrichment_status) ORDER BY cp.provider_item_id)
           FROM public.shopee_ads_campaign_products cp
           LEFT JOIN public.shopee_ads_products ap ON ap.shop_id = cp.shop_id AND ap.provider_item_id = cp.provider_item_id
           WHERE cp.campaign_id = c.id
         ), '[]'::jsonb)
  FROM public.shopee_ads_campaigns c
  LEFT JOIN public.shopee_ads_campaign_daily_performance f
         ON f.campaign_id = c.id AND f.report_date BETWEEN p_from AND p_to
  WHERE c.shop_id = ANY (p_shop_ids)
  GROUP BY c.id;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'enqueue_ads_sync_job(uuid, text, text, text, integer, jsonb, date, date, timestamptz, uuid, boolean, integer)',
    'ads_product_enrichment_candidates(uuid, timestamptz, boolean, integer)',
    'ads_product_enrichment_summary(uuid[], timestamptz)',
    'ads_dashboard_campaigns(uuid[], date, date)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
