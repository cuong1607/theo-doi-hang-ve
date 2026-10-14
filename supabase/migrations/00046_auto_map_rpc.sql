-- ============================================================
-- PATCH: database-only, set-based SKU auto-mapping.
--
-- "Tự động ghép SKU" used to load every candidate into the app and write the
-- result back with `UPDATE … WHERE id IN (<every id>)`. With a real catalog
-- (5,937 unmapped models) that URL is ~220 KB → the API gateway answers
-- "URI too long" → "Không cập nhật được trạng thái unmapped". It also
-- rewrote 'unmapped' onto rows that were already unmapped, and back-filled
-- order lines with 2 round trips per mapped model.
--
-- Now one statement per step, inside Postgres. Auto-mapping never calls the
-- Shopee API — it only reads what product sync already stored.
--
-- Rules (unchanged from SHOPEE-2, conservative, exact):
--   key        = normalize_channel_sku(channel SKU): trim outer whitespace,
--                lower-case, '' → NULL. channel SKU = item_sku for the
--                synthetic NO_MODEL unit, model_sku otherwise.
--   candidates = the shop's models with mapping_status unmapped /
--                mapping_conflict, internal_product_id NULL, not removed
--   products   = ACTIVE internal products
--   1 match → auto_mapped · 0 → unmapped · ≥2 → mapping_conflict
-- manual_mapped / auto_mapped rows and any non-NULL mapping are never
-- touched; each UPDATE re-checks the row's status, so a concurrent manual
-- mapping always wins. Historical order lines: only NULL snapshots are
-- filled (same rule as backfillUnmappedOrderItemsForModel).
-- ============================================================

-- Mirror of normalizeSku() in src/lib/channels/core/sku-mapping.ts (a test keeps them equal).
CREATE OR REPLACE FUNCTION public.normalize_channel_sku(p_sku text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT NULLIF(lower(btrim(p_sku, E' \t\n\r\u000B\f ﻿')), '')
$$;

CREATE OR REPLACE FUNCTION public.auto_map_channel_models(p_shop_id uuid, p_now timestamptz DEFAULT now())
RETURNS TABLE (
  scanned integer,
  mapped integer,
  unmapped integer,
  conflicts integer,
  skipped integer,
  order_lines_backfilled integer,
  affected_order_ids uuid[]
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_scanned integer;
  v_unmapped integer;
  v_conflicts integer;
  v_skipped integer;
  v_mapped_ids uuid[];
  v_lines integer;
  v_orders uuid[];
BEGIN
  IF p_shop_id IS NULL THEN
    RAISE EXCEPTION 'shop id required';
  END IF;

  WITH cand AS (
    SELECT m.id, m.mapping_status AS old_status,
           public.normalize_channel_sku(CASE WHEN m.is_synthetic THEN cp.item_sku ELSE m.model_sku END) AS sku_key
    FROM public.channel_product_models m
    JOIN public.channel_products cp ON cp.id = m.channel_product_id
    WHERE cp.shop_id = p_shop_id
      AND m.mapping_status IN ('unmapped', 'mapping_conflict')
      AND m.internal_product_id IS NULL
      AND m.removed_at IS NULL
  ),
  prod AS (
    SELECT public.normalize_channel_sku(p.sku) AS sku_key, count(*) AS n, min(p.id::text)::uuid AS product_id
    FROM public.products p
    WHERE p.is_active AND public.normalize_channel_sku(p.sku) IS NOT NULL
    GROUP BY 1
  ),
  decided AS (
    SELECT c.id, c.old_status,
           CASE WHEN pr.n = 1 THEN 'auto_mapped' WHEN pr.n > 1 THEN 'mapping_conflict' ELSE 'unmapped' END AS new_status,
           CASE WHEN pr.n = 1 THEN pr.product_id END AS product_id
    FROM cand c
    LEFT JOIN prod pr ON pr.sku_key = c.sku_key
  ),
  upd AS (
    UPDATE public.channel_product_models m
    SET internal_product_id = d.product_id,
        mapping_status = d.new_status,
        mapped_at = CASE WHEN d.new_status = 'auto_mapped' THEN p_now ELSE NULL END,
        mapped_by = NULL,
        mapping_review_required = false
    FROM decided d
    WHERE m.id = d.id
      AND d.new_status <> d.old_status
      AND m.mapping_status IN ('unmapped', 'mapping_conflict')
      AND m.internal_product_id IS NULL
    RETURNING m.id, d.new_status
  )
  SELECT
    (SELECT count(*) FROM decided),
    (SELECT count(*) FROM decided WHERE new_status = 'unmapped'),
    (SELECT count(*) FROM decided WHERE new_status = 'mapping_conflict'),
    COALESCE((SELECT array_agg(id) FROM upd WHERE new_status = 'auto_mapped'), '{}')
  INTO v_scanned, v_unmapped, v_conflicts, v_mapped_ids;

  SELECT count(*) INTO v_skipped
  FROM public.channel_product_models m
  JOIN public.channel_products cp ON cp.id = m.channel_product_id
  WHERE cp.shop_id = p_shop_id;
  v_skipped := v_skipped - v_scanned;

  -- Order lines synced while their unit was unmapped get the new product
  -- snapshot (NULL lines only — non-NULL history is never rewritten).
  WITH filled AS (
    UPDATE public.channel_order_items oi
    SET internal_product_id = m.internal_product_id
    FROM public.channel_product_models m
    WHERE m.id = ANY (v_mapped_ids)
      AND oi.channel_model_id = m.id
      AND oi.internal_product_id IS NULL
    RETURNING oi.order_id
  )
  SELECT count(*), COALESCE(array_agg(DISTINCT order_id), '{}') INTO v_lines, v_orders FROM filled;

  RETURN QUERY SELECT v_scanned, COALESCE(array_length(v_mapped_ids, 1), 0), v_unmapped, v_conflicts, v_skipped, v_lines, v_orders;
END;
$$;

-- auto_mapped units whose channel SKU no longer matches the mapped product's
-- SKU are flagged for review (mapping kept); matching again clears the flag.
-- Returns how many auto mappings currently mismatch.
CREATE OR REPLACE FUNCTION public.refresh_channel_mapping_review_flags(p_shop_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_mismatch integer;
BEGIN
  WITH state AS (
    SELECT m.id, m.mapping_review_required,
           public.normalize_channel_sku(CASE WHEN m.is_synthetic THEN cp.item_sku ELSE m.model_sku END)
             IS DISTINCT FROM public.normalize_channel_sku(p.sku) AS mismatch
    FROM public.channel_product_models m
    JOIN public.channel_products cp ON cp.id = m.channel_product_id
    LEFT JOIN public.products p ON p.id = m.internal_product_id
    WHERE cp.shop_id = p_shop_id AND m.mapping_status = 'auto_mapped'
  ),
  upd AS (
    UPDATE public.channel_product_models m
    SET mapping_review_required = s.mismatch
    FROM state s
    WHERE m.id = s.id AND m.mapping_status = 'auto_mapped' AND m.mapping_review_required IS DISTINCT FROM s.mismatch
    RETURNING m.id
  )
  SELECT count(*) FILTER (WHERE mismatch) INTO v_mismatch FROM state;
  RETURN v_mismatch;
END;
$$;

-- Explicit grants (cloud Supabase has no default EXECUTE for service_role — see 00044).
REVOKE EXECUTE ON FUNCTION public.auto_map_channel_models(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_channel_mapping_review_flags(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_map_channel_models(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_channel_mapping_review_flags(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.normalize_channel_sku(text) TO service_role, authenticated;
