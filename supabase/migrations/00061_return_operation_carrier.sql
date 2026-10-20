-- ============================================================
-- PHASE SHOPEE-6B fix: carrier of a return operation = carrier of the RETURN
-- leg, never blindly the order's outbound carrier.
--
-- Real VN payloads (prod, 2026-10):
--   * get_reverse_tracking_info has NO carrier name
--   * get_return_detail.reverse_logistics_channel_name = return-leg carrier
--     ("SPX Express" while the order was shipped by GHN / beDelivery /
--     SPX Instant) → stored on channel_returns, used for Hoàn Trả
--   * get_tracking_info (Hoàn Hủy) has no carrier name either; the SAME
--     parcel (same tracking number) travels back → the package / order
--     carrier stays the Hoàn Hủy carrier
-- Hoàn Trả without a known return-leg carrier → NULL ("Không rõ ĐVVC"),
-- not the outbound carrier. Operational display only — no money / stock.
-- ============================================================

ALTER TABLE public.channel_returns ADD COLUMN reverse_logistics_channel_name text;

-- Backfill from the latest stored get_return_detail snapshot (sanitized payloads keep this field).
UPDATE public.channel_returns r
SET reverse_logistics_channel_name = NULLIF(btrim(s.payload ->> 'reverse_logistics_channel_name'), '')
FROM (
  SELECT DISTINCT ON (shop_id, entity_external_id) shop_id, entity_external_id, payload
  FROM public.channel_api_snapshots
  WHERE entity_type = 'return' AND api_name = 'v2.returns.get_return_detail'
  ORDER BY shop_id, entity_external_id, synced_at DESC
) s
WHERE s.shop_id = r.shop_id AND s.entity_external_id = r.external_return_sn;


