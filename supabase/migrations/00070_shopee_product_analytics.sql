-- ============================================================
-- PHASE SHOPEE-PRODUCT-ANALYTICS-2: canonical product metrics + minimal
-- sales facts (READ ONLY towards Shopee; no legacy module is revived).
--
--   A. job types product_sales_facts_read / product_extra_info_read
--      (NEW isolated domain — the legacy 'order' / 'product' jobs stay retired)
--   B. shopee_products                 canonical identity (shop × provider_item_id),
--                                      independent of Ads; fed by Ads enrichment,
--                                      Ads campaign links and order lines
--   C. shopee_product_sales_facts      one row per ORDER LINE
--                                      (shop × provider_order_id × provider_line_item_id)
--   D. shopee_product_extra_snapshots  get_item_extra_info SNAPSHOTS (semantics UNKNOWN:
--                                      never turned into daily facts)
--   E. product_analytics_shop_settings per-shop switches (default OFF) + slot bookkeeping
--   F. views: shopee_product_daily_metrics, shopee_product_campaign_links
--   G. RPCs (service_role only; the server authorizes before calling)
--
-- Semantics (verified on 7 492 real production order snapshots, 2026-10-14 → 10-28,
-- docs/product-analytics-schema.md):
--   * (order, item, model) is NOT unique inside an order (11 cases: gift / add-on
--     lines of the same model) → the line identity is line_item_id (0 duplicates).
--   * model_discounted_price is a UNIT price (integer VND); gross_amount =
--     unit discounted price × quantity = item subtotal BEFORE shop / platform
--     vouchers and shipping. order total_amount is NOT allocated per item by
--     the endpoint → refund / voucher-adjusted net sales are UNSUPPORTED.
--   * report_date = order create_time in Asia/Ho_Chi_Minh (= Asia/Bangkok, UTC+7).
--   * No buyer data is stored (no name / phone / address / message_to_seller).
-- ============================================================


-- ============================================================
-- A. job types
-- ============================================================
ALTER TABLE public.channel_sync_jobs DROP CONSTRAINT channel_sync_jobs_sync_type_check;
ALTER TABLE public.channel_sync_jobs ADD CONSTRAINT channel_sync_jobs_sync_type_check
  CHECK (sync_type IN (
    'product', 'order', 'escrow', 'income', 'return', 'payout', 'return_logistics', 'failed_delivery',
    'ads_campaign_read', 'ads_campaign_performance_read', 'ads_shop_performance_read',
    'ads_shop_hourly_read', 'ads_campaign_hourly_read',
    'ads_product_enrichment_read',
    'product_sales_facts_read', 'product_extra_info_read'
  ));


-- ============================================================
-- B. canonical product identity
-- ============================================================
CREATE TABLE public.shopee_products (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider_item_id     text        NOT NULL CHECK (provider_item_id ~ '^[0-9]{1,20}$'),
  name                 text,
  sku                  text,
  image_url            text        CHECK (image_url IS NULL OR image_url ~ '^https://[a-z0-9.-]+/file/[A-Za-z0-9_-]+$'),
  provider_status      text,
  -- where name / sku / image come from: ads_enrichment (current, get_item_base_info) wins over
  -- order_line (the name as sold, possibly old)
  metadata_source      text        CHECK (metadata_source IN ('ads_enrichment', 'order_line')),
  metadata_updated_at  timestamptz,
  first_seen_source    text        NOT NULL CHECK (first_seen_source IN ('ads_campaign', 'ads_enrichment', 'order_line', 'extra_info')),
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider_item_id)
);
CREATE TRIGGER set_shopee_products_updated_at BEFORE UPDATE ON public.shopee_products
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Ads enrichment → identity (current metadata). Not returned items keep their identity.
CREATE FUNCTION public.shopee_products_from_ads_product()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.shopee_products AS p (shop_id, provider_item_id, name, sku, image_url, provider_status, metadata_source, metadata_updated_at, first_seen_source)
  VALUES (NEW.shop_id, NEW.provider_item_id,
          CASE WHEN NEW.enrichment_status = 'enriched' THEN NEW.product_name END,
          CASE WHEN NEW.enrichment_status = 'enriched' THEN NEW.item_sku END,
          CASE WHEN NEW.enrichment_status = 'enriched' THEN NEW.image_url END,
          CASE WHEN NEW.enrichment_status = 'enriched' THEN NEW.provider_status END,
          CASE WHEN NEW.enrichment_status = 'enriched' THEN 'ads_enrichment' END,
          CASE WHEN NEW.enrichment_status = 'enriched' THEN COALESCE(NEW.last_enriched_at, now()) END,
          'ads_enrichment')
  ON CONFLICT (shop_id, provider_item_id) DO UPDATE
    SET name = EXCLUDED.name, sku = EXCLUDED.sku, image_url = EXCLUDED.image_url,
        provider_status = EXCLUDED.provider_status, metadata_source = 'ads_enrichment',
        metadata_updated_at = EXCLUDED.metadata_updated_at
    WHERE NEW.enrichment_status = 'enriched'
      AND (p.name, p.sku, p.image_url, p.provider_status, p.metadata_source)
          IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.sku, EXCLUDED.image_url, EXCLUDED.provider_status, 'ads_enrichment');
  RETURN NEW;
