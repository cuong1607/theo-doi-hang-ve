-- ============================================================
-- SHOPEE-6B: "Lý do hoàn" in the daily return-operation list / export.
--   Hoàn Trả  channel_returns.reason (Shopee code, e.g. CHANGE_MIND) + text_reason (buyer's words)
--   Hoàn Hủy  channel_orders.cancel_reason (get_order_detail)
-- Display only. The return type changes → DROP + CREATE (same arguments).
-- ============================================================
DROP FUNCTION public.list_return_operations(date, uuid[], text, text, text, text, text, text, integer, integer);

CREATE FUNCTION public.list_return_operations(
  p_date date, p_shop_ids uuid[] DEFAULT NULL, p_carrier text DEFAULT NULL, p_type text DEFAULT NULL, p_window text DEFAULT NULL,
  p_status text DEFAULT NULL, p_search text DEFAULT NULL, p_view text DEFAULT 'delivered', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid, shop_id uuid, shop_name text, channel_order_id uuid, external_order_sn text, return_id uuid, operation_type text,
  return_sn text, tracking_number text, rts_tracking_number text, carrier text, provider_status text, canonical_status text,
  source_segment text, delivered_to_seller_at timestamptz, delivered_at_source text, business_date date, window_id uuid,
  last_status_at timestamptz, last_synced_at timestamptz, assigned_receiver_id uuid, received_confirmed_at timestamptz,
  received_confirmed_by uuid, needs_attention boolean, attention_reason text, item_qty text, items jsonb,
  return_reason text, return_text_reason text, cancel_reason text, total_count bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH base AS (
    SELECT v.*
    FROM public.v_return_operations v
    WHERE CASE WHEN p_view = 'open'
               THEN v.delivered_to_seller_at IS NULL AND v.received_confirmed_at IS NULL AND v.canonical_status <> 'cancelled'
               ELSE v.business_date = p_date END
      AND public.return_operations_filter(v, p_shop_ids, p_carrier, p_type, CASE WHEN p_view = 'open' THEN NULL ELSE p_window END)
      AND (p_status IS NULL
           OR (p_status = 'unconfirmed' AND v.received_confirmed_at IS NULL)
           OR (p_status = 'confirmed' AND v.received_confirmed_at IS NOT NULL)
           OR (p_status = 'attention' AND v.needs_attention)
           OR v.canonical_status = p_status)
      AND (p_search IS NULL OR btrim(p_search) = ''
           OR v.external_order_sn ILIKE '%' || btrim(p_search) || '%'
           OR v.return_sn ILIKE '%' || btrim(p_search) || '%'
           OR v.tracking_number ILIKE '%' || btrim(p_search) || '%'
           OR v.rts_tracking_number ILIKE '%' || btrim(p_search) || '%')
  ), page AS (
    SELECT b.*, count(*) OVER () AS total_count
    FROM base b
    ORDER BY CASE WHEN p_view = 'open' THEN NULL ELSE b.delivered_to_seller_at END ASC,
             CASE WHEN p_view = 'open' THEN COALESCE(b.last_status_at, b.created_at) END DESC,
             b.id
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  )
  SELECT p.id, p.shop_id, p.shop_name, p.channel_order_id, p.external_order_sn, p.return_id, p.operation_type,
         p.return_sn, p.tracking_number, p.rts_tracking_number, p.carrier, p.provider_status, p.canonical_status,
         p.source_segment, p.delivered_to_seller_at, p.delivered_at_source, p.business_date, p.window_id,
         p.last_status_at, p.last_synced_at, p.assigned_receiver_id, p.received_confirmed_at,
         p.received_confirmed_by, p.needs_attention, p.attention_reason,
         COALESCE(it.qty, 0)::text, COALESCE(it.items, '[]'::jsonb),
         r.reason, r.text_reason, co.cancel_reason, p.total_count
  FROM page p
  LEFT JOIN public.channel_returns r ON r.id = p.return_id
  LEFT JOIN public.channel_orders co ON co.id = p.channel_order_id
  LEFT JOIN LATERAL (
    SELECT sum(i.quantity) AS qty,
           jsonb_agg(jsonb_build_object('name', i.item_name_snapshot, 'model', i.model_name_snapshot, 'sku', i.sku_snapshot, 'quantity', i.quantity::text)
                     ORDER BY i.item_name_snapshot, i.model_name_snapshot) AS items
    FROM public.channel_return_operation_items i WHERE i.return_operation_id = p.id
  ) it ON true
  ORDER BY CASE WHEN p_view = 'open' THEN NULL ELSE p.delivered_to_seller_at END ASC,
           CASE WHEN p_view = 'open' THEN COALESCE(p.last_status_at, p.created_at) END DESC,
           p.id;
$$;

REVOKE EXECUTE ON FUNCTION public.list_return_operations(date, uuid[], text, text, text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_return_operations(date, uuid[], text, text, text, text, text, text, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
