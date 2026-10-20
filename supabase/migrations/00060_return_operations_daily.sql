-- ============================================================
-- PHASE SHOPEE-6B: daily return operations — Hoàn Trả + Hoàn Hủy delivered
-- back to the seller, delivery windows ("ca giao"), receiver confirmation,
-- attention flags, scheduled notifications with exact deltas.
--
-- OPERATIONAL ONLY. Nothing here touches inventory (no return_in, no
-- ledger, no product_cost_state), COGS, order_financials, payouts or any
-- money column — the regression test asserts it.
--
--   channel_return_operations        one row per tracked physical return:
--     customer_return         (Hoàn Trả)  identity 'return:<return_sn>'
--     failed_delivery_return  (Hoàn Hủy)  identity 'fd:<order_sn>'
--   delivered_to_seller_at = provider event time "delivered back to the
--   seller"; business_date = its DATE in the shop's timezone (shops.timezone,
--   default Asia/Ho_Chi_Minh). Delivery window = assigned at QUERY time from
--   the local delivered time (v_return_operations) → a late sync never moves
--   an operation to another window; a provider correction moves it (and its
--   business_date) while notification snapshots keep their own membership.
-- ============================================================


-- ============================================================
-- A. Supporting columns
-- ============================================================
ALTER TABLE public.shops ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh';

-- Order fields the failed-delivery classification needs (from get_order_detail).
ALTER TABLE public.channel_orders
  ADD COLUMN cancel_reason    text,
  ADD COLUMN logistics_status text,
  ADD COLUMN package_number   text,
  ADD COLUMN package_count    integer;
CREATE INDEX idx_channel_orders_cancelled_recent ON public.channel_orders (shop_id, updated_at_channel) WHERE order_status = 'CANCELLED';

ALTER TABLE public.channel_sync_jobs DROP CONSTRAINT channel_sync_jobs_sync_type_check;
ALTER TABLE public.channel_sync_jobs ADD CONSTRAINT channel_sync_jobs_sync_type_check
  CHECK (sync_type IN ('product', 'order', 'escrow', 'income', 'return', 'payout', 'return_logistics', 'failed_delivery'));