CREATE OR REPLACE FUNCTION public.apply_return_operation(p_shop_id uuid, p_op jsonb, p_events jsonb, p_synced_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_type       text := p_op ->> 'operation_type';
  v_order_id   uuid := (p_op ->> 'channel_order_id')::uuid;
  v_return_id  uuid := NULLIF(p_op ->> 'return_id', '')::uuid;
  v_order      record;
  v_tz         text;
  v_identity   text;
  v_carrier    text;
  v_delivered  timestamptz := (p_op ->> 'delivered_to_seller_at')::timestamptz;
  v_prev       record;
  v_id         uuid;
  v_created    boolean;
  v_receiver   uuid;
  v_keep       uuid[] := ARRAY[]::uuid[];
  v_row        uuid;
  it           record;
  v_events     integer := 0;
BEGIN
  IF v_type NOT IN ('customer_return', 'failed_delivery_return') THEN
    RAISE EXCEPTION 'operation_type không hợp lệ: %', v_type USING ERRCODE = 'P0001';
  END IF;
  SELECT o.id, o.external_order_sn, o.shipping_carrier INTO v_order
  FROM public.channel_orders o WHERE o.id = v_order_id AND o.shop_id = p_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Đơn % không thuộc shop %', v_order_id, p_shop_id USING ERRCODE = 'P0001'; END IF;
  IF v_type = 'customer_return' THEN
    IF v_return_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.channel_returns r WHERE r.id = v_return_id AND r.shop_id = p_shop_id AND r.order_id = v_order_id) THEN
      RAISE EXCEPTION 'Return % không thuộc đơn %', v_return_id, v_order_id USING ERRCODE = 'P0001';
    END IF;
    v_identity := 'return:' || (p_op ->> 'return_sn');
    -- return-leg carrier only (never the outbound order carrier)
    SELECT COALESCE(NULLIF(btrim(p_op ->> 'logistics_provider'), ''), NULLIF(btrim(r.reverse_logistics_channel_name), ''))
      INTO v_carrier FROM public.channel_returns r WHERE r.id = v_return_id;
  ELSE
    v_return_id := NULL;
    v_identity := 'fd:' || v_order.external_order_sn;
    -- the same parcel travels back → its carrier
    v_carrier := COALESCE(NULLIF(btrim(p_op ->> 'logistics_provider'), ''), NULLIF(btrim(v_order.shipping_carrier), ''));
  END IF;
  SELECT COALESCE(s.timezone, 'Asia/Ho_Chi_Minh') INTO v_tz FROM public.shops s WHERE s.id = p_shop_id;

  SELECT o.id, o.delivered_to_seller_at INTO v_prev FROM public.channel_return_operations o WHERE o.shop_id = p_shop_id AND o.identity_key = v_identity;
  IF NOT FOUND THEN
    SELECT a.default_receiver_user_id INTO v_receiver
    FROM public.return_operation_assignments a
    WHERE a.operation_type = v_type AND (a.shop_id = p_shop_id OR a.shop_id IS NULL)
    ORDER BY a.shop_id NULLS LAST LIMIT 1;
  END IF;

  INSERT INTO public.channel_return_operations AS o
    (shop_id, channel_order_id, return_id, operation_type, identity_key, provider_return_id, return_sn, tracking_number, rts_tracking_number,
     logistics_provider, provider_status, canonical_status, source_segment, delivered_to_seller_at, delivered_at_source, business_date,
     last_status_at, last_synced_at, sync_notes, assigned_receiver_id)
  VALUES
    (p_shop_id, v_order_id, v_return_id, v_type, v_identity, p_op ->> 'provider_return_id', p_op ->> 'return_sn',
     NULLIF(p_op ->> 'tracking_number', ''), NULLIF(p_op ->> 'rts_tracking_number', ''),
     v_carrier,
     p_op ->> 'provider_status', COALESCE(p_op ->> 'canonical_status', 'pending'), p_op ->> 'source_segment',
     v_delivered, CASE WHEN v_delivered IS NULL THEN NULL ELSE p_op ->> 'delivered_at_source' END,
     (v_delivered AT TIME ZONE v_tz)::date,
     (p_op ->> 'last_status_at')::timestamptz, p_synced_at,
     CASE WHEN jsonb_typeof(p_op -> 'sync_notes') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(p_op -> 'sync_notes')) END,
     v_receiver)
  ON CONFLICT (shop_id, identity_key) DO UPDATE SET
    provider_return_id  = COALESCE(EXCLUDED.provider_return_id, o.provider_return_id),
    return_sn           = COALESCE(EXCLUDED.return_sn, o.return_sn),
    tracking_number     = COALESCE(EXCLUDED.tracking_number, o.tracking_number),
    rts_tracking_number = COALESCE(EXCLUDED.rts_tracking_number, o.rts_tracking_number),
    -- Hoàn Trả: always the current return-leg carrier (replaces an outbound carrier stored before 00061)
    logistics_provider  = CASE WHEN o.operation_type = 'customer_return' THEN EXCLUDED.logistics_provider
                               ELSE COALESCE(EXCLUDED.logistics_provider, o.logistics_provider) END,
    provider_status     = EXCLUDED.provider_status,
    canonical_status    = EXCLUDED.canonical_status,
    source_segment      = EXCLUDED.source_segment,
    delivered_to_seller_at = EXCLUDED.delivered_to_seller_at,
    delivered_at_source    = EXCLUDED.delivered_at_source,
    business_date          = EXCLUDED.business_date,
    last_status_at      = COALESCE(EXCLUDED.last_status_at, o.last_status_at),
    last_synced_at      = EXCLUDED.last_synced_at,
    sync_notes          = EXCLUDED.sync_notes
  RETURNING o.id, (xmax = 0) INTO v_id, v_created;

  FOR it IN
    SELECT ri.channel_order_item_id AS line_id, ri.external_item_id AS item_id, ri.external_model_id AS model_id,
           COALESCE(oi.item_name, ri.item_name, '#' || ri.external_item_id) AS item_name, oi.model_name,
           COALESCE(NULLIF(ri.variation_sku, ''), NULLIF(oi.model_sku, ''), NULLIF(ri.item_sku, ''), oi.item_sku) AS sku, ri.quantity
    FROM public.channel_return_items ri LEFT JOIN public.channel_order_items oi ON oi.id = ri.channel_order_item_id
    WHERE v_type = 'customer_return' AND ri.return_id = v_return_id
    UNION ALL
    SELECT oi.id, oi.external_item_id, oi.external_model_id, oi.item_name, oi.model_name,
           COALESCE(NULLIF(oi.model_sku, ''), oi.item_sku), oi.quantity
    FROM public.channel_order_items oi
    WHERE v_type = 'failed_delivery_return' AND oi.order_id = v_order_id
  LOOP
    INSERT INTO public.channel_return_operation_items AS x
      (return_operation_id, channel_order_item_id, provider_item_id, provider_model_id, item_name_snapshot, model_name_snapshot, sku_snapshot, quantity)
    VALUES (v_id, it.line_id, it.item_id, it.model_id, it.item_name, it.model_name, it.sku, it.quantity)
    ON CONFLICT (return_operation_id, COALESCE(provider_item_id, ''), COALESCE(provider_model_id, ''), COALESCE(channel_order_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET quantity = EXCLUDED.quantity, item_name_snapshot = EXCLUDED.item_name_snapshot,
                  model_name_snapshot = EXCLUDED.model_name_snapshot, sku_snapshot = EXCLUDED.sku_snapshot
    RETURNING x.id INTO v_row;
    v_keep := v_keep || v_row;
  END LOOP;
  DELETE FROM public.channel_return_operation_items x WHERE x.return_operation_id = v_id AND NOT (x.id = ANY (v_keep));

  INSERT INTO public.channel_return_logistics_events AS e
    (return_operation_id, tracking_number, provider_status, canonical_status, event_time, description, location, source_segment, event_key)
  SELECT v_id, NULLIF(ev ->> 'tracking_number', ''), ev ->> 'provider_status', COALESCE(ev ->> 'canonical_status', 'unknown'),
         (ev ->> 'event_time')::timestamptz, ev ->> 'description', ev ->> 'location', ev ->> 'source_segment',
         md5(concat_ws('|', ev ->> 'source_segment', extract(epoch FROM (ev ->> 'event_time')::timestamptz)::bigint, COALESCE(ev ->> 'provider_status', ''), COALESCE(ev ->> 'description', '')))
  FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) ev
  WHERE ev ->> 'event_time' IS NOT NULL
  ON CONFLICT (return_operation_id, event_key) DO UPDATE SET canonical_status = EXCLUDED.canonical_status, location = EXCLUDED.location;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  PERFORM public.refresh_return_operation_attention(NULL, v_id);
  RETURN jsonb_build_object(
    'id', v_id, 'created', v_created, 'items', COALESCE(array_length(v_keep, 1), 0), 'events', v_events,
    'delivered_changed', v_prev.id IS NOT NULL AND v_prev.delivered_to_seller_at IS DISTINCT FROM v_delivered,
    'business_date', (v_delivered AT TIME ZONE v_tz)::date);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_return_operation(uuid, jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_return_operation(uuid, jsonb, jsonb, timestamptz) TO service_role;

-- Fix operations stored before this migration: Hoàn Trả carrier = return-leg carrier (NULL when unknown).
UPDATE public.channel_return_operations o
SET logistics_provider = NULLIF(btrim(r.reverse_logistics_channel_name), '')
FROM public.channel_returns r
WHERE o.return_id = r.id
  AND o.logistics_provider IS DISTINCT FROM NULLIF(btrim(r.reverse_logistics_channel_name), '');

NOTIFY pgrst, 'reload schema';
