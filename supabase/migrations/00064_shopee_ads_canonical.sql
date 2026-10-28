-- ============================================================
-- SHOPEE-ADS-1B: canonical Shopee Ads data model (READ-ONLY analytics).
--
-- Designed from VERIFIED production payloads (docs/shopee-ads-api.md §3, §3.5):
--   shop → product-level campaign (provider campaign_id) → advertised item(s)
--
--   shopee_ads_campaigns                  one row per (shop, provider campaign id)
--   shopee_ads_campaign_products          campaign ↔ advertised item (item_id_list)
--   shopee_ads_campaign_daily_performance campaign × report_date primitives
--   shopee_ads_shop_daily_performance     shop × report_date primitives — its OWN
--                                         fact table: the shop-level "all CPC ads"
--                                         total is LARGER than Σ product campaigns
--                                         (verified 27/10, full coverage). Never
--                                         derive one from the other.
--
-- Only primitives are stored (spend, impressions, clicks, direct/broad orders,
-- direct/broad GMV, direct/broad items sold). Provider ratios (ctr, roas, roi,
-- cir, cr, cpc, cpdc …) are NOT stored: all are derivable and rounded — and
-- the campaign-level "cpc" is expense / broad_order, not cost per click.
-- Money: provider integer VND (đồng) → NUMERIC(18,2). No currency column:
-- the provider returns none (currency is inferred from shops.region = VN).
-- Raw payloads: channel_api_snapshots, entity_type 'ads'.
--
-- The system NEVER writes to Shopee Ads (read-only policy); these tables are
-- written only by the read-only sync worker (service role).
-- ============================================================

-- ------------------------------------------------------------
-- A. Ads read job types in the existing queue (read-only names: ads_<what>_read)
-- ------------------------------------------------------------
ALTER TABLE public.channel_sync_jobs DROP CONSTRAINT channel_sync_jobs_sync_type_check;
ALTER TABLE public.channel_sync_jobs ADD CONSTRAINT channel_sync_jobs_sync_type_check
  CHECK (sync_type IN (
    'product', 'order', 'escrow', 'income', 'return', 'payout', 'return_logistics', 'failed_delivery',
    'ads_campaign_read', 'ads_campaign_performance_read', 'ads_shop_performance_read'
  ));


-- ------------------------------------------------------------
-- B. Campaigns
-- ------------------------------------------------------------
CREATE TABLE public.shopee_ads_campaigns (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                  uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  -- provider ids are 64-bit integers: kept as text (never a JS number)
  provider_campaign_id     text          NOT NULL CHECK (provider_campaign_id ~ '^[0-9]{1,20}$'),
  campaign_name            text,
  -- raw provider values (verified: ongoing / paused / closed / ended; unknown future values stored as-is)
  provider_status          text          NOT NULL,
  provider_ad_type         text,
  provider_bidding_method  text,
  provider_placement       text,
  -- verified to be a DAILY spend cap (docs §3.5); 0 = meaning unknown, kept as provided
  daily_budget             numeric(18,2) CHECK (daily_budget IS NULL OR daily_budget >= 0),
  -- only present for bidding_method = auto; 0 = meaning unknown
  roas_target              numeric(10,4) CHECK (roas_target IS NULL OR roas_target >= 0),
  -- provider epoch SECONDS (verified); end 0 = no end date → NULL
  provider_start_at        timestamptz,
  provider_end_at          timestamptz,
  last_synced_at           timestamptz   NOT NULL,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider_campaign_id),
  UNIQUE (id, shop_id)
);
CREATE INDEX idx_shopee_ads_campaigns_status ON public.shopee_ads_campaigns (shop_id, provider_status);


-- ------------------------------------------------------------
-- C. Campaign ↔ advertised item
-- ------------------------------------------------------------
CREATE TABLE public.shopee_ads_campaign_products (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid        NOT NULL,
  campaign_id         uuid        NOT NULL,
  provider_item_id    text        NOT NULL CHECK (provider_item_id ~ '^[0-9]{1,20}$'),
  -- the Ads API returns no item names; filled only if a later read provides one
  item_name_snapshot  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, provider_item_id),
  -- composite FK: a relation can never point at another shop's campaign
  FOREIGN KEY (campaign_id, shop_id) REFERENCES public.shopee_ads_campaigns (id, shop_id) ON DELETE CASCADE
);


