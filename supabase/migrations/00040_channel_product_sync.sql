-- ============================================================
-- PHASE SHOPEE-2: product sync + internal SKU mapping support.
--
-- Additive only (no change to SHOPEE-0 tables' existing columns/rules).
--
--   shops.data_source              'live' | 'fixture' — fixture data can never
--                                   be mistaken for (or written into) a real shop:
--                                   the sync refuses a provider/shop mismatch.
--   channel_products.is_kit         Shopee tag.kit (bundle/kit listing) — needed
--                                   later for COGS of kits; NULL = unknown.
--   channel_product_models
--     .is_synthetic                 TRUE = the internal "NO_MODEL" sellable unit we
--                                   create for an item without variations. It did
--                                   NOT come from the provider.
--     .removed_at                   provider stopped returning this model (or the
--                                   item gained/lost variations). Row + mapping are
--                                   kept for history; cleared if it comes back.
--     .mapping_review_required      an auto mapping whose channel SKU no longer
--                                   matches the mapped product's SKU. The mapping
--                                   is NOT changed automatically.
--   channel_api_snapshots
--     .source_mode                  'live' | 'fixture'
--     .payload_hash                 sha-256 of the payload (skip identical rewrites)
--
-- v_channel_model_listing: one row per sellable unit with item, shop and
-- internal product joined (the mapping screen reads this — no N+1).
-- get_channel_mapping_summary(): counts for the mapping summary cards.
-- ============================================================

ALTER TABLE public.shops
  ADD COLUMN data_source text NOT NULL DEFAULT 'live' CHECK (data_source IN ('live', 'fixture'));

ALTER TABLE public.channel_products
  ADD COLUMN is_kit boolean;

ALTER TABLE public.channel_product_models
  ADD COLUMN is_synthetic             boolean     NOT NULL DEFAULT false,
  ADD COLUMN removed_at               timestamptz,
  ADD COLUMN mapping_review_required  boolean     NOT NULL DEFAULT false;

-- A synthetic unit always uses the reserved id, and only synthetic units may.
ALTER TABLE public.channel_product_models
  ADD CONSTRAINT channel_product_models_synthetic_id
  CHECK ((external_model_id = 'NO_MODEL') = is_synthetic);

-- Review flag only makes sense while something is mapped.
CREATE OR REPLACE FUNCTION public.reset_channel_model_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.internal_product_id IS NULL OR NEW.mapping_status = 'manual_mapped' THEN
    NEW.mapping_review_required := false;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_channel_model_review() FROM PUBLIC, anon, authenticated;

-- Runs after reset_channel_model_mapping (trigger names fire alphabetically).
CREATE TRIGGER reset_channel_model_review
  BEFORE INSERT OR UPDATE ON public.channel_product_models
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_channel_model_review();

ALTER TABLE public.channel_api_snapshots
  ADD COLUMN source_mode  text NOT NULL DEFAULT 'live' CHECK (source_mode IN ('live', 'fixture')),
  ADD COLUMN payload_hash text;

CREATE INDEX idx_channel_product_models_removed_at ON public.channel_product_models (removed_at);


-- ------------------------------------------------------------
-- Listing view (security_invoker: callers' RLS applies)
-- NUMERIC columns are exposed as text so no caller turns them into floats.
-- ------------------------------------------------------------
CREATE VIEW public.v_channel_model_listing
WITH (security_invoker = true)
AS
SELECT
  m.id                              AS channel_model_id,
  s.id                              AS shop_id,
  s.shop_name,
  s.channel,
  s.data_source,
  cp.id                             AS channel_product_id,
  cp.external_item_id,
  cp.item_name,
  cp.item_sku,
  cp.item_status,
  cp.is_kit,
  cp.has_model,
  m.external_model_id,
  m.is_synthetic,
  m.model_name,
  m.model_sku,
  m.model_status,
  -- The SKU shown/matched for this sellable unit.
  CASE WHEN m.is_synthetic THEN cp.item_sku ELSE m.model_sku END AS channel_sku,
  COALESCE(m.channel_current_price, cp.channel_current_price)::text   AS channel_current_price,
  COALESCE(m.channel_original_price, cp.channel_original_price)::text AS channel_original_price,
  COALESCE(m.available_stock, cp.available_stock)::text               AS available_stock,
  COALESCE(m.reserved_stock, cp.reserved_stock)::text                 AS reserved_stock,
  m.mapping_status,
  m.mapping_review_required,
  m.mapped_at,
  m.mapped_by,
  m.removed_at,
  (m.removed_at IS NULL AND cp.item_status = 'NORMAL') AS is_active,
  m.internal_product_id,
  p.sku                             AS internal_sku,
  p.name                            AS internal_product_name,
  COALESCE(m.last_synced_at, cp.last_synced_at) AS last_synced_at
FROM public.channel_product_models m
JOIN public.channel_products cp ON cp.id = m.channel_product_id
JOIN public.shops s             ON s.id = cp.shop_id
LEFT JOIN public.products p     ON p.id = m.internal_product_id;

REVOKE ALL ON public.v_channel_model_listing FROM anon;
GRANT SELECT ON public.v_channel_model_listing TO authenticated, service_role;


-- ------------------------------------------------------------
-- Mapping summary. "Active" = model still returned by the provider AND the
-- item is NORMAL — the set that must be mapped before order sync.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_channel_mapping_summary(p_shop_id uuid DEFAULT NULL)
RETURNS TABLE (
  total_models      bigint,
  active_models     bigint,
  active_mapped     bigint,
  active_unmapped   bigint,
  active_conflict   bigint,
  review_required   bigint,
  inactive_models   bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE v.is_active),
    count(*) FILTER (WHERE v.is_active AND v.mapping_status IN ('auto_mapped', 'manual_mapped')),
    count(*) FILTER (WHERE v.is_active AND v.mapping_status = 'unmapped'),
    count(*) FILTER (WHERE v.is_active AND v.mapping_status = 'mapping_conflict'),
    count(*) FILTER (WHERE v.mapping_review_required),
    count(*) FILTER (WHERE NOT v.is_active)
  FROM public.v_channel_model_listing v
  WHERE p_shop_id IS NULL OR v.shop_id = p_shop_id;
$$;

REVOKE EXECUTE ON FUNCTION public.get_channel_mapping_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_channel_mapping_summary(uuid) TO authenticated, service_role;