END;
$$;
CREATE TRIGGER shopee_products_sync_ads_product AFTER INSERT OR UPDATE ON public.shopee_ads_products
  FOR EACH ROW EXECUTE FUNCTION public.shopee_products_from_ads_product();

-- Ads campaign link → identity only (metadata arrives with enrichment / orders).
CREATE FUNCTION public.shopee_products_from_campaign_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.shopee_products (shop_id, provider_item_id, first_seen_source)
  VALUES (NEW.shop_id, NEW.provider_item_id, 'ads_campaign')
  ON CONFLICT (shop_id, provider_item_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shopee_products_sync_campaign_link AFTER INSERT ON public.shopee_ads_campaign_products
  FOR EACH ROW EXECUTE FUNCTION public.shopee_products_from_campaign_link();

-- seed (non-destructive: shopee_ads_products stays as it is)
INSERT INTO public.shopee_products (shop_id, provider_item_id, name, sku, image_url, provider_status, metadata_source, metadata_updated_at, first_seen_source, first_seen_at)
SELECT a.shop_id, a.provider_item_id,
       CASE WHEN a.enrichment_status = 'enriched' THEN a.product_name END,
       CASE WHEN a.enrichment_status = 'enriched' THEN a.item_sku END,
       CASE WHEN a.enrichment_status = 'enriched' THEN a.image_url END,
       CASE WHEN a.enrichment_status = 'enriched' THEN a.provider_status END,
       CASE WHEN a.enrichment_status = 'enriched' THEN 'ads_enrichment' END,
       CASE WHEN a.enrichment_status = 'enriched' THEN a.last_enriched_at END,
       'ads_enrichment', a.created_at
FROM public.shopee_ads_products a
ON CONFLICT (shop_id, provider_item_id) DO NOTHING;
INSERT INTO public.shopee_products (shop_id, provider_item_id, first_seen_source, first_seen_at)
SELECT cp.shop_id, cp.provider_item_id, 'ads_campaign', min(cp.created_at)
FROM public.shopee_ads_campaign_products cp
GROUP BY 1, 2
ON CONFLICT (shop_id, provider_item_id) DO NOTHING;

-- the Zalo conversation remembers a CANONICAL product (column unused until now: always NULL)
ALTER TABLE public.ai_conversations DROP CONSTRAINT IF EXISTS ai_conversations_current_product_id_fkey;
UPDATE public.ai_conversations SET current_product_id = NULL WHERE current_product_id IS NOT NULL;
ALTER TABLE public.ai_conversations ADD CONSTRAINT ai_conversations_current_product_id_fkey
  FOREIGN KEY (current_product_id) REFERENCES public.shopee_products(id) ON DELETE SET NULL;


-- ============================================================
-- C. sales facts (grain: one order line)
-- ============================================================
CREATE TABLE public.shopee_product_sales_facts (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider_order_id      text          NOT NULL CHECK (length(provider_order_id) BETWEEN 1 AND 64),
  -- verified unique per order (line_item_id); order_item_id is NOT (bundle deals share it)
  provider_line_item_id  text          NOT NULL CHECK (provider_line_item_id ~ '^[0-9]{1,20}$'),
  provider_order_item_id text,
  provider_item_id       text          NOT NULL CHECK (provider_item_id ~ '^[0-9]{1,20}$'),
  provider_model_id      text          CHECK (provider_model_id IS NULL OR provider_model_id ~ '^[0-9]{1,20}$'),
  order_status           text          NOT NULL,
  -- classifyProductSalesOrderStatus() (src/lib/product-analytics/sales-status.ts) — the ONE mapping
  status_class           text          NOT NULL CHECK (status_class IN ('pending_payment', 'open', 'completed', 'return_in_progress', 'cancel_pending', 'cancelled', 'unknown')),
  is_cancelled           boolean       NOT NULL,
  is_completed           boolean       NOT NULL,
  is_valid_for_sales     boolean       NOT NULL,
  order_created_at       timestamptz   NOT NULL,
  order_updated_at       timestamptz,
  paid_at                timestamptz,
  report_date            date          NOT NULL,
  quantity               integer       NOT NULL CHECK (quantity > 0),
  cancelled_qty          integer       NOT NULL DEFAULT 0 CHECK (cancelled_qty >= 0),
  returned_qty           integer       NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  -- unit prices exactly as returned (NUMERIC, never a JS float)
  unit_original_price    numeric(18,2) CHECK (unit_original_price IS NULL OR unit_original_price >= 0),
  unit_discounted_price  numeric(18,2) CHECK (unit_discounted_price IS NULL OR unit_discounted_price >= 0),
  -- unit_discounted_price × quantity: item subtotal before vouchers / shipping (NOT paid allocation)
  gross_amount           numeric(18,2) CHECK (gross_amount IS NULL OR gross_amount >= 0),
  currency               text          CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  promotion_type         text,
  -- add_on_free_gift_sub lines: a gift attached to another purchase, not a sale of this product
  is_free_gift           boolean       NOT NULL DEFAULT false,
  -- what the daily metrics add up (0 when not valid for sales / free gift; quantity − cancelled_qty otherwise)
  valid_quantity         integer       NOT NULL DEFAULT 0 CHECK (valid_quantity >= 0),
  valid_amount           numeric(18,2) NOT NULL DEFAULT 0 CHECK (valid_amount >= 0),
  -- provider update_time of the order: an older read never overwrites a newer one
  source_updated_at      timestamptz   NOT NULL,
  first_seen_at          timestamptz   NOT NULL DEFAULT now(),
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider_order_id, provider_line_item_id)
);
CREATE INDEX idx_shopee_psf_shop_item_date ON public.shopee_product_sales_facts (shop_id, provider_item_id, report_date);
CREATE INDEX idx_shopee_psf_shop_date ON public.shopee_product_sales_facts (shop_id, report_date);
CREATE TRIGGER set_shopee_psf_updated_at BEFORE UPDATE ON public.shopee_product_sales_facts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- ============================================================
-- D. get_item_extra_info snapshots (semantics UNKNOWN — snapshot metrics only)
-- ============================================================
CREATE TABLE public.shopee_product_extra_snapshots (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid         NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider_item_id  text         NOT NULL CHECK (provider_item_id ~ '^[0-9]{1,20}$'),
  captured_at       timestamptz  NOT NULL,
  sale              bigint       CHECK (sale IS NULL OR sale >= 0),
  views             bigint       CHECK (views IS NULL OR views >= 0),
  likes             bigint       CHECK (likes IS NULL OR likes >= 0),
  rating_star       numeric(4,2) CHECK (rating_star IS NULL OR rating_star BETWEEN 0 AND 5),
  comment_count     bigint       CHECK (comment_count IS NULL OR comment_count >= 0),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider_item_id, captured_at)
);


