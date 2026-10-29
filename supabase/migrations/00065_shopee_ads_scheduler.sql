-- ============================================================
-- PHASE SHOPEE-ADS-2: optimized 15-minute background Ads sync (READ ONLY).
--
--   A. channel_sync_jobs.lane (generated): one active job per
--      shop + sync_type + LANE. Legacy jobs keep their lanes (backfill | live);
--      Ads jobs carry metadata.lane = ads_hot | ads_warm | ads_cold |
--      ads_backfill | ads_meta, so a pending COLD restatement never blocks
--      the 15-minute HOT read of the same type.
--   B. enqueue_ads_sync_job: dedupe + coalescing in one locked step
--        1. an active job of the same shop + type already COVERS the range
--           (and campaign scope) and is running or queued at the same / a
--           more urgent priority → reuse it, no new row (a queued COLD is
--           never promoted to HOT priority)
--        2. else insert in its lane
--        3. same lane busy, not covering, not started → widen its range
--   C. claim_next_sync_job v3: + p_max_running_ads (global cap on running
--      Ads jobs = bounded Ads API concurrency). Everything else unchanged
--      (priority, then longest-waiting → round robin across shops; ≤ N
--      running per shop; paused shops skipped).
--   D. shopee_ads_shop_settings: per-shop switch (ads_sync_enabled, default
--      OFF), optional fixed stagger slot, and the scheduler's slot bookkeeping
--      (a slot is claimed with a conditional UPDATE → never scheduled twice,
--      even when two cron ticks overlap).
--   E. shopee_ads_campaigns.status_changed_at: when provider_status last
--      changed (trigger) — recently paused / ended campaigns stay in the HOT /
--      WARM candidate sets.
--   F. get_ads_sync_metrics: queue wait / execution / total latency, records,
--      API calls per shop + type + strategy (job rows; no new log table).
--
-- Nothing here writes to Shopee. Ads jobs remain ads_*_read.
-- ============================================================


-- ============================================================
-- A. lanes
-- ============================================================
ALTER TABLE public.channel_sync_jobs
  ADD COLUMN lane text GENERATED ALWAYS AS (COALESCE(metadata ->> 'lane', CASE WHEN mode = 'backfill' THEN 'backfill' ELSE 'live' END)) STORED;

DROP INDEX public.uq_channel_sync_jobs_active;
CREATE UNIQUE INDEX uq_channel_sync_jobs_active
  ON public.channel_sync_jobs (shop_id, sync_type, lane)
  WHERE status IN ('pending', 'running', 'retry');