-- ------------------------------------------------------------
-- D. Campaign daily performance (grain: campaign × report_date)
-- ------------------------------------------------------------
CREATE TABLE public.shopee_ads_campaign_daily_performance (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid          NOT NULL,
  campaign_id       uuid          NOT NULL,
  report_date       date          NOT NULL,
  expense           numeric(18,2) NOT NULL DEFAULT 0 CHECK (expense >= 0),
  impression        bigint        NOT NULL DEFAULT 0 CHECK (impression >= 0),
  clicks            bigint        NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  direct_order      bigint        NOT NULL DEFAULT 0 CHECK (direct_order >= 0),
  broad_order       bigint        NOT NULL DEFAULT 0 CHECK (broad_order >= 0),
  direct_gmv        numeric(18,2) NOT NULL DEFAULT 0 CHECK (direct_gmv >= 0),
  broad_gmv         numeric(18,2) NOT NULL DEFAULT 0 CHECK (broad_gmv >= 0),
  -- campaign payload field *_order_amount (≈ units sold, LIKELY — docs §3.2)
  direct_item_sold  bigint        NOT NULL DEFAULT 0 CHECK (direct_item_sold >= 0),
  broad_item_sold   bigint        NOT NULL DEFAULT 0 CHECK (broad_item_sold >= 0),
  last_synced_at    timestamptz   NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, report_date),
  FOREIGN KEY (campaign_id, shop_id) REFERENCES public.shopee_ads_campaigns (id, shop_id) ON DELETE CASCADE
);
CREATE INDEX idx_shopee_ads_cdp_shop_date ON public.shopee_ads_campaign_daily_performance (shop_id, report_date);


-- ------------------------------------------------------------
-- E. Shop daily performance (grain: shop × report_date) — independent fact
-- ------------------------------------------------------------
CREATE TABLE public.shopee_ads_shop_daily_performance (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  report_date       date          NOT NULL,
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
  UNIQUE (shop_id, report_date)
);


-- ------------------------------------------------------------
-- F. updated_at triggers, RLS, grants (cloud has no default grants — explicit)
-- ------------------------------------------------------------
CREATE TRIGGER set_shopee_ads_campaigns_updated_at BEFORE UPDATE ON public.shopee_ads_campaigns                  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_shopee_ads_products_updated_at  BEFORE UPDATE ON public.shopee_ads_campaign_products          FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_shopee_ads_cdp_updated_at       BEFORE UPDATE ON public.shopee_ads_campaign_daily_performance FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_shopee_ads_sdp_updated_at       BEFORE UPDATE ON public.shopee_ads_shop_daily_performance     FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shopee_ads_campaigns',
    'shopee_ads_campaign_products',
    'shopee_ads_campaign_daily_performance',
    'shopee_ads_shop_daily_performance'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    -- same access model as every channel table: active users read, nobody writes from the client
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY active_users_select ON public.%I FOR SELECT TO authenticated USING (public.is_active_user())', t);
  END LOOP;
END;
$$;


-- ------------------------------------------------------------
-- G. Dashboard read RPCs (server-side aggregation; PostgREST caps rows at 1000)
-- ------------------------------------------------------------

-- Shop-level facts per day, primitives summed across the selected shops.
-- The dashboard OVERVIEW and TREND read only this (never campaign sums).
CREATE OR REPLACE FUNCTION public.ads_dashboard_shop_daily(p_shop_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  report_date date, expense numeric, impression bigint, clicks bigint,
  direct_order bigint, broad_order bigint, direct_gmv numeric, broad_gmv numeric,
  direct_item_sold bigint, broad_item_sold bigint, shops_with_data integer
)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT f.report_date,
         sum(f.expense), sum(f.impression)::bigint, sum(f.clicks)::bigint,
         sum(f.direct_order)::bigint, sum(f.broad_order)::bigint, sum(f.direct_gmv), sum(f.broad_gmv),
         sum(f.direct_item_sold)::bigint, sum(f.broad_item_sold)::bigint, count(DISTINCT f.shop_id)::integer
  FROM public.shopee_ads_shop_daily_performance f
  WHERE f.shop_id = ANY (p_shop_ids) AND f.report_date BETWEEN p_from AND p_to
  GROUP BY f.report_date
  ORDER BY f.report_date;
$$;

-- Every campaign of the selected shops with its primitives summed over the
-- range (0 when no row) + its daily spend / broad GMV series + item ids.
CREATE OR REPLACE FUNCTION public.ads_dashboard_campaigns(p_shop_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  campaign_id uuid, shop_id uuid, provider_campaign_id text, campaign_name text,
  provider_status text, provider_ad_type text, provider_bidding_method text, provider_placement text,
  daily_budget numeric, roas_target numeric, provider_start_at timestamptz, provider_end_at timestamptz,
  last_synced_at timestamptz, item_ids text[],
  expense numeric, impression bigint, clicks bigint, direct_order bigint, broad_order bigint,
  direct_gmv numeric, broad_gmv numeric, direct_item_sold bigint, broad_item_sold bigint,
  days_with_rows integer, daily jsonb
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
         COALESCE(jsonb_agg(jsonb_build_object('d', f.report_date, 'e', f.expense, 'g', f.broad_gmv) ORDER BY f.report_date) FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb)
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
    'ads_dashboard_shop_daily(uuid[], date, date)',
    'ads_dashboard_campaigns(uuid[], date, date)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
