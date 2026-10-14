-- ============================================================
-- PHASE SHOPEE-5 (shopee-fin-v2)
-- Escrow candidates: recalculate after a dictionary change.
--
-- FINANCIAL_CALCULATION_VERSION shopee-fin-v2 verifies the escrow formula on
-- real VN payloads. Orders synced under an older version must be re-fetched
-- and recalculated; p_calculation_version (NULL = ignore) makes them
-- candidates (reason 'version_changed'), still in bounded batches and still
-- behind the error back-off.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_orders_needing_escrow_sync(uuid, integer, timestamptz, text[], integer, integer, integer);

CREATE OR REPLACE FUNCTION public.get_orders_needing_escrow_sync(
  p_shop_id            uuid,
  p_limit              integer,
  p_now                timestamptz DEFAULT now(),
  p_statuses           text[] DEFAULT ARRAY['COMPLETED'],
  p_refresh_window_days integer DEFAULT 14,
  p_refresh_interval_hours integer DEFAULT 24,
  p_error_backoff_hours integer DEFAULT 6,
  p_calculation_version text DEFAULT NULL
)
RETURNS TABLE (order_id uuid, external_order_sn text, reason text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT o.id, o.external_order_sn,
    CASE
      WHEN f.escrow_synced_at IS NULL THEN 'never_synced'
      WHEN p_calculation_version IS NOT NULL AND f.calculation_version IS DISTINCT FROM p_calculation_version THEN 'version_changed'
      WHEN o.updated_at_channel > f.escrow_synced_at THEN 'order_changed'
      ELSE 'refresh_window'
    END
  FROM public.channel_orders o
  LEFT JOIN public.order_financials f ON f.order_id = o.id
  WHERE o.shop_id = p_shop_id
    AND o.order_status = ANY (p_statuses)
    AND (
      f.escrow_synced_at IS NULL
      OR (p_calculation_version IS NOT NULL AND f.calculation_version IS DISTINCT FROM p_calculation_version)
      OR o.updated_at_channel > f.escrow_synced_at
      OR (COALESCE(o.updated_at_channel, o.created_at_channel) > p_now - make_interval(days => p_refresh_window_days)
          AND f.escrow_synced_at < p_now - make_interval(hours => p_refresh_interval_hours))
    )
    AND NOT (
      f.escrow_last_error_code IS NOT NULL
      AND f.escrow_last_attempt_at > p_now - make_interval(hours => p_error_backoff_hours)
    )
  ORDER BY f.escrow_synced_at NULLS FIRST, o.updated_at_channel
  LIMIT GREATEST(p_limit, 0)
$$;

REVOKE EXECUTE ON FUNCTION public.get_orders_needing_escrow_sync(uuid, integer, timestamptz, text[], integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_orders_needing_escrow_sync(uuid, integer, timestamptz, text[], integer, integer, integer, text) TO service_role;