-- ============================================================
-- E. per-shop switches (rollout: OFF until an admin enables a shop) + slots
-- ============================================================
CREATE TABLE public.product_analytics_shop_settings (
  shop_id                 uuid        PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  sales_sync_enabled      boolean     NOT NULL DEFAULT false,
  extra_info_enabled      boolean     NOT NULL DEFAULT false,
  enabled_at              timestamptz,
  -- set by the backfill job when its whole window succeeded (until then: backfill replaces COLD)
  sales_backfill_done_at  timestamptz,
  last_sales_hot_slot_at      timestamptz,
  last_sales_cold_slot_at     timestamptz,
  last_sales_backfill_slot_at timestamptz,
  last_extra_info_slot_at     timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE TRIGGER set_product_analytics_shop_settings_updated_at BEFORE UPDATE ON public.product_analytics_shop_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- RLS: authorized (active) users read; only service_role writes analytics facts
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shopee_products', 'shopee_product_sales_facts', 'shopee_product_extra_snapshots', 'product_analytics_shop_settings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY active_users_select ON public.%I FOR SELECT TO authenticated USING (public.is_active_user())', t);
  END LOOP;
END;
$$;


-- ============================================================
-- F. views
-- ============================================================
-- Canonical daily product sales (grain: shop × item × VN report date).
-- orders = DISTINCT orders with a counted line; units = Σ valid_quantity; GMV = Σ valid_amount.
CREATE VIEW public.shopee_product_daily_metrics WITH (security_invoker = true) AS
SELECT f.shop_id, f.provider_item_id, f.report_date,
       count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0) AS orders,
       COALESCE(sum(f.valid_quantity), 0)::bigint AS units_sold,
       COALESCE(sum(f.valid_amount), 0)::numeric(18,2) AS sales_gmv,
       count(DISTINCT f.provider_order_id) FILTER (WHERE f.is_cancelled) AS cancelled_orders,
       max(f.updated_at) AS last_fact_updated_at
FROM public.shopee_product_sales_facts f
GROUP BY f.shop_id, f.provider_item_id, f.report_date;

-- Campaign ↔ product, with whether the campaign advertises ONLY this product.
-- Product-level Ads metrics use single_item campaigns only (a shared campaign's
-- spend cannot be split per item from campaign-level reports).
CREATE VIEW public.shopee_product_campaign_links WITH (security_invoker = true) AS
SELECT cp.shop_id, cp.provider_item_id, cp.campaign_id,
       (count(*) OVER (PARTITION BY cp.campaign_id)) = 1 AS single_item
FROM public.shopee_ads_campaign_products cp;

REVOKE ALL ON public.shopee_product_daily_metrics, public.shopee_product_campaign_links FROM anon, authenticated;
GRANT SELECT ON public.shopee_product_daily_metrics, public.shopee_product_campaign_links TO service_role, authenticated;


-- ============================================================
-- G. RPCs
-- ============================================================

