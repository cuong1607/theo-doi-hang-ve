-- ============================================================
-- PATCH ORDERS SYNC CUTOFF: only orders CREATED on/after a cutoff are
-- synced (owner decision 2026-10-17: "chỉ đồng bộ đơn từ hôm nay trở đi").
--
--   channel_sync_settings.orders_from   single row; NULL = no cutoff
--
-- Applied by
--   * the order job (app): windows start at the cutoff; listed orders created
--     before it are neither fetched nor stored (local created_at, or the
--     YYMMDD prefix of the order_sn with a one-day margin, then the detail's
--     create_time as the final check)
--   * the escrow job: get_orders_needing_escrow_sync /
--     get_orders_needing_escrow_estimate skip orders created before it
--     (same signatures — bodies replaced; the count_* wrappers follow).
-- Orders already stored stay visible; they are just no longer refreshed.
-- Changing the cutoff needs no deploy: UPDATE channel_sync_settings.
-- ============================================================

CREATE TABLE public.channel_sync_settings (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  orders_from timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.channel_sync_settings IS 'Single row. orders_from = only channel orders created at/after this moment are synced (orders + escrow). NULL = everything.';
INSERT INTO public.channel_sync_settings (id, orders_from) VALUES (true, '2026-10-17 00:00:00+07');

ALTER TABLE public.channel_sync_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_sync_settings FROM anon, authenticated;
GRANT SELECT ON public.channel_sync_settings TO authenticated;
GRANT SELECT, UPDATE ON public.channel_sync_settings TO service_role;
CREATE POLICY active_users_select ON public.channel_sync_settings FOR SELECT TO authenticated USING (public.is_active_user());

-- 00049 body + cutoff.
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
  CROSS JOIN (SELECT orders_from FROM public.channel_sync_settings WHERE id) st
  WHERE o.shop_id = p_shop_id
    AND o.order_status = ANY (p_statuses)
    AND (st.orders_from IS NULL OR o.created_at_channel >= st.orders_from)
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

-- 00052 body + cutoff.
CREATE OR REPLACE FUNCTION public.get_orders_needing_escrow_estimate(
  p_shop_id                 uuid,
  p_limit                   integer,
  p_now                     timestamptz DEFAULT now(),
  p_statuses                text[] DEFAULT ARRAY['READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE'],
  p_refresh_interval_hours  integer DEFAULT 12,
  p_error_backoff_hours     integer DEFAULT 6
)
RETURNS TABLE (order_id uuid, external_order_sn text, reason text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT o.id, o.external_order_sn,
    CASE
      WHEN f.estimated_revenue_synced_at IS NULL THEN 'never_estimated'
      WHEN o.updated_at_channel > f.estimated_revenue_synced_at THEN 'order_changed'
      ELSE 'refresh_interval'
    END
  FROM public.channel_orders o
  LEFT JOIN public.order_financials f ON f.order_id = o.id
  CROSS JOIN (SELECT orders_from FROM public.channel_sync_settings WHERE id) st
  WHERE o.shop_id = p_shop_id
    AND o.order_status = ANY (p_statuses)
    AND (st.orders_from IS NULL OR o.created_at_channel >= st.orders_from)
    AND f.escrow_synced_at IS NULL
    AND (
      f.estimated_revenue_synced_at IS NULL
      OR o.updated_at_channel > f.estimated_revenue_synced_at
      OR f.estimated_revenue_synced_at < p_now - make_interval(hours => p_refresh_interval_hours)
    )
    AND NOT (
      f.estimate_last_error_code IS NOT NULL
      AND f.estimate_last_attempt_at > p_now - make_interval(hours => p_error_backoff_hours)
    )
  ORDER BY f.estimated_revenue_synced_at NULLS FIRST, o.created_at_channel DESC NULLS LAST
  LIMIT GREATEST(p_limit, 0)
$$;

-- Privileges (cloud has no default EXECUTE grants — explicit, always)
REVOKE EXECUTE ON FUNCTION public.get_orders_needing_escrow_sync(uuid, integer, timestamptz, text[], integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_orders_needing_escrow_estimate(uuid, integer, timestamptz, text[], integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_orders_needing_escrow_sync(uuid, integer, timestamptz, text[], integer, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_orders_needing_escrow_estimate(uuid, integer, timestamptz, text[], integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
