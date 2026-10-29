-- ============================================================
-- SHOPEE-ADS-2.1: multi-shop data-gap fixes (READ ONLY — nothing here talks to Shopee).
--
--   A. shopee_ads_shop_settings.{shop,campaign}_backfill_completed_at
--      "performance synced" used to mean "any performance read succeeded".
--      A failed 30-day backfill followed by a successful 15-minute HOT read
--      therefore marked the shop as backfilled for good, and the missing
--      days were never read again (congtrangbedding, 2026-10-29). The
--      scheduler / manual refresh now re-run the backfill until a BACKFILL
--      job of that type has finished.
--   B. shopee_ads_campaigns.performance_unsupported_at
--      Shopee refuses the whole get_product_campaign_daily_performance batch
--      when one id is not a product-ads campaign ("invalid product ads
--      campaign ids- …"). The runner drops such ids and remembers them here
--      so later jobs do not spend a call rediscovering them.
-- ============================================================

ALTER TABLE public.shopee_ads_shop_settings
  ADD COLUMN IF NOT EXISTS shop_backfill_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS campaign_backfill_completed_at timestamptz;

ALTER TABLE public.shopee_ads_campaigns
  ADD COLUMN IF NOT EXISTS performance_unsupported_at timestamptz;

-- Existing shops: a successful backfill job of that type is the evidence.
INSERT INTO public.shopee_ads_shop_settings (shop_id, shop_backfill_completed_at, campaign_backfill_completed_at)
SELECT j.shop_id,
       max(j.finished_at) FILTER (WHERE j.sync_type = 'ads_shop_performance_read'),
       max(j.finished_at) FILTER (WHERE j.sync_type = 'ads_campaign_performance_read')
FROM public.channel_sync_jobs j
WHERE j.status = 'success'
  AND j.sync_type IN ('ads_shop_performance_read', 'ads_campaign_performance_read')
  AND (j.metadata->>'strategy' = 'backfill' OR j.mode = 'backfill')
GROUP BY j.shop_id
ON CONFLICT (shop_id) DO UPDATE
  SET shop_backfill_completed_at = COALESCE(public.shopee_ads_shop_settings.shop_backfill_completed_at, EXCLUDED.shop_backfill_completed_at),
      campaign_backfill_completed_at = COALESCE(public.shopee_ads_shop_settings.campaign_backfill_completed_at, EXCLUDED.campaign_backfill_completed_at);

-- Shops whose backfill job rows are gone (pruned / earlier phases) but whose stored data
-- already covers the window: Shopee returns one row per day (shop) and per campaign per day
-- (zeros included), so ≥ 28 days per campaign means the 30-day read happened.
WITH shop_days AS (
  SELECT shop_id, count(DISTINCT report_date) AS days
  FROM public.shopee_ads_shop_daily_performance
  WHERE report_date >= current_date - 30
  GROUP BY shop_id
), campaign_rows AS (
  SELECT c.shop_id, count(DISTINCT c.id) AS campaigns, count(f.id) AS rows
  FROM public.shopee_ads_campaigns c
  LEFT JOIN public.shopee_ads_campaign_daily_performance f ON f.campaign_id = c.id AND f.report_date >= current_date - 30
  GROUP BY c.shop_id
), evidence AS (
  SELECT s.id AS shop_id,
         CASE WHEN COALESCE(d.days, 0) >= 28 THEN now() END AS shop_done,
         CASE WHEN COALESCE(r.campaigns, 0) > 0 AND r.rows >= 28 * r.campaigns THEN now() END AS campaign_done
  FROM public.shops s
  LEFT JOIN shop_days d ON d.shop_id = s.id
  LEFT JOIN campaign_rows r ON r.shop_id = s.id
)
INSERT INTO public.shopee_ads_shop_settings (shop_id, shop_backfill_completed_at, campaign_backfill_completed_at)
SELECT shop_id, shop_done, campaign_done FROM evidence WHERE shop_done IS NOT NULL OR campaign_done IS NOT NULL
ON CONFLICT (shop_id) DO UPDATE
  SET shop_backfill_completed_at = COALESCE(public.shopee_ads_shop_settings.shop_backfill_completed_at, EXCLUDED.shop_backfill_completed_at),
      campaign_backfill_completed_at = COALESCE(public.shopee_ads_shop_settings.campaign_backfill_completed_at, EXCLUDED.campaign_backfill_completed_at);