-- Idempotent fact upsert for ONE shop. p_rows: [{provider_order_id, provider_line_item_id, …}]
-- (built by src/lib/product-analytics/sales-facts.ts). A row whose source_updated_at is older
-- than the stored one is skipped (restatement-safe overlap). Also records order-line identity.
CREATE FUNCTION public.upsert_shopee_product_sales_facts(p_shop_id uuid, p_rows jsonb)
RETURNS TABLE (inserted integer, updated integer, skipped_stale integer, products_created integer)
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_ins integer := 0;
  v_upd integer := 0;
  v_total integer := 0;
  v_prod integer := 0;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'p_rows must be an array'; END IF;
  v_total := jsonb_array_length(p_rows);

  WITH src AS (
    SELECT r.*
    FROM jsonb_to_recordset(p_rows) AS r(
      provider_order_id text, provider_line_item_id text, provider_order_item_id text,
      provider_item_id text, provider_model_id text, order_status text, status_class text,
      is_cancelled boolean, is_completed boolean, is_valid_for_sales boolean,
      order_created_at timestamptz, order_updated_at timestamptz, paid_at timestamptz,
      quantity integer, cancelled_qty integer, returned_qty integer,
      unit_original_price numeric, unit_discounted_price numeric, currency text,
      promotion_type text, is_free_gift boolean, source_updated_at timestamptz,
      item_name text, item_sku text, image_url text)
  ), up AS (
    INSERT INTO public.shopee_product_sales_facts AS t (
      shop_id, provider_order_id, provider_line_item_id, provider_order_item_id, provider_item_id, provider_model_id,
      order_status, status_class, is_cancelled, is_completed, is_valid_for_sales,
      order_created_at, order_updated_at, paid_at, report_date,
      quantity, cancelled_qty, returned_qty, unit_original_price, unit_discounted_price, gross_amount,
      currency, promotion_type, is_free_gift, valid_quantity, valid_amount, source_updated_at)
    SELECT p_shop_id, s.provider_order_id, s.provider_line_item_id, s.provider_order_item_id, s.provider_item_id, s.provider_model_id,
           s.order_status, s.status_class, s.is_cancelled, s.is_completed, s.is_valid_for_sales,
           s.order_created_at, s.order_updated_at, s.paid_at, (s.order_created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
           s.quantity, COALESCE(s.cancelled_qty, 0), COALESCE(s.returned_qty, 0), s.unit_original_price, s.unit_discounted_price,
           s.unit_discounted_price * s.quantity,
           s.currency, s.promotion_type, COALESCE(s.is_free_gift, false),
           CASE WHEN s.is_valid_for_sales AND NOT COALESCE(s.is_free_gift, false) THEN GREATEST(s.quantity - COALESCE(s.cancelled_qty, 0), 0) ELSE 0 END,
           CASE WHEN s.is_valid_for_sales AND NOT COALESCE(s.is_free_gift, false) THEN COALESCE(s.unit_discounted_price, 0) * GREATEST(s.quantity - COALESCE(s.cancelled_qty, 0), 0) ELSE 0 END,
           s.source_updated_at
    FROM src s
    ON CONFLICT (shop_id, provider_order_id, provider_line_item_id) DO UPDATE
      SET provider_order_item_id = EXCLUDED.provider_order_item_id,
          provider_item_id = EXCLUDED.provider_item_id, provider_model_id = EXCLUDED.provider_model_id,
          order_status = EXCLUDED.order_status, status_class = EXCLUDED.status_class,
          is_cancelled = EXCLUDED.is_cancelled, is_completed = EXCLUDED.is_completed, is_valid_for_sales = EXCLUDED.is_valid_for_sales,
          order_created_at = EXCLUDED.order_created_at, order_updated_at = EXCLUDED.order_updated_at, paid_at = EXCLUDED.paid_at,
          report_date = EXCLUDED.report_date, quantity = EXCLUDED.quantity, cancelled_qty = EXCLUDED.cancelled_qty, returned_qty = EXCLUDED.returned_qty,
          unit_original_price = EXCLUDED.unit_original_price, unit_discounted_price = EXCLUDED.unit_discounted_price, gross_amount = EXCLUDED.gross_amount,
          currency = EXCLUDED.currency, promotion_type = EXCLUDED.promotion_type, is_free_gift = EXCLUDED.is_free_gift,
          valid_quantity = EXCLUDED.valid_quantity, valid_amount = EXCLUDED.valid_amount, source_updated_at = EXCLUDED.source_updated_at
      WHERE EXCLUDED.source_updated_at >= t.source_updated_at
        AND (t.order_status, t.order_updated_at, t.quantity, t.cancelled_qty, t.returned_qty, t.unit_discounted_price, t.unit_original_price, t.status_class, t.is_free_gift, t.provider_model_id)
            IS DISTINCT FROM (EXCLUDED.order_status, EXCLUDED.order_updated_at, EXCLUDED.quantity, EXCLUDED.cancelled_qty, EXCLUDED.returned_qty, EXCLUDED.unit_discounted_price, EXCLUDED.unit_original_price, EXCLUDED.status_class, EXCLUDED.is_free_gift, EXCLUDED.provider_model_id)
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT count(*) FILTER (WHERE was_insert), count(*) FILTER (WHERE NOT was_insert) INTO v_ins, v_upd FROM up;

  -- identity of sold items (order-line metadata only fills what Ads enrichment has not)
  WITH items AS (
    SELECT DISTINCT ON (r.provider_item_id) r.provider_item_id, NULLIF(btrim(r.item_name), '') AS item_name, NULLIF(btrim(r.item_sku), '') AS item_sku,
           CASE WHEN r.image_url ~ '^https://[a-z0-9.-]+/file/[A-Za-z0-9_-]+$' THEN r.image_url END AS image_url, r.source_updated_at
    FROM jsonb_to_recordset(p_rows) AS r(provider_item_id text, item_name text, item_sku text, image_url text, source_updated_at timestamptz)
    ORDER BY r.provider_item_id, r.source_updated_at DESC
  ), ins AS (
    INSERT INTO public.shopee_products AS p (shop_id, provider_item_id, name, sku, image_url, metadata_source, metadata_updated_at, first_seen_source)
    SELECT p_shop_id, i.provider_item_id, i.item_name, i.item_sku, i.image_url, 'order_line', i.source_updated_at, 'order_line' FROM items i
    ON CONFLICT (shop_id, provider_item_id) DO UPDATE
      SET name = COALESCE(EXCLUDED.name, p.name), sku = COALESCE(EXCLUDED.sku, p.sku), image_url = COALESCE(EXCLUDED.image_url, p.image_url),
          metadata_source = 'order_line', metadata_updated_at = EXCLUDED.metadata_updated_at
      WHERE (p.metadata_source IS NULL OR (p.metadata_source = 'order_line' AND p.metadata_updated_at <= EXCLUDED.metadata_updated_at))
        AND (p.name, p.sku, p.image_url) IS DISTINCT FROM (COALESCE(EXCLUDED.name, p.name), COALESCE(EXCLUDED.sku, p.sku), COALESCE(EXCLUDED.image_url, p.image_url))
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT count(*) FILTER (WHERE was_insert) INTO v_prod FROM ins;

  RETURN QUERY SELECT v_ins, v_upd, v_total - v_ins - v_upd, v_prod;
END;
$$;

-- tiny helpers (NULL instead of a division by zero / a meaningless percentage)
CREATE FUNCTION public.pa_ratio(p_num numeric, p_den numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_den IS NULL OR p_den = 0 OR p_num IS NULL THEN NULL ELSE p_num / p_den END;
$$;
CREATE FUNCTION public.pa_delta(p_cur numeric, p_prev numeric)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'current', p_cur, 'previous', p_prev,
    'abs', CASE WHEN p_cur IS NULL OR p_prev IS NULL THEN NULL ELSE p_cur - p_prev END,
    'pct', CASE WHEN p_cur IS NULL OR p_prev IS NULL OR p_prev = 0 THEN NULL ELSE round((p_cur - p_prev) / p_prev * 100, 2) END);
$$;

-- Sales of ONE product over [from, to]; p_hour_cutoff (0–24) keeps only orders created before that
-- VN hour on each day (same-time comparison for a partial today).
CREATE FUNCTION public.pa_sales_window(p_shop_id uuid, p_item_id text, p_from date, p_to date, p_hour_cutoff integer DEFAULT NULL)
RETURNS TABLE (orders bigint, units bigint, gmv numeric, cancelled_orders bigint, lines bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0),
         COALESCE(sum(f.valid_quantity), 0)::bigint,
         COALESCE(sum(f.valid_amount), 0)::numeric(18,2),
         count(DISTINCT f.provider_order_id) FILTER (WHERE f.is_cancelled),
         count(*)
  FROM public.shopee_product_sales_facts f
  WHERE f.shop_id = p_shop_id AND f.provider_item_id = p_item_id
    AND f.report_date BETWEEN p_from AND p_to
    AND (p_hour_cutoff IS NULL OR extract(hour FROM f.order_created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') < p_hour_cutoff);
$$;

-- Ads of ONE product (single-item campaigns only). p_hour_cutoff → the hourly table, completed hours < cutoff.
CREATE FUNCTION public.pa_ads_window(p_shop_id uuid, p_item_id text, p_from date, p_to date, p_hour_cutoff integer DEFAULT NULL)
RETURNS TABLE (spend numeric, impressions bigint, clicks bigint, direct_order bigint, broad_order bigint, direct_gmv numeric, broad_gmv numeric, fact_rows bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH c AS (
    SELECT l.campaign_id FROM public.shopee_product_campaign_links l
    WHERE l.shop_id = p_shop_id AND l.provider_item_id = p_item_id AND l.single_item
  )
  SELECT COALESCE(sum(x.expense), 0)::numeric(18,2), COALESCE(sum(x.impression), 0)::bigint, COALESCE(sum(x.clicks), 0)::bigint,
         COALESCE(sum(x.direct_order), 0)::bigint, COALESCE(sum(x.broad_order), 0)::bigint,
         COALESCE(sum(x.direct_gmv), 0)::numeric(18,2), COALESCE(sum(x.broad_gmv), 0)::numeric(18,2), count(*)
  FROM (
    SELECT d.expense, d.impression, d.clicks, d.direct_order, d.broad_order, d.direct_gmv, d.broad_gmv
    FROM public.shopee_ads_campaign_daily_performance d
    WHERE p_hour_cutoff IS NULL AND d.shop_id = p_shop_id AND d.campaign_id IN (SELECT campaign_id FROM c) AND d.report_date BETWEEN p_from AND p_to
    UNION ALL
    SELECT h.expense, h.impression, h.clicks, h.direct_order, h.broad_order, h.direct_gmv, h.broad_gmv
    FROM public.shopee_ads_campaign_hourly_performance h
    WHERE p_hour_cutoff IS NOT NULL AND h.shop_id = p_shop_id AND h.campaign_id IN (SELECT campaign_id FROM c) AND h.report_date BETWEEN p_from AND p_to AND h.report_hour < p_hour_cutoff
  ) x;
$$;

-- Unified summary of ONE product (current vs previous period). All ratios = ratio of sums.
-- NO organic / non-Ads derivation (total − broad Ads) is computed anywhere (docs §attribution).
CREATE FUNCTION public.product_analytics_summary(p_shop_id uuid, p_item_id text, p_from date, p_to date, p_prev_from date, p_prev_to date, p_hour_cutoff integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_p   public.shopee_products;
  s1 record; s0 record; a1 record; a0 record;
  v_ads_campaigns integer; v_shared integer;
  v_snap record;
  v_hourly_prev bigint;
BEGIN
  SELECT * INTO v_p FROM public.shopee_products WHERE shop_id = p_shop_id AND provider_item_id = p_item_id;
  IF v_p.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s1 FROM public.pa_sales_window(p_shop_id, p_item_id, p_from, p_to, p_hour_cutoff);
  SELECT * INTO s0 FROM public.pa_sales_window(p_shop_id, p_item_id, p_prev_from, p_prev_to, p_hour_cutoff);
  SELECT * INTO a1 FROM public.pa_ads_window(p_shop_id, p_item_id, p_from, p_to, p_hour_cutoff);
  SELECT * INTO a0 FROM public.pa_ads_window(p_shop_id, p_item_id, p_prev_from, p_prev_to, p_hour_cutoff);
  SELECT count(*) FILTER (WHERE single_item), count(*) FILTER (WHERE NOT single_item) INTO v_ads_campaigns, v_shared
  FROM public.shopee_product_campaign_links WHERE shop_id = p_shop_id AND provider_item_id = p_item_id;
  SELECT * INTO v_snap FROM public.shopee_product_extra_snapshots
  WHERE shop_id = p_shop_id AND provider_item_id = p_item_id ORDER BY captured_at DESC LIMIT 1;
  v_hourly_prev := CASE WHEN p_hour_cutoff IS NULL THEN NULL ELSE a0.fact_rows END;

  RETURN jsonb_build_object(
    'identity', jsonb_build_object('product_id', v_p.id, 'shop_id', v_p.shop_id, 'provider_item_id', v_p.provider_item_id,
                                   'name', v_p.name, 'sku', v_p.sku, 'image_url', v_p.image_url, 'provider_status', v_p.provider_status,
                                   'metadata_source', v_p.metadata_source, 'metadata_updated_at', v_p.metadata_updated_at),
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'prev_from', p_prev_from, 'prev_to', p_prev_to, 'hour_cutoff', p_hour_cutoff),
    'sales', jsonb_build_object(
      'gmv', public.pa_delta(s1.gmv, s0.gmv),
      'orders', public.pa_delta(s1.orders, s0.orders),
      'units', public.pa_delta(s1.units, s0.units),
      'cancelled_orders', public.pa_delta(s1.cancelled_orders, s0.cancelled_orders),
      'fact_lines', s1.lines),
    'ads', jsonb_build_object(
      'single_item_campaigns', v_ads_campaigns, 'shared_campaigns_excluded', v_shared,
      'spend', public.pa_delta(a1.spend, a0.spend),
      'impressions', public.pa_delta(a1.impressions, a0.impressions),
      'clicks', public.pa_delta(a1.clicks, a0.clicks),
      'direct_order', public.pa_delta(a1.direct_order, a0.direct_order),
      'broad_order', public.pa_delta(a1.broad_order, a0.broad_order),
      'direct_gmv', public.pa_delta(a1.direct_gmv, a0.direct_gmv),
      'broad_gmv', public.pa_delta(a1.broad_gmv, a0.broad_gmv),
      'cpc', public.pa_delta(round(public.pa_ratio(a1.spend, a1.clicks), 2), round(public.pa_ratio(a0.spend, a0.clicks), 2)),
      'ctr', public.pa_delta(round(public.pa_ratio(a1.clicks, a1.impressions), 6), round(public.pa_ratio(a0.clicks, a0.impressions), 6)),
      'direct_roas', public.pa_delta(round(public.pa_ratio(a1.direct_gmv, a1.spend), 4), round(public.pa_ratio(a0.direct_gmv, a0.spend), 4)),
      'broad_roas', public.pa_delta(round(public.pa_ratio(a1.broad_gmv, a1.spend), 4), round(public.pa_ratio(a0.broad_gmv, a0.spend), 4)),
      'direct_cvr', public.pa_delta(round(public.pa_ratio(a1.direct_order, a1.clicks), 6), round(public.pa_ratio(a0.direct_order, a0.clicks), 6)),
      'broad_cvr', public.pa_delta(round(public.pa_ratio(a1.broad_order, a1.clicks), 6), round(public.pa_ratio(a0.broad_order, a0.clicks), 6)),
      -- "Ads attribution / total sales indicator" (NOT a share of sales: different attribution windows / sources)
      'broad_gmv_to_sales_indicator', public.pa_delta(round(public.pa_ratio(a1.broad_gmv, s1.gmv), 4), round(public.pa_ratio(a0.broad_gmv, s0.gmv), 4)),
      'fact_rows', a1.fact_rows,
      'previous_fact_rows', v_hourly_prev),
    'snapshot', CASE WHEN v_snap.id IS NULL THEN NULL ELSE jsonb_build_object(
      'captured_at', v_snap.captured_at, 'sale', v_snap.sale, 'views', v_snap.views, 'likes', v_snap.likes,
      'rating_star', v_snap.rating_star, 'comment_count', v_snap.comment_count) END
  );
END;
$$;

-- Daily trend of ONE product (sales + single-item-campaign Ads), every day of the range present.
CREATE FUNCTION public.product_analytics_daily(p_shop_id uuid, p_item_id text, p_from date, p_to date)
RETURNS TABLE (report_date date, orders bigint, units bigint, gmv numeric, spend numeric, impressions bigint, clicks bigint, direct_order bigint, broad_order bigint, direct_gmv numeric, broad_gmv numeric)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH days AS (SELECT d::date AS day FROM generate_series(p_from, LEAST(p_to, p_from + 400), interval '1 day') d),
  s AS (
    SELECT m.report_date, m.orders, m.units_sold, m.sales_gmv FROM public.shopee_product_daily_metrics m
    WHERE m.shop_id = p_shop_id AND m.provider_item_id = p_item_id AND m.report_date BETWEEN p_from AND p_to
  ),
  a AS (
    SELECT d.report_date, sum(d.expense) e, sum(d.impression) i, sum(d.clicks) c, sum(d.direct_order) dor, sum(d.broad_order) bo, sum(d.direct_gmv) dg, sum(d.broad_gmv) bg
    FROM public.shopee_ads_campaign_daily_performance d
    JOIN public.shopee_product_campaign_links l ON l.campaign_id = d.campaign_id AND l.single_item AND l.provider_item_id = p_item_id AND l.shop_id = p_shop_id
    WHERE d.shop_id = p_shop_id AND d.report_date BETWEEN p_from AND p_to
    GROUP BY d.report_date
  )
  SELECT days.day, COALESCE(s.orders, 0), COALESCE(s.units_sold, 0), COALESCE(s.sales_gmv, 0),
         COALESCE(a.e, 0), COALESCE(a.i, 0)::bigint, COALESCE(a.c, 0)::bigint, COALESCE(a.dor, 0)::bigint, COALESCE(a.bo, 0)::bigint,
         COALESCE(a.dg, 0), COALESCE(a.bg, 0)
  FROM days LEFT JOIN s ON s.report_date = days.day LEFT JOIN a ON a.report_date = days.day
  ORDER BY days.day;
$$;

-- Product list of the given shops: every known product with sales / Ads in either period,
-- or advertised now. ONE jsonb value (never the 1000-row PostgREST cap).
CREATE FUNCTION public.product_analytics_list(p_shop_ids uuid[], p_from date, p_to date, p_prev_from date, p_prev_to date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH sales AS (
    SELECT f.shop_id, f.provider_item_id,
           count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0 AND f.report_date BETWEEN p_from AND p_to) AS o1,
           COALESCE(sum(f.valid_quantity) FILTER (WHERE f.report_date BETWEEN p_from AND p_to), 0) AS u1,
           COALESCE(sum(f.valid_amount) FILTER (WHERE f.report_date BETWEEN p_from AND p_to), 0) AS g1,
           count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0 AND f.report_date BETWEEN p_prev_from AND p_prev_to) AS o0,
           COALESCE(sum(f.valid_amount) FILTER (WHERE f.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS g0
    FROM public.shopee_product_sales_facts f
    WHERE f.shop_id = ANY (p_shop_ids) AND f.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
    GROUP BY 1, 2
  ),
  links AS (
    SELECT l.shop_id, l.provider_item_id, l.campaign_id, l.single_item FROM public.shopee_product_campaign_links l WHERE l.shop_id = ANY (p_shop_ids)
  ),
  ads AS (
    SELECT l.shop_id, l.provider_item_id,
           COALESCE(sum(d.expense) FILTER (WHERE d.report_date BETWEEN p_from AND p_to), 0) AS e1,
           COALESCE(sum(d.clicks) FILTER (WHERE d.report_date BETWEEN p_from AND p_to), 0) AS c1,
           COALESCE(sum(d.impression) FILTER (WHERE d.report_date BETWEEN p_from AND p_to), 0) AS i1,
           COALESCE(sum(d.broad_gmv) FILTER (WHERE d.report_date BETWEEN p_from AND p_to), 0) AS b1,
           COALESCE(sum(d.broad_order) FILTER (WHERE d.report_date BETWEEN p_from AND p_to), 0) AS bo1,
           COALESCE(sum(d.expense) FILTER (WHERE d.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS e0,
           COALESCE(sum(d.broad_gmv) FILTER (WHERE d.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS b0
    FROM links l
    JOIN public.shopee_ads_campaign_daily_performance d ON d.campaign_id = l.campaign_id
     AND d.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
    WHERE l.single_item
    GROUP BY 1, 2
  ),
  camp AS (
    SELECT shop_id, provider_item_id, count(*) FILTER (WHERE single_item) AS single_n, count(*) FILTER (WHERE NOT single_item) AS shared_n
    FROM links GROUP BY 1, 2
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', p.id, 'shop_id', p.shop_id, 'item_id', p.provider_item_id, 'name', p.name, 'sku', p.sku,
           'image_url', p.image_url, 'status', p.provider_status,
           'campaigns', COALESCE(c.single_n, 0), 'shared_campaigns', COALESCE(c.shared_n, 0),
           'gmv', COALESCE(s.g1, 0), 'orders', COALESCE(s.o1, 0), 'units', COALESCE(s.u1, 0),
           'prev_gmv', COALESCE(s.g0, 0), 'prev_orders', COALESCE(s.o0, 0),
           'gmv_pct', CASE WHEN COALESCE(s.g0, 0) = 0 THEN NULL ELSE round((COALESCE(s.g1, 0) - s.g0) / s.g0 * 100, 2) END,
           'spend', COALESCE(a.e1, 0), 'clicks', COALESCE(a.c1, 0), 'impressions', COALESCE(a.i1, 0),
           'broad_gmv', COALESCE(a.b1, 0), 'broad_order', COALESCE(a.bo1, 0),
           'broad_roas', round(public.pa_ratio(a.b1, a.e1), 4),
           'prev_spend', COALESCE(a.e0, 0),
           'spend_pct', CASE WHEN COALESCE(a.e0, 0) = 0 THEN NULL ELSE round((COALESCE(a.e1, 0) - a.e0) / a.e0 * 100, 2) END,
           'roas_pct', CASE WHEN public.pa_ratio(a.b0, a.e0) IS NULL OR public.pa_ratio(a.b0, a.e0) = 0 OR public.pa_ratio(a.b1, a.e1) IS NULL THEN NULL
                            ELSE round((public.pa_ratio(a.b1, a.e1) - public.pa_ratio(a.b0, a.e0)) / public.pa_ratio(a.b0, a.e0) * 100, 2) END
         )), '[]'::jsonb)
  FROM public.shopee_products p
  LEFT JOIN sales s ON s.shop_id = p.shop_id AND s.provider_item_id = p.provider_item_id
  LEFT JOIN ads a ON a.shop_id = p.shop_id AND a.provider_item_id = p.provider_item_id
  LEFT JOIN camp c ON c.shop_id = p.shop_id AND c.provider_item_id = p.provider_item_id
  WHERE p.shop_id = ANY (p_shop_ids)
    AND (s.provider_item_id IS NOT NULL OR a.provider_item_id IS NOT NULL OR c.single_n > 0);
$$;

-- Rolling baseline of ONE product's daily metrics over [from, to] (every day counts, zero days included).
CREATE FUNCTION public.product_analytics_baseline(p_shop_id uuid, p_item_id text, p_from date, p_to date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH d AS (SELECT * FROM public.product_analytics_daily(p_shop_id, p_item_id, p_from, p_to)),
  m AS (
    SELECT 'sales_gmv' AS metric, gmv::numeric AS v FROM d UNION ALL
    SELECT 'orders', orders::numeric FROM d UNION ALL
    SELECT 'units', units::numeric FROM d UNION ALL
    SELECT 'ads_spend', spend::numeric FROM d UNION ALL
    SELECT 'ads_broad_gmv', broad_gmv::numeric FROM d UNION ALL
    SELECT 'ads_clicks', clicks::numeric FROM d
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', (SELECT count(*) FROM d),
    'days_with_sales', (SELECT count(*) FROM d WHERE orders > 0),
    'metrics', (SELECT jsonb_object_agg(x.metric, x.stats) FROM (
        SELECT metric, jsonb_build_object(
          'mean', round(avg(v), 2),
          'median', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::numeric, 2),
          'p25', round(percentile_cont(0.25) WITHIN GROUP (ORDER BY v)::numeric, 2),
          'p75', round(percentile_cont(0.75) WITHIN GROUP (ORDER BY v)::numeric, 2),
          'total', sum(v)) AS stats
        FROM m GROUP BY metric) x));
$$;

-- Per-shop data quality inputs (sales / extra-info freshness + coverage). Ads freshness: ads_sync_freshness.
CREATE FUNCTION public.product_analytics_freshness(p_shop_ids uuid[])
RETURNS TABLE (shop_id uuid, sales_enabled boolean, extra_info_enabled boolean, sales_last_success_at timestamptz, sales_backfill_done_at timestamptz,
               sales_active_jobs integer, fact_lines bigint, first_report_date date, last_report_date date, last_order_created_at timestamptz,
               extra_info_last_captured_at timestamptz, products integer)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT s.id,
         COALESCE(x.sales_sync_enabled, false), COALESCE(x.extra_info_enabled, false),
         (SELECT st.last_success_at FROM public.channel_sync_states st WHERE st.shop_id = s.id AND st.sync_type = 'product_sales_facts_read'),
         x.sales_backfill_done_at,
         (SELECT count(*) FROM public.channel_sync_jobs j WHERE j.shop_id = s.id AND j.sync_type = 'product_sales_facts_read' AND j.status IN ('pending', 'running', 'retry'))::integer,
         (SELECT count(*) FROM public.shopee_product_sales_facts f WHERE f.shop_id = s.id),
         (SELECT min(f.report_date) FROM public.shopee_product_sales_facts f WHERE f.shop_id = s.id),
         (SELECT max(f.report_date) FROM public.shopee_product_sales_facts f WHERE f.shop_id = s.id),
         (SELECT max(f.order_created_at) FROM public.shopee_product_sales_facts f WHERE f.shop_id = s.id),
         (SELECT max(e.captured_at) FROM public.shopee_product_extra_snapshots e WHERE e.shop_id = s.id),
         (SELECT count(*) FROM public.shopee_products p WHERE p.shop_id = s.id)::integer
  FROM unnest(p_shop_ids) AS s(id)
  LEFT JOIN public.product_analytics_shop_settings x ON x.shop_id = s.id;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'upsert_shopee_product_sales_facts(uuid, jsonb)',
    'pa_ratio(numeric, numeric)',
    'pa_delta(numeric, numeric)',
    'pa_sales_window(uuid, text, date, date, integer)',
    'pa_ads_window(uuid, text, date, date, integer)',
    'product_analytics_summary(uuid, text, date, date, date, date, integer)',
    'product_analytics_daily(uuid, text, date, date)',
    'product_analytics_list(uuid[], date, date, date, date)',
    'product_analytics_freshness(uuid[])',
    'product_analytics_baseline(uuid, text, date, date)',
    'shopee_products_from_ads_product()',
    'shopee_products_from_campaign_link()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