-- Same contract as before (00045); the lane is now the generated column.
CREATE OR REPLACE FUNCTION public.enqueue_sync_job(
  p_shop_id     uuid,
  p_sync_type   text,
  p_mode        text,
  p_priority    integer,
  p_window_from timestamptz DEFAULT NULL,
  p_window_to   timestamptz DEFAULT NULL,
  p_metadata    jsonb DEFAULT NULL,
  p_created_by  uuid DEFAULT NULL,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE (job_id uuid, created boolean, status text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_status text;
  v_lane text := COALESCE(p_metadata ->> 'lane', CASE WHEN p_mode = 'backfill' THEN 'backfill' ELSE 'live' END);
BEGIN
  INSERT INTO public.channel_sync_jobs (shop_id, sync_type, mode, priority, window_from, window_to, metadata, created_by, max_attempts)
  VALUES (p_shop_id, p_sync_type, p_mode, p_priority, p_window_from, p_window_to, p_metadata, p_created_by, p_max_attempts)
  ON CONFLICT (shop_id, sync_type, lane) WHERE status IN ('pending', 'running', 'retry')
  DO NOTHING
  RETURNING id, channel_sync_jobs.status INTO v_id, v_status;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true, v_status;
    RETURN;
  END IF;

  UPDATE public.channel_sync_jobs j
  SET priority = LEAST(j.priority, p_priority)
  WHERE j.shop_id = p_shop_id AND j.sync_type = p_sync_type
    AND j.lane = v_lane
    AND j.status IN ('pending', 'running', 'retry')
  RETURNING j.id, j.status INTO v_id, v_status;

  IF v_id IS NULL THEN
    INSERT INTO public.channel_sync_jobs (shop_id, sync_type, mode, priority, window_from, window_to, metadata, created_by, max_attempts)
    VALUES (p_shop_id, p_sync_type, p_mode, p_priority, p_window_from, p_window_to, p_metadata, p_created_by, p_max_attempts)
    RETURNING id, channel_sync_jobs.status INTO v_id, v_status;
    RETURN QUERY SELECT v_id, true, v_status;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_id, false, v_status;
END;
$$;


-- ============================================================
-- B. Ads enqueue with dedupe + coalescing
-- ============================================================
CREATE FUNCTION public.enqueue_ads_sync_job(
  p_shop_id      uuid,
  p_sync_type    text,
  p_lane         text,
  p_mode         text,
  p_priority     integer,
  p_metadata     jsonb,
  p_from         date DEFAULT NULL,
  p_to           date DEFAULT NULL,
  p_not_before   timestamptz DEFAULT NULL,
  p_created_by   uuid DEFAULT NULL,
  p_coalesce     boolean DEFAULT true,
  p_max_attempts integer DEFAULT 5
)
RETURNS TABLE (job_id uuid, created boolean, status text, coalesced boolean, job_lane text, job_priority integer)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_meta  jsonb;
  v_scope text := COALESCE(p_metadata ->> 'adsScope', 'all');
  v_job   public.channel_sync_jobs;
BEGIN
  IF p_sync_type NOT IN ('ads_campaign_read', 'ads_campaign_performance_read', 'ads_shop_performance_read') THEN
    RAISE EXCEPTION 'not an Ads read job: %', p_sync_type;
  END IF;
  IF p_lane !~ '^ads_[a-z]+$' THEN
    RAISE EXCEPTION 'bad Ads lane: %', p_lane;
  END IF;
  IF (p_from IS NULL) <> (p_to IS NULL) OR p_to < p_from THEN
    RAISE EXCEPTION 'bad Ads range';
  END IF;

  -- one decision at a time per shop + type (scheduler ticks may overlap)
  PERFORM pg_advisory_xact_lock(hashtext('enqueue_ads_sync_job:' || p_shop_id::text || ':' || p_sync_type));

  v_meta := COALESCE(p_metadata, '{}'::jsonb)
         || jsonb_build_object('lane', p_lane)
         || CASE WHEN p_from IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('adsRange', jsonb_build_object('from', p_from::text, 'to', p_to::text)) END
         || CASE WHEN p_not_before IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('notBefore', p_not_before) END;

  -- 1. an active job of the same shop + type already covers this request AND
  --    will deliver it at least as soon: it is running (its read lands
  --    shortly; the shop could not run a second one meanwhile) or queued at
  --    the same or a more urgent priority. A queued COLD / backfill is never
  --    promoted to HOT priority — HOT gets its own small job instead.
  IF p_coalesce THEN
    SELECT j.* INTO v_job
    FROM public.channel_sync_jobs j
    WHERE j.shop_id = p_shop_id AND j.sync_type = p_sync_type
      AND j.status IN ('pending', 'running', 'retry')
      AND (j.status = 'running' OR j.priority <= p_priority)
      AND (j.lane <> 'ads_backfill' OR p_lane = 'ads_backfill')
      AND (p_from IS NULL OR (
            j.metadata -> 'adsRange' IS NOT NULL
            AND (j.metadata -> 'adsRange' ->> 'from')::date <= p_from
            AND (j.metadata -> 'adsRange' ->> 'to')::date >= p_to))
      AND (COALESCE(j.metadata ->> 'adsScope', 'all') = 'all' OR COALESCE(j.metadata ->> 'adsScope', 'all') = v_scope)
    ORDER BY (j.status = 'running') DESC, j.priority ASC, j.created_at ASC
    LIMIT 1
    FOR UPDATE;
    IF v_job.id IS NOT NULL THEN
      UPDATE public.channel_sync_jobs j SET priority = LEAST(j.priority, p_priority) WHERE j.id = v_job.id RETURNING * INTO v_job;
      RETURN QUERY SELECT v_job.id, false, v_job.status, true, v_job.lane, v_job.priority;
      RETURN;
    END IF;
  END IF;

  -- 2. new job in its lane
  INSERT INTO public.channel_sync_jobs (shop_id, sync_type, mode, priority, metadata, created_by, max_attempts, next_attempt_at)
  VALUES (p_shop_id, p_sync_type, p_mode, p_priority, v_meta, p_created_by, p_max_attempts, p_not_before)
  ON CONFLICT (shop_id, sync_type, lane) WHERE status IN ('pending', 'running', 'retry')
  DO NOTHING
  RETURNING * INTO v_job;
  IF v_job.id IS NOT NULL THEN
    RETURN QUERY SELECT v_job.id, true, v_job.status, false, v_job.lane, v_job.priority;
    RETURN;
  END IF;

  -- 3. same lane busy but not covering (e.g. HOT still queued from before
  --    midnight). Not started yet → widen it to cover both requests.
  SELECT j.* INTO v_job
  FROM public.channel_sync_jobs j
  WHERE j.shop_id = p_shop_id AND j.sync_type = p_sync_type AND j.lane = p_lane
    AND j.status IN ('pending', 'running', 'retry')
  FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Ads enqueue raced with a finishing job; retry';
  END IF;
  IF v_job.status IN ('pending', 'retry') AND COALESCE(v_job.metadata -> 'checkpoint', 'null'::jsonb) = 'null'::jsonb THEN
    UPDATE public.channel_sync_jobs j
    SET priority = LEAST(j.priority, p_priority),
        metadata = j.metadata
          || CASE WHEN p_from IS NULL OR j.metadata -> 'adsRange' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('adsRange', jsonb_build_object(
               'from', LEAST((j.metadata -> 'adsRange' ->> 'from')::date, p_from)::text,
               'to',   GREATEST((j.metadata -> 'adsRange' ->> 'to')::date, p_to)::text)) END
          || CASE WHEN v_scope = 'all' THEN jsonb_build_object('adsScope', 'all') ELSE '{}'::jsonb END
    WHERE j.id = v_job.id
    RETURNING * INTO v_job;
    RETURN QUERY SELECT v_job.id, false, v_job.status, true, v_job.lane, v_job.priority;
    RETURN;
  END IF;
  UPDATE public.channel_sync_jobs j SET priority = LEAST(j.priority, p_priority) WHERE j.id = v_job.id RETURNING * INTO v_job;
  RETURN QUERY SELECT v_job.id, false, v_job.status, false, v_job.lane, v_job.priority;
END;
$$;


-- ============================================================
-- C. claim v3 (drop + create: new argument)
-- ============================================================
DROP FUNCTION public.claim_next_sync_job(text, integer, text[], uuid[], integer);

CREATE FUNCTION public.claim_next_sync_job(
  p_worker_id        text,
  p_max_running      integer DEFAULT 1,
  p_sync_types       text[] DEFAULT NULL,
  p_shop_ids         uuid[] DEFAULT NULL,
  p_max_per_shop     integer DEFAULT 1,
  p_max_running_ads  integer DEFAULT NULL
)
RETURNS SETOF public.channel_sync_jobs
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_job public.channel_sync_jobs;
  v_ads_full boolean := false;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RAISE EXCEPTION 'worker id required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('channel_sync_jobs.claim'));

  IF (SELECT count(*) FROM public.channel_sync_jobs WHERE status = 'running') >= GREATEST(p_max_running, 1) THEN
    RETURN;
  END IF;
  -- ADS-2: bounded Ads API concurrency across all shops
  IF p_max_running_ads IS NOT NULL THEN
    v_ads_full := (SELECT count(*) FROM public.channel_sync_jobs WHERE status = 'running' AND sync_type LIKE 'ads\_%') >= GREATEST(p_max_running_ads, 1);
  END IF;

  SELECT j.* INTO v_job
  FROM public.channel_sync_jobs j
  JOIN public.shops s ON s.id = j.shop_id
  LEFT JOIN public.channel_shop_sync_controls c ON c.shop_id = j.shop_id
  WHERE j.status IN ('pending', 'retry')
    AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
    AND s.is_active
    AND (p_sync_types IS NULL OR j.sync_type = ANY (p_sync_types))
    AND (p_shop_ids IS NULL OR j.shop_id = ANY (p_shop_ids))
    AND NOT (v_ads_full AND j.sync_type LIKE 'ads\_%')
    AND (j.mode = 'manual' OR c.shop_id IS NULL OR (c.sync_enabled AND (c.paused_until IS NULL OR c.paused_until <= now())))
    AND NOT EXISTS (
      SELECT 1 FROM public.channel_sync_jobs r
      WHERE r.shop_id = j.shop_id AND r.sync_type = j.sync_type AND r.status = 'running'
    )
    AND (p_max_per_shop IS NULL
         OR (SELECT count(*) FROM public.channel_sync_jobs r WHERE r.shop_id = j.shop_id AND r.status = 'running') < GREATEST(p_max_per_shop, 1))
  ORDER BY j.priority ASC, COALESCE(j.next_attempt_at, j.created_at) ASC, j.created_at ASC
  LIMIT 1
  FOR UPDATE OF j SKIP LOCKED;

  IF v_job.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.channel_sync_jobs
  SET status = 'running',
      locked_at = now(),
      lock_owner = p_worker_id,
      started_at = COALESCE(started_at, now()),
      attempt_count = attempt_count + 1,
      next_attempt_at = NULL
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN NEXT v_job;
END;
$$;


-- ============================================================
-- D. per-shop Ads sync settings + scheduler slot bookkeeping
-- ============================================================
CREATE TABLE public.shopee_ads_shop_settings (
  shop_id                     uuid        PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  -- rollout switch: OFF until an admin enables the shop (pilot first)
  ads_sync_enabled            boolean     NOT NULL DEFAULT false,
  -- fixed minute offset inside every 15-minute window (NULL = derived, see docs)
  sync_slot                   smallint    CHECK (sync_slot BETWEEN 0 AND 9),
  enabled_at                  timestamptz,
  last_hot_shop_slot_at       timestamptz,
  last_hot_campaign_slot_at   timestamptz,
  last_warm_slot_at           timestamptz,
  last_cold_slot_at           timestamptz,
  last_metadata_slot_at       timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE TRIGGER set_shopee_ads_shop_settings_updated_at BEFORE UPDATE ON public.shopee_ads_shop_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
ALTER TABLE public.shopee_ads_shop_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shopee_ads_shop_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopee_ads_shop_settings TO service_role;
GRANT SELECT ON public.shopee_ads_shop_settings TO authenticated;
CREATE POLICY active_users_select ON public.shopee_ads_shop_settings FOR SELECT TO authenticated USING (public.is_active_user());


-- ============================================================
-- E. campaign status change time
-- ============================================================
ALTER TABLE public.shopee_ads_campaigns ADD COLUMN status_changed_at timestamptz;

CREATE OR REPLACE FUNCTION public.shopee_ads_campaign_status_changed()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- first sight is not a change (the onboarding backfill covers today for every campaign)
    NULL;
  ELSIF NEW.provider_status IS DISTINCT FROM OLD.provider_status THEN
    NEW.status_changed_at := now();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shopee_ads_campaign_status_changed BEFORE INSERT OR UPDATE ON public.shopee_ads_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.shopee_ads_campaign_status_changed();
CREATE INDEX idx_shopee_ads_campaigns_status_changed ON public.shopee_ads_campaigns (shop_id, status_changed_at);


-- ============================================================
-- F. Ads sync SLA metrics (from the job rows themselves)
-- ============================================================
CREATE FUNCTION public.get_ads_sync_metrics(p_hours integer DEFAULT 24)
RETURNS TABLE (
  shop_id uuid, sync_type text, strategy text, jobs integer, succeeded integer, failed integer, active integer,
  avg_queue_wait_ms integer, p95_queue_wait_ms integer, avg_execution_ms integer, p95_execution_ms integer,
  avg_total_ms integer, p95_total_ms integer, records_written bigint, api_calls bigint, last_finished_at timestamptz)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH j AS (
    SELECT j.shop_id, j.sync_type, COALESCE(j.metadata ->> 'strategy', 'manual') AS strategy, j.status,
           j.records_created + j.records_updated AS written, j.finished_at,
           (SELECT COALESCE(sum((c.value)::text::bigint), 0) FROM jsonb_each(COALESCE(j.metadata -> 'apiCalls', '{}'::jsonb)) c) AS calls,
           extract(epoch FROM j.started_at - GREATEST(j.created_at, COALESCE((j.metadata ->> 'notBefore')::timestamptz, j.created_at))) * 1000 AS wait_ms,
           extract(epoch FROM j.finished_at - j.started_at) * 1000 AS exec_ms,
           extract(epoch FROM j.finished_at - GREATEST(j.created_at, COALESCE((j.metadata ->> 'notBefore')::timestamptz, j.created_at))) * 1000 AS total_ms
    FROM public.channel_sync_jobs j
    WHERE j.sync_type LIKE 'ads\_%'
      AND (j.status IN ('pending', 'running', 'retry') OR j.created_at >= now() - make_interval(hours => p_hours))
  )
  SELECT j.shop_id, j.sync_type, j.strategy,
         count(*)::integer,
         count(*) FILTER (WHERE j.status = 'success')::integer,
         count(*) FILTER (WHERE j.status = 'failed')::integer,
         count(*) FILTER (WHERE j.status IN ('pending', 'running', 'retry'))::integer,
         avg(j.wait_ms)::integer, (percentile_cont(0.95) WITHIN GROUP (ORDER BY j.wait_ms))::integer,
         avg(j.exec_ms)::integer, (percentile_cont(0.95) WITHIN GROUP (ORDER BY j.exec_ms))::integer,
         avg(j.total_ms)::integer, (percentile_cont(0.95) WITHIN GROUP (ORDER BY j.total_ms))::integer,
         sum(j.written)::bigint, sum(j.calls)::bigint, max(j.finished_at)
  FROM j
  GROUP BY j.shop_id, j.sync_type, j.strategy;
$$;

-- ============================================================
-- G. dashboard freshness (one round trip): when TODAY's shop total / campaign
--    facts and the campaign catalogue were last read, per shop. WARM jobs do
--    not count (they never read today). Falls back to the sync state when the
--    job rows were pruned.
-- ============================================================
CREATE FUNCTION public.ads_sync_freshness(p_shop_ids uuid[])
RETURNS TABLE (shop_id uuid, shop_today_at timestamptz, campaign_today_at timestamptz, metadata_at timestamptz, last_read_at timestamptz, active_jobs integer, auto_enabled boolean)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT s.id,
         COALESCE((SELECT max(j.finished_at) FROM public.channel_sync_jobs j
                   WHERE j.shop_id = s.id AND j.sync_type = 'ads_shop_performance_read' AND j.status = 'success' AND j.lane <> 'ads_warm'),
                  (SELECT st.last_success_at FROM public.channel_sync_states st WHERE st.shop_id = s.id AND st.sync_type = 'ads_shop_performance_read')),
         COALESCE((SELECT max(j.finished_at) FROM public.channel_sync_jobs j
                   WHERE j.shop_id = s.id AND j.sync_type = 'ads_campaign_performance_read' AND j.status = 'success' AND j.lane <> 'ads_warm'),
                  (SELECT st.last_success_at FROM public.channel_sync_states st WHERE st.shop_id = s.id AND st.sync_type = 'ads_campaign_performance_read')),
         (SELECT st.last_success_at FROM public.channel_sync_states st WHERE st.shop_id = s.id AND st.sync_type = 'ads_campaign_read'),
         (SELECT max(st.last_success_at) FROM public.channel_sync_states st WHERE st.shop_id = s.id AND st.sync_type LIKE 'ads\_%'),
         (SELECT count(*) FROM public.channel_sync_jobs j WHERE j.shop_id = s.id AND j.sync_type LIKE 'ads\_%' AND j.status IN ('pending', 'running', 'retry'))::integer,
         COALESCE((SELECT x.ads_sync_enabled FROM public.shopee_ads_shop_settings x WHERE x.shop_id = s.id), false)
  FROM unnest(p_shop_ids) AS s(id);
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ads_sync_freshness(uuid[])',
    'enqueue_sync_job(uuid, text, text, integer, timestamptz, timestamptz, jsonb, uuid, integer)',
    'enqueue_ads_sync_job(uuid, text, text, text, integer, jsonb, date, date, timestamptz, uuid, boolean, integer)',
    'claim_next_sync_job(text, integer, text[], uuid[], integer, integer)',
    'get_ads_sync_metrics(integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