-- ============================================================
-- B. Canonical return operations
-- ============================================================
CREATE TABLE public.channel_return_operations (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  channel_order_id        uuid        NOT NULL,
  return_id               uuid        REFERENCES public.channel_returns(id) ON DELETE CASCADE,
  operation_type          text        NOT NULL CHECK (operation_type IN ('customer_return', 'failed_delivery_return')),
  identity_key            text        NOT NULL,
  provider_return_id      text,
  return_sn               text,
  tracking_number         text,
  rts_tracking_number     text,
  logistics_provider      text,
  provider_status         text,
  canonical_status        text        NOT NULL DEFAULT 'pending' CHECK (canonical_status IN (
                            'pending', 'in_transit_to_seller', 'out_for_delivery_to_seller', 'delivered_to_seller',
                            'delivery_failed', 'lost', 'cancelled', 'unknown')),
  source_segment          text        CHECK (source_segment IN ('post_return', 'reverse', 'failed_delivery_rts')),
  delivered_to_seller_at  timestamptz,
  delivered_at_source     text        CHECK (delivered_at_source IN ('tracking_event', 'status_update_time')),
  business_date           date,
  last_status_at          timestamptz,
  last_synced_at          timestamptz NOT NULL DEFAULT now(),
  sync_notes              text[],
  assigned_receiver_id    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  received_confirmed_at   timestamptz,
  received_confirmed_by   uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  needs_attention         boolean     NOT NULL DEFAULT false,
  attention_reason        text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, identity_key),
  FOREIGN KEY (channel_order_id, shop_id) REFERENCES public.channel_orders(id, shop_id) ON DELETE CASCADE,
  CHECK ((operation_type = 'customer_return') = (return_id IS NOT NULL)),
  CHECK ((delivered_to_seller_at IS NULL) = (business_date IS NULL))
);
CREATE INDEX idx_return_ops_day          ON public.channel_return_operations (business_date, shop_id, operation_type) WHERE business_date IS NOT NULL;
CREATE INDEX idx_return_ops_delivered_at ON public.channel_return_operations (delivered_to_seller_at) WHERE delivered_to_seller_at IS NOT NULL;
CREATE INDEX idx_return_ops_open         ON public.channel_return_operations (shop_id, last_synced_at) WHERE delivered_to_seller_at IS NULL;
CREATE INDEX idx_return_ops_provider     ON public.channel_return_operations (shop_id, lower(logistics_provider));
CREATE INDEX idx_return_ops_tracking     ON public.channel_return_operations (tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX idx_return_ops_rts_tracking ON public.channel_return_operations (rts_tracking_number) WHERE rts_tracking_number IS NOT NULL;
CREATE INDEX idx_return_ops_return_sn    ON public.channel_return_operations (return_sn) WHERE return_sn IS NOT NULL;
CREATE INDEX idx_return_ops_order        ON public.channel_return_operations (channel_order_id);
CREATE UNIQUE INDEX uq_return_ops_return ON public.channel_return_operations (return_id) WHERE return_id IS NOT NULL;
CREATE INDEX idx_return_ops_attention    ON public.channel_return_operations (shop_id) WHERE needs_attention;

-- Item snapshot of what physically comes back (names frozen at sync time).
CREATE TABLE public.channel_return_operation_items (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_operation_id    uuid          NOT NULL REFERENCES public.channel_return_operations(id) ON DELETE CASCADE,
  channel_order_item_id  uuid          REFERENCES public.channel_order_items(id) ON DELETE SET NULL,
  provider_item_id       text,
  provider_model_id      text,
  item_name_snapshot     text          NOT NULL,
  model_name_snapshot    text,
  sku_snapshot           text,
  quantity               numeric(18,4) NOT NULL CHECK (quantity > 0),
  created_at             timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_return_op_items_identity ON public.channel_return_operation_items
  (return_operation_id, COALESCE(provider_item_id, ''), COALESCE(provider_model_id, ''), COALESCE(channel_order_item_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Provider tracking history (append-only, idempotent by a deterministic key).
CREATE TABLE public.channel_return_logistics_events (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  return_operation_id  uuid        NOT NULL REFERENCES public.channel_return_operations(id) ON DELETE CASCADE,
  tracking_number      text,
  provider_status      text,
  canonical_status     text        NOT NULL,
  event_time           timestamptz NOT NULL,
  description          text,
  location             text,
  source_segment       text        NOT NULL CHECK (source_segment IN ('post_return', 'reverse', 'failed_delivery_rts')),
  event_key            text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (return_operation_id, event_key)
);
CREATE INDEX idx_return_events_op_time ON public.channel_return_logistics_events (return_operation_id, event_time);


-- ============================================================
-- C. Configuration
-- ============================================================
-- Delivery windows: most specific scope wins (shop+carrier > carrier >
-- shop > global); minute-inclusive [start_time, end_time].
CREATE TABLE public.return_delivery_windows (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid        REFERENCES public.shops(id) ON DELETE CASCADE,
  carrier     text        CHECK (carrier IS NULL OR btrim(carrier) <> ''),
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  start_time  time        NOT NULL,
  end_time    time        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time >= start_time)
);
CREATE INDEX idx_return_windows_scope ON public.return_delivery_windows (shop_id, lower(carrier));

INSERT INTO public.return_delivery_windows (name, start_time, end_time, sort_order) VALUES
  ('Ca sáng', '08:00', '11:59', 1),
  ('Ca chiều', '12:00', '16:59', 2),
  ('Ca tối', '17:00', '21:00', 3);

-- Default responsible receiver per operation type (shop row overrides the global one).
CREATE TABLE public.return_operation_assignments (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                   uuid        REFERENCES public.shops(id) ON DELETE CASCADE,
  operation_type            text        NOT NULL CHECK (operation_type IN ('customer_return', 'failed_delivery_return')),
  default_receiver_user_id  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_return_assignments_scope ON public.return_operation_assignments
  (COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), operation_type);

-- Thresholds (one row). Nothing business-SLA-like is hard-coded elsewhere.
CREATE TABLE public.return_operation_settings (
  id                        boolean     PRIMARY KEY DEFAULT true CHECK (id),
  confirmation_enabled      boolean     NOT NULL DEFAULT true,
  confirm_attention_hours   integer     NOT NULL DEFAULT 24 CHECK (confirm_attention_hours BETWEEN 1 AND 720),
  stuck_transit_days        integer     NOT NULL DEFAULT 10 CHECK (stuck_transit_days BETWEEN 1 AND 90),
  tracking_missing_hours    integer     NOT NULL DEFAULT 48 CHECK (tracking_missing_hours BETWEEN 1 AND 720),
  sync_stale_warn_minutes   integer     NOT NULL DEFAULT 30 CHECK (sync_stale_warn_minutes BETWEEN 5 AND 1440),
  tracking_lookback_days    integer     NOT NULL DEFAULT 45 CHECK (tracking_lookback_days BETWEEN 1 AND 180),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        REFERENCES public.profiles(id) ON DELETE SET NULL
);
INSERT INTO public.return_operation_settings (id) VALUES (true);


-- ============================================================
-- D. Notifications (channel today: Zalo through notifications/service.ts)
-- ============================================================
CREATE TABLE public.return_notification_settings (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                uuid        REFERENCES public.shops(id) ON DELETE CASCADE,
  name                   text        NOT NULL DEFAULT 'Hàng hoàn đã giao',
  enabled                boolean     NOT NULL DEFAULT false,
  timezone               text        NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  carrier_filter         text        CHECK (carrier_filter IS NULL OR btrim(carrier_filter) <> ''),
  operation_type_filter  text        CHECK (operation_type_filter IN ('customer_return', 'failed_delivery_return')),
  include_delta          boolean     NOT NULL DEFAULT true,
  include_detail         boolean     NOT NULL DEFAULT false,
  presync_minutes        integer     NOT NULL DEFAULT 10 CHECK (presync_minutes BETWEEN 0 AND 60),
  channel                text        NOT NULL DEFAULT 'zalo' CHECK (channel IN ('zalo')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.return_notification_schedules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_id   uuid        NOT NULL REFERENCES public.return_notification_settings(id) ON DELETE CASCADE,
  time_of_day  time        NOT NULL,
  enabled      boolean     NOT NULL DEFAULT true,
  sort_order   integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (setting_id, time_of_day)
);

-- One run per (setting, business date, slot). History survives a deleted setting.
CREATE TABLE public.return_notification_runs (
  id                           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_id                   uuid          REFERENCES public.return_notification_settings(id) ON DELETE SET NULL,
  shop_id                      uuid          REFERENCES public.shops(id) ON DELETE SET NULL,
  business_date                date          NOT NULL,
  scheduled_time               time          NOT NULL,
  generated_at                 timestamptz   NOT NULL DEFAULT now(),
  carrier_filter               text,
  operation_type_filter        text,
  customer_return_order_count  integer       NOT NULL DEFAULT 0,
  customer_return_item_qty     numeric(18,4) NOT NULL DEFAULT 0,
  failed_delivery_order_count  integer       NOT NULL DEFAULT 0,
  failed_delivery_item_qty     numeric(18,4) NOT NULL DEFAULT 0,
  total_order_count            integer       NOT NULL DEFAULT 0,
  total_item_qty               numeric(18,4) NOT NULL DEFAULT 0,
  previous_run_id              uuid          REFERENCES public.return_notification_runs(id) ON DELETE SET NULL,
  new_order_count              integer,
  new_item_qty                 numeric(18,4),
  message_text                 text,
  recipients_total             integer,
  recipients_sent              integer,
  status                       text          NOT NULL DEFAULT 'generating'
                                 CHECK (status IN ('generating', 'sent', 'partial', 'failed', 'no_recipients')),
  error                        text,
  created_at                   timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (setting_id, business_date, scheduled_time)
);
CREATE INDEX idx_return_notification_runs_recent ON public.return_notification_runs (generated_at DESC);

CREATE TABLE public.return_notification_run_operations (
  notification_run_id  uuid NOT NULL REFERENCES public.return_notification_runs(id) ON DELETE CASCADE,
  return_operation_id  uuid NOT NULL REFERENCES public.channel_return_operations(id) ON DELETE CASCADE,
  PRIMARY KEY (notification_run_id, return_operation_id)
);


-- ============================================================
-- E. updated_at triggers + privileges
-- ============================================================
CREATE TRIGGER set_return_ops_updated_at          BEFORE UPDATE ON public.channel_return_operations    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_return_windows_updated_at      BEFORE UPDATE ON public.return_delivery_windows      FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_return_assignments_updated_at  BEFORE UPDATE ON public.return_operation_assignments FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_return_notif_settings_updated  BEFORE UPDATE ON public.return_notification_settings FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channel_return_operations', 'channel_return_operation_items', 'channel_return_logistics_events',
    'return_delivery_windows', 'return_operation_assignments', 'return_operation_settings',
    'return_notification_settings', 'return_notification_schedules', 'return_notification_runs',
    'return_notification_run_operations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY active_users_select ON public.%I FOR SELECT TO authenticated USING (public.is_active_user())', t);
  END LOOP;
END;
$$;


-- ============================================================
-- F. Classification + window assignment (SQL mirrors of the TS rules)
-- ============================================================
-- Mirror of classifyReturnOperation (src/lib/return-operations/classify.ts):
-- CANCELLED after the carrier took the parcel, and no customer return record.
CREATE OR REPLACE FUNCTION public.return_failed_delivery_candidate(p_order_status text, p_pickup_done_at timestamptz, p_package_status text, p_has_returns boolean)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT NOT COALESCE(p_has_returns, false)
     AND upper(COALESCE(p_order_status, '')) = 'CANCELLED'
     AND (p_pickup_done_at IS NOT NULL
          OR upper(COALESCE(p_package_status, '')) IN ('LOGISTICS_PICKUP_DONE', 'LOGISTICS_DELIVERY_FAILED', 'LOGISTICS_COD_REJECTED', 'LOGISTICS_LOST', 'LOGISTICS_DELIVERY_DONE'));
$$;

-- Mirror of resolveWindowSet + assignWindow (src/lib/return-operations/windows.ts).
CREATE OR REPLACE FUNCTION public.return_assign_window(p_shop_id uuid, p_carrier text, p_local time)
RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH scope AS (
    SELECT w.shop_id, lower(btrim(COALESCE(w.carrier, ''))) AS carrier_key
    FROM public.return_delivery_windows w
    WHERE w.enabled
      AND (w.shop_id IS NULL OR w.shop_id = p_shop_id)
      AND (w.carrier IS NULL OR (p_carrier IS NOT NULL AND lower(btrim(w.carrier)) = lower(btrim(p_carrier))))
    ORDER BY CASE WHEN w.shop_id IS NOT NULL AND w.carrier IS NOT NULL THEN 4
                  WHEN w.carrier IS NOT NULL THEN 3
                  WHEN w.shop_id IS NOT NULL THEN 2
                  ELSE 1 END DESC
    LIMIT 1
  )
  SELECT w.id
  FROM scope s
  JOIN public.return_delivery_windows w
    ON w.enabled AND w.shop_id IS NOT DISTINCT FROM s.shop_id AND lower(btrim(COALESCE(w.carrier, ''))) = s.carrier_key
  WHERE date_trunc('minute', DATE '2000-01-01' + p_local)::time BETWEEN w.start_time AND w.end_time
  ORDER BY w.sort_order, w.start_time
  LIMIT 1;
$$;

-- Attention reason of one operation (null = fine). Order = priority.
CREATE OR REPLACE FUNCTION public.return_operation_attention_reason(
  p_type text, p_status text, p_delivered timestamptz, p_received timestamptz, p_tracking text, p_rts text,
  p_last_status timestamptz, p_created timestamptz, p_now timestamptz,
  p_confirm_enabled boolean, p_confirm_hours integer, p_stuck_days integer, p_missing_hours integer)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_delivered IS NOT NULL THEN
      CASE WHEN p_confirm_enabled AND p_received IS NULL AND p_delivered < p_now - make_interval(hours => p_confirm_hours)
           THEN 'delivered_but_not_confirmed' END
    WHEN p_received IS NOT NULL THEN NULL
    WHEN p_status = 'lost' THEN 'lost'
    WHEN p_status = 'delivery_failed' THEN 'delivery_failed'
    WHEN p_status = 'unknown' THEN 'unknown_status'
    WHEN p_status = 'cancelled' THEN NULL
    WHEN p_type = 'failed_delivery_return' AND p_tracking IS NULL AND p_rts IS NULL
         AND p_created < p_now - make_interval(hours => p_missing_hours) THEN 'tracking_missing'
    WHEN (p_status IN ('in_transit_to_seller', 'out_for_delivery_to_seller') OR (p_type = 'failed_delivery_return' AND p_status = 'pending'))
         AND COALESCE(p_last_status, p_created) < p_now - make_interval(days => p_stuck_days) THEN 'stuck_in_return_transit'
  END;
$$;

-- Recompute needs_attention for recent / flagged operations (time-based reasons change without a sync).
CREATE OR REPLACE FUNCTION public.refresh_return_operation_attention(p_shop_id uuid DEFAULT NULL, p_operation_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  s public.return_operation_settings%ROWTYPE;
  v_count integer;
BEGIN
  SELECT * INTO s FROM public.return_operation_settings WHERE id;
  WITH calc AS (
    SELECT o.id, public.return_operation_attention_reason(
             o.operation_type, o.canonical_status, o.delivered_to_seller_at, o.received_confirmed_at, o.tracking_number, o.rts_tracking_number,
             o.last_status_at, o.created_at, now(),
             s.confirmation_enabled, s.confirm_attention_hours, s.stuck_transit_days, s.tracking_missing_hours) AS reason
    FROM public.channel_return_operations o
    WHERE (p_shop_id IS NULL OR o.shop_id = p_shop_id)
      AND (p_operation_id IS NULL OR o.id = p_operation_id)
      AND (o.needs_attention OR o.created_at >= now() - make_interval(days => s.tracking_lookback_days + 30))
  )
  UPDATE public.channel_return_operations o
     SET needs_attention = c.reason IS NOT NULL, attention_reason = c.reason
    FROM calc c
   WHERE o.id = c.id AND (o.needs_attention IS DISTINCT FROM (c.reason IS NOT NULL) OR o.attention_reason IS DISTINCT FROM c.reason);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


-- ============================================================
-- G. Apply one provider observation (one transaction, idempotent)
-- ============================================================
-- p_op: operation_type, channel_order_id, return_id, return_sn, provider_return_id,
--       tracking_number, rts_tracking_number, logistics_provider, provider_status,
--       canonical_status, source_segment, delivered_to_seller_at, delivered_at_source,
--       last_status_at, sync_notes (text[])
-- p_events: [{source_segment, event_time, provider_status, canonical_status, description, location, tracking_number}]
-- Items are rebuilt here from the canonical return / order lines (never from the UI).
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
  ELSE
    v_return_id := NULL;
    v_identity := 'fd:' || v_order.external_order_sn;
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
     COALESCE(NULLIF(btrim(p_op ->> 'logistics_provider'), ''), v_order.shipping_carrier),
     p_op ->> 'provider_status', COALESCE(p_op ->> 'canonical_status', 'pending'), p_op ->> 'source_segment',
     v_delivered, CASE WHEN v_delivered IS NULL THEN NULL ELSE p_op ->> 'delivered_at_source' END,
     (v_delivered AT TIME ZONE v_tz)::date,
     (p_op ->> 'last_status_at')::timestamptz, p_synced_at,
     CASE WHEN jsonb_typeof(p_op -> 'sync_notes') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(p_op -> 'sync_notes')) END,
     v_receiver)
  ON CONFLICT (shop_id, identity_key) DO UPDATE SET
    provider_return_id  = COALESCE(EXCLUDED.provider_return_id, o.provider_return_id),
    return_sn           = COALESCE(EXCLUDED.return_sn, o.return_sn),
    -- a known tracking number is never erased by a payload that omits it
    tracking_number     = COALESCE(EXCLUDED.tracking_number, o.tracking_number),
    rts_tracking_number = COALESCE(EXCLUDED.rts_tracking_number, o.rts_tracking_number),
    logistics_provider  = COALESCE(NULLIF(btrim(p_op ->> 'logistics_provider'), ''), o.logistics_provider, EXCLUDED.logistics_provider),
    provider_status     = EXCLUDED.provider_status,
    canonical_status    = EXCLUDED.canonical_status,
    source_segment      = EXCLUDED.source_segment,
    -- provider correction: delivered time / business date follow the provider
    delivered_to_seller_at = EXCLUDED.delivered_to_seller_at,
    delivered_at_source    = EXCLUDED.delivered_at_source,
    business_date          = EXCLUDED.business_date,
    last_status_at      = COALESCE(EXCLUDED.last_status_at, o.last_status_at),
    last_synced_at      = EXCLUDED.last_synced_at,
    sync_notes          = EXCLUDED.sync_notes
  RETURNING o.id, (xmax = 0) INTO v_id, v_created;

  -- items: Hoàn Trả = returned quantities; Hoàn Hủy = the order lines (whole parcel back)
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

-- "Đã nhận": internal confirmation only (no stock, no cost, no money).
CREATE OR REPLACE FUNCTION public.confirm_return_operation_received(p_operation_id uuid, p_by uuid, p_confirm boolean)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r record;
BEGIN
  UPDATE public.channel_return_operations o
     SET received_confirmed_at = CASE WHEN p_confirm THEN COALESCE(o.received_confirmed_at, now()) END,
         received_confirmed_by = CASE WHEN p_confirm THEN COALESCE(o.received_confirmed_by, p_by) END
   WHERE o.id = p_operation_id
  RETURNING o.id, o.received_confirmed_at INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy đơn hoàn %', p_operation_id USING ERRCODE = 'P0002'; END IF;
  PERFORM public.refresh_return_operation_attention(NULL, p_operation_id);
  RETURN jsonb_build_object('id', r.id, 'received_confirmed_at', r.received_confirmed_at);
END;
$$;


-- ============================================================
-- H. Sync candidates (bounded; polling state = last_synced_at)
-- ============================================================
-- Hoàn Trả: returns whose goods come back, not delivered yet (or delivered
-- recently — catches provider corrections), not polled since the cut-off.
CREATE OR REPLACE FUNCTION public.return_logistics_candidates(
  p_shop_id uuid, p_open_since timestamptz, p_delivered_since timestamptz, p_lookback_days integer, p_limit integer, p_focus_date date DEFAULT NULL)
RETURNS TABLE (return_id uuid, external_return_sn text, order_id uuid, operation_id uuid)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT r.id, r.external_return_sn, r.order_id, op.id
  FROM public.channel_returns r
  LEFT JOIN public.channel_return_operations op ON op.return_id = r.id
  WHERE r.shop_id = p_shop_id
    AND COALESCE(r.needs_logistics, true)
    AND (upper(COALESCE(r.status, '')) <> 'CANCELLED' OR (op.id IS NOT NULL AND op.last_synced_at < COALESCE(r.updated_at_channel, r.updated_at)))
    AND (COALESCE(r.created_at_channel, r.created_at) >= now() - make_interval(days => p_lookback_days) OR op.business_date = p_focus_date)
    AND (op.id IS NULL
         OR (op.delivered_to_seller_at IS NULL AND op.canonical_status <> 'cancelled' AND op.last_synced_at < p_open_since)
         OR (op.delivered_to_seller_at IS NOT NULL AND op.last_synced_at < p_delivered_since
             AND (op.delivered_to_seller_at >= now() - interval '2 days' OR op.business_date = p_focus_date)))
  ORDER BY op.last_synced_at NULLS FIRST, r.created_at_channel DESC NULLS LAST
  LIMIT p_limit;
$$;

-- Hoàn Hủy: cancelled-after-pickup orders without any customer return.
CREATE OR REPLACE FUNCTION public.failed_delivery_candidates(
  p_shop_id uuid, p_open_since timestamptz, p_delivered_since timestamptz, p_lookback_days integer, p_limit integer, p_focus_date date DEFAULT NULL)
RETURNS TABLE (order_id uuid, external_order_sn text, package_number text, operation_id uuid, tracking_number text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT o.id, o.external_order_sn, o.package_number, op.id, op.tracking_number
  FROM public.channel_orders o
  LEFT JOIN public.channel_return_operations op ON op.shop_id = o.shop_id AND op.identity_key = 'fd:' || o.external_order_sn
  WHERE o.shop_id = p_shop_id
    AND o.order_status = 'CANCELLED'
    AND public.return_failed_delivery_candidate(o.order_status, o.pickup_done_at_channel, o.logistics_status,
                                                EXISTS (SELECT 1 FROM public.channel_returns r WHERE r.order_id = o.id))
    AND (COALESCE(o.updated_at_channel, o.created_at) >= now() - make_interval(days => p_lookback_days) OR op.business_date = p_focus_date)
    AND (op.id IS NULL
         OR (op.delivered_to_seller_at IS NULL AND op.canonical_status <> 'cancelled' AND op.last_synced_at < p_open_since)
         OR (op.delivered_to_seller_at IS NOT NULL AND op.last_synced_at < p_delivered_since
             AND (op.delivered_to_seller_at >= now() - interval '2 days' OR op.business_date = p_focus_date)))
  ORDER BY op.last_synced_at NULLS FIRST, o.updated_at_channel DESC NULLS LAST
  LIMIT p_limit;
$$;


-- ============================================================
-- I. Read model: one view, every daily query reads it
-- ============================================================
CREATE OR REPLACE VIEW public.v_return_operations
WITH (security_invoker = true) AS
SELECT
  o.id,
  o.shop_id,
  s.shop_name,
  s.timezone,
  o.channel_order_id,
  co.external_order_sn,
  o.return_id,
  o.operation_type,
  o.return_sn,
  o.tracking_number,
  o.rts_tracking_number,
  o.logistics_provider,
  NULLIF(btrim(o.logistics_provider), '') AS carrier,
  o.provider_status,
  o.canonical_status,
  o.source_segment,
  o.delivered_to_seller_at,
  o.delivered_at_source,
  o.business_date,
  (o.delivered_to_seller_at AT TIME ZONE s.timezone)::time AS delivered_local_time,
  CASE WHEN o.delivered_to_seller_at IS NOT NULL
       THEN public.return_assign_window(o.shop_id, o.logistics_provider, (o.delivered_to_seller_at AT TIME ZONE s.timezone)::time) END AS window_id,
  o.last_status_at,
  o.last_synced_at,
  o.sync_notes,
  o.assigned_receiver_id,
  o.received_confirmed_at,
  o.received_confirmed_by,
  o.needs_attention,
  o.attention_reason,
  o.created_at
FROM public.channel_return_operations o
JOIN public.shops s ON s.id = o.shop_id
JOIN public.channel_orders co ON co.id = o.channel_order_id;

REVOKE ALL ON public.v_return_operations FROM anon;
GRANT SELECT ON public.v_return_operations TO authenticated, service_role;

-- p_carrier: NULL = all, '' = unknown carrier, else carrier name (case-insensitive)
-- p_window : NULL = all, 'outside' = outside every window, else window uuid
CREATE OR REPLACE FUNCTION public.return_operations_filter(
  v public.v_return_operations, p_shop_ids uuid[], p_carrier text, p_type text, p_window text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_shop_ids IS NULL OR v.shop_id = ANY (p_shop_ids))
     AND (p_carrier IS NULL OR (p_carrier = '' AND v.carrier IS NULL) OR lower(v.carrier) = lower(btrim(p_carrier)))
     AND (p_type IS NULL OR v.operation_type = p_type)
     AND (p_window IS NULL OR (p_window = 'outside' AND v.window_id IS NULL) OR v.window_id::text = p_window);
$$;

-- Daily aggregation: (carrier, window, type) → orders + item quantity.
-- Only operations whose delivered_to_seller_at falls on p_date (business tz).
CREATE OR REPLACE FUNCTION public.get_return_operations_daily_summary(
  p_date date, p_shop_ids uuid[] DEFAULT NULL, p_carrier text DEFAULT NULL, p_type text DEFAULT NULL, p_window text DEFAULT NULL)
RETURNS TABLE (shop_id uuid, carrier text, window_id uuid, operation_type text, order_count bigint, item_qty text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT v.shop_id, v.carrier, v.window_id, v.operation_type, count(*), COALESCE(sum(q.qty), 0)::text
  FROM public.v_return_operations v
  LEFT JOIN LATERAL (SELECT sum(i.quantity) AS qty FROM public.channel_return_operation_items i WHERE i.return_operation_id = v.id) q ON true
  WHERE v.business_date = p_date
    AND public.return_operations_filter(v, p_shop_ids, p_carrier, p_type, p_window)
  GROUP BY v.shop_id, v.carrier, v.window_id, v.operation_type;
$$;

-- Detail list (server pagination).
--   p_view 'delivered' = delivered on p_date (default); 'open' = not delivered yet (any date)
--   p_status: canonical status | 'unconfirmed' | 'confirmed' | 'attention'
CREATE OR REPLACE FUNCTION public.list_return_operations(
  p_date date, p_shop_ids uuid[] DEFAULT NULL, p_carrier text DEFAULT NULL, p_type text DEFAULT NULL, p_window text DEFAULT NULL,
  p_status text DEFAULT NULL, p_search text DEFAULT NULL, p_view text DEFAULT 'delivered', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid, shop_id uuid, shop_name text, channel_order_id uuid, external_order_sn text, return_id uuid, operation_type text,
  return_sn text, tracking_number text, rts_tracking_number text, carrier text, provider_status text, canonical_status text,
  source_segment text, delivered_to_seller_at timestamptz, delivered_at_source text, business_date date, window_id uuid,
  last_status_at timestamptz, last_synced_at timestamptz, assigned_receiver_id uuid, received_confirmed_at timestamptz,
  received_confirmed_by uuid, needs_attention boolean, attention_reason text, item_qty text, items jsonb, total_count bigint)
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
         COALESCE(it.qty, 0)::text, COALESCE(it.items, '[]'::jsonb), p.total_count
  FROM page p
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

-- Counters for the page header (open / attention / unconfirmed).
CREATE OR REPLACE FUNCTION public.get_return_operations_counters(p_date date, p_shop_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'open', count(*) FILTER (WHERE o.delivered_to_seller_at IS NULL AND o.received_confirmed_at IS NULL AND o.canonical_status <> 'cancelled'),
    'attention', count(*) FILTER (WHERE o.needs_attention),
    'unconfirmed_today', count(*) FILTER (WHERE o.business_date = p_date AND o.received_confirmed_at IS NULL))
  FROM public.channel_return_operations o
  WHERE (p_shop_ids IS NULL OR o.shop_id = ANY (p_shop_ids));
$$;


-- ============================================================
-- J. Notification runs (claim → snapshot → send → finish)
-- ============================================================
-- Claims the (setting, date, slot) run; NULL when it exists already. A run
-- stuck in 'generating' for > 5 min (crashed invocation) can be re-claimed.
CREATE OR REPLACE FUNCTION public.claim_return_notification_run(p_setting_id uuid, p_business_date date, p_scheduled_time time)
RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  st public.return_notification_settings%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO st FROM public.return_notification_settings WHERE id = p_setting_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.return_notification_runs (setting_id, shop_id, business_date, scheduled_time, carrier_filter, operation_type_filter)
  VALUES (p_setting_id, st.shop_id, p_business_date, p_scheduled_time, st.carrier_filter, st.operation_type_filter)
  ON CONFLICT (setting_id, business_date, scheduled_time) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    UPDATE public.return_notification_runs r SET generated_at = now(), error = NULL
     WHERE r.setting_id = p_setting_id AND r.business_date = p_business_date AND r.scheduled_time = p_scheduled_time
       AND r.status = 'generating' AND r.generated_at < now() - interval '5 minutes'
    RETURNING r.id INTO v_id;
    IF v_id IS NOT NULL THEN DELETE FROM public.return_notification_run_operations WHERE notification_run_id = v_id; END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- Membership (exact operation ids) + counts + exact delta vs the previous
-- SUCCESSFUL run (sent / partial) of the same setting and business date.
CREATE OR REPLACE FUNCTION public.snapshot_return_notification_run(p_run_id uuid, p_sample_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r       public.return_notification_runs%ROWTYPE;
  v_prev  public.return_notification_runs%ROWTYPE;
  v_shops uuid[];
  c       record;
  d       record;
  v_sample text[];
BEGIN
  SELECT * INTO r FROM public.return_notification_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'run % không tồn tại', p_run_id USING ERRCODE = 'P0002'; END IF;
  v_shops := CASE WHEN r.shop_id IS NULL THEN NULL ELSE ARRAY[r.shop_id] END;
  SELECT 0::bigint AS n, 0::numeric AS qty INTO d;

  INSERT INTO public.return_notification_run_operations (notification_run_id, return_operation_id)
  SELECT p_run_id, v.id FROM public.v_return_operations v
  WHERE v.business_date = r.business_date AND public.return_operations_filter(v, v_shops, r.carrier_filter, r.operation_type_filter, NULL)
  ON CONFLICT DO NOTHING;

  SELECT count(*) FILTER (WHERE o.operation_type = 'customer_return') AS cr_n,
         COALESCE(sum(q.qty) FILTER (WHERE o.operation_type = 'customer_return'), 0) AS cr_q,
         count(*) FILTER (WHERE o.operation_type = 'failed_delivery_return') AS fd_n,
         COALESCE(sum(q.qty) FILTER (WHERE o.operation_type = 'failed_delivery_return'), 0) AS fd_q
  INTO c
  FROM public.return_notification_run_operations m
  JOIN public.channel_return_operations o ON o.id = m.return_operation_id
  LEFT JOIN LATERAL (SELECT sum(i.quantity) AS qty FROM public.channel_return_operation_items i WHERE i.return_operation_id = o.id) q ON true
  WHERE m.notification_run_id = p_run_id;

  SELECT * INTO v_prev FROM public.return_notification_runs p
  WHERE p.setting_id IS NOT DISTINCT FROM r.setting_id AND p.business_date = r.business_date
    AND p.scheduled_time < r.scheduled_time AND p.status IN ('sent', 'partial') AND p.id <> p_run_id
  ORDER BY p.scheduled_time DESC LIMIT 1;

  IF v_prev.id IS NOT NULL THEN
    SELECT count(*) AS n, COALESCE(sum(q.qty), 0) AS qty INTO d
    FROM public.return_notification_run_operations m
    JOIN public.channel_return_operations o ON o.id = m.return_operation_id
    LEFT JOIN LATERAL (SELECT sum(i.quantity) AS qty FROM public.channel_return_operation_items i WHERE i.return_operation_id = o.id) q ON true
    WHERE m.notification_run_id = p_run_id
      AND NOT EXISTS (SELECT 1 FROM public.return_notification_run_operations pm WHERE pm.notification_run_id = v_prev.id AND pm.return_operation_id = m.return_operation_id);
    SELECT array_agg(x.sn) INTO v_sample FROM (
      SELECT co.external_order_sn AS sn
      FROM public.return_notification_run_operations m
      JOIN public.channel_return_operations o ON o.id = m.return_operation_id
      JOIN public.channel_orders co ON co.id = o.channel_order_id
      WHERE m.notification_run_id = p_run_id
        AND NOT EXISTS (SELECT 1 FROM public.return_notification_run_operations pm WHERE pm.notification_run_id = v_prev.id AND pm.return_operation_id = m.return_operation_id)
      ORDER BY o.delivered_to_seller_at DESC, o.id LIMIT p_sample_limit) x;
  END IF;

  UPDATE public.return_notification_runs SET
    customer_return_order_count = c.cr_n, customer_return_item_qty = c.cr_q,
    failed_delivery_order_count = c.fd_n, failed_delivery_item_qty = c.fd_q,
    total_order_count = c.cr_n + c.fd_n, total_item_qty = c.cr_q + c.fd_q,
    previous_run_id = v_prev.id,
    new_order_count = CASE WHEN v_prev.id IS NULL THEN NULL ELSE d.n END,
    new_item_qty = CASE WHEN v_prev.id IS NULL THEN NULL ELSE d.qty END
  WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'total_orders', c.cr_n + c.fd_n, 'total_items', (c.cr_q + c.fd_q)::text,
    'previous_run_id', v_prev.id, 'previous_time', to_char(v_prev.scheduled_time, 'HH24:MI'),
    'new_orders', CASE WHEN v_prev.id IS NULL THEN NULL ELSE d.n END,
    'new_items', CASE WHEN v_prev.id IS NULL THEN NULL ELSE d.qty::text END,
    'sample_order_sns', COALESCE(to_jsonb(v_sample), '[]'::jsonb));
END;
$$;


-- ============================================================
-- K. Privileges (cloud has no default EXECUTE grants — explicit, always)
-- ============================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'return_failed_delivery_candidate(text, timestamptz, text, boolean)',
    'return_assign_window(uuid, text, time)',
    'return_operation_attention_reason(text, text, timestamptz, timestamptz, text, text, timestamptz, timestamptz, timestamptz, boolean, integer, integer, integer)',
    'refresh_return_operation_attention(uuid, uuid)',
    'apply_return_operation(uuid, jsonb, jsonb, timestamptz)',
    'confirm_return_operation_received(uuid, uuid, boolean)',
    'return_logistics_candidates(uuid, timestamptz, timestamptz, integer, integer, date)',
    'failed_delivery_candidates(uuid, timestamptz, timestamptz, integer, integer, date)',
    'return_operations_filter(public.v_return_operations, uuid[], text, text, text)',
    'get_return_operations_daily_summary(date, uuid[], text, text, text)',
    'list_return_operations(date, uuid[], text, text, text, text, text, text, integer, integer)',
    'get_return_operations_counters(date, uuid[])',
    'claim_return_notification_run(uuid, date, time)',
    'snapshot_return_notification_run(uuid, integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  -- the view calls return_assign_window for authenticated readers (security_invoker)
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.return_assign_window(uuid, text, time) TO authenticated';
END;
$$;

NOTIFY pgrst, 'reload schema';
