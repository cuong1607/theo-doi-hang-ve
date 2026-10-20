-- ============================================================
-- PHASE SHOPEE-9A: production hardening + multi-shop rollout.
--
-- Evidence (prod, 2026-10-20, 3 live shops): two new shops' first order
-- jobs ran 7+ slices each; after every slice the job went back to pending
-- with its OLD created_at, and the claim (priority, created_at) picked the
-- same two jobs again and again → the pilot shop's order job waited 7+ min,
-- every other type 10+ min (order freshness 13 m, returns 22 m).
--
--   A. claim_next_sync_job v2
--        fairness   same priority → the job that waited longest since it
--                   last became claimable (COALESCE(next_attempt_at,
--                   created_at)): a continued slice goes to the BACK of its
--                   priority line → round-robin across shops
--        per shop   at most p_max_per_shop RUNNING jobs per shop (default 1:
--                   one shop never hits Shopee with order + product +
--                   escrow at once)
--        controls   paused / disabled shops are skipped (manual jobs of a
--                   paused shop still run — an admin asked for them)
--   B. channel_shop_sync_controls: per-shop enable switch + circuit breaker
--      (consecutive job failures → cooldown), operational only
--   C. retention: raw snapshots (history rows only — the latest row of
--      every entity is always kept) and sync logs. Canonical data is never
--      touched.
--   D. health read model: queue health + table growth in one call each
-- ============================================================


-- ============================================================
-- B. per-shop sync controls
-- ============================================================
CREATE TABLE public.channel_shop_sync_controls (
  shop_id               uuid        PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  sync_enabled          boolean     NOT NULL DEFAULT true,
  paused_until          timestamptz,
  pause_reason          text,
  consecutive_failures  integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_failure_at       timestamptz,
  last_failure_code     text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE TRIGGER set_channel_shop_sync_controls_updated_at BEFORE UPDATE ON public.channel_shop_sync_controls
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
ALTER TABLE public.channel_shop_sync_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_shop_sync_controls FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_shop_sync_controls TO service_role;
GRANT SELECT ON public.channel_shop_sync_controls TO authenticated;
CREATE POLICY admins_select ON public.channel_shop_sync_controls FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['admin']));

-- Circuit breaker bookkeeping, called by the worker after a job ends.
--   success → reset; provider failure → +1, ≥ p_threshold → paused for p_cooldown_minutes
CREATE OR REPLACE FUNCTION public.record_shop_sync_outcome(p_shop_id uuid, p_ok boolean, p_error_code text, p_threshold integer, p_cooldown_minutes integer)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r public.channel_shop_sync_controls%ROWTYPE;
BEGIN
  INSERT INTO public.channel_shop_sync_controls (shop_id) VALUES (p_shop_id) ON CONFLICT (shop_id) DO NOTHING;
  IF p_ok THEN
    UPDATE public.channel_shop_sync_controls c
       SET consecutive_failures = 0,
           paused_until = CASE WHEN c.pause_reason = 'circuit_breaker' THEN NULL ELSE c.paused_until END,
           pause_reason = CASE WHEN c.pause_reason = 'circuit_breaker' THEN NULL ELSE c.pause_reason END
     WHERE c.shop_id = p_shop_id AND (c.consecutive_failures <> 0 OR c.pause_reason = 'circuit_breaker')
    RETURNING * INTO r;
  ELSE
    UPDATE public.channel_shop_sync_controls c
       SET consecutive_failures = c.consecutive_failures + 1,
           last_failure_at = now(),
           last_failure_code = left(p_error_code, 100),
           paused_until = CASE WHEN c.consecutive_failures + 1 >= p_threshold THEN now() + make_interval(mins => p_cooldown_minutes) ELSE c.paused_until END,
           pause_reason = CASE WHEN c.consecutive_failures + 1 >= p_threshold THEN 'circuit_breaker' ELSE c.pause_reason END
     WHERE c.shop_id = p_shop_id
    RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('consecutive_failures', r.consecutive_failures, 'paused_until', r.paused_until, 'pause_reason', r.pause_reason);
END;
$$;


-- ============================================================
-- A. claim v2 (drop + create: new argument)
-- ============================================================
DROP FUNCTION public.claim_next_sync_job(text, integer, text[], uuid[]);

CREATE FUNCTION public.claim_next_sync_job(
  p_worker_id    text,
  p_max_running  integer DEFAULT 1,
  p_sync_types   text[] DEFAULT NULL,
  p_shop_ids     uuid[] DEFAULT NULL,
  p_max_per_shop integer DEFAULT 1
)
RETURNS SETOF public.channel_sync_jobs
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_job public.channel_sync_jobs;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RAISE EXCEPTION 'worker id required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('channel_sync_jobs.claim'));

  IF (SELECT count(*) FROM public.channel_sync_jobs WHERE status = 'running') >= GREATEST(p_max_running, 1) THEN
    RETURN;
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
    -- disabled / cooling-down shop: only what an admin explicitly asked for
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

DROP INDEX IF EXISTS public.idx_channel_sync_jobs_claim;
CREATE INDEX idx_channel_sync_jobs_claim ON public.channel_sync_jobs (priority, (COALESCE(next_attempt_at, created_at)))
  WHERE status IN ('pending', 'retry');
CREATE INDEX idx_channel_sync_jobs_running_shop ON public.channel_sync_jobs (shop_id) WHERE status = 'running';


-- ============================================================
-- C. retention (bounded per call; the scheduler calls it every tick)
-- ============================================================
-- Raw snapshots: a row is purgeable only when it is NOT the latest of its
-- (shop, entity_type, entity_external_id, api_name) and older than the
-- retention of its entity type. Financial / return history is kept longer.
CREATE OR REPLACE FUNCTION public.prune_channel_api_snapshots(p_default_days integer, p_financial_days integer, p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  WITH ranked AS (
    SELECT s.id, s.entity_type, s.synced_at,
           row_number() OVER (PARTITION BY s.shop_id, s.entity_type, s.entity_external_id, s.api_name ORDER BY s.synced_at DESC, s.id DESC) AS rn
    FROM public.channel_api_snapshots s
    WHERE s.synced_at < now() - make_interval(days => LEAST(p_default_days, p_financial_days))
  ), victims AS (
    SELECT r.id FROM ranked r
    WHERE r.rn > 1
      AND r.synced_at < now() - make_interval(days => CASE WHEN r.entity_type IN ('escrow', 'income', 'payout', 'return', 'return_logistics') THEN p_financial_days ELSE p_default_days END)
    LIMIT p_limit
  )
  DELETE FROM public.channel_api_snapshots s USING victims v WHERE s.id = v.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Sync logs: success summaries shorter, failed / partial longer; a running log is never touched.
CREATE OR REPLACE FUNCTION public.prune_channel_sync_logs(p_success_days integer, p_failure_days integer, p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  WITH victims AS (
    SELECT l.id FROM public.channel_sync_logs l
    WHERE (l.status IN ('success', 'cancelled') AND l.started_at < now() - make_interval(days => p_success_days))
       OR (l.status IN ('failed', 'partial') AND l.started_at < now() - make_interval(days => p_failure_days))
    LIMIT p_limit
  )
  DELETE FROM public.channel_sync_logs l USING victims v WHERE l.id = v.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_channel_api_snapshots_retention ON public.channel_api_snapshots (synced_at);


-- ============================================================
-- D. health read model
-- ============================================================
-- Per (shop, sync_type) queue figures + global ones, in one round trip.
CREATE OR REPLACE FUNCTION public.get_sync_queue_health(p_stale_seconds integer DEFAULT 180)
RETURNS TABLE (
  shop_id uuid, sync_type text, pending integer, running integer, retrying integer,
  oldest_due_seconds integer, stale_running integer, failed_24h integer, succeeded_24h integer,
  rate_limited_24h integer, last_error_code text, last_error_at timestamptz)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT j.shop_id, j.sync_type,
         count(*) FILTER (WHERE j.status = 'pending')::integer,
         count(*) FILTER (WHERE j.status = 'running')::integer,
         count(*) FILTER (WHERE j.status = 'retry')::integer,
         max(extract(epoch FROM now() - COALESCE(j.next_attempt_at, j.created_at)))
           FILTER (WHERE j.status IN ('pending', 'retry') AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now()))::integer,
         count(*) FILTER (WHERE j.status = 'running' AND (j.locked_at IS NULL OR j.locked_at < now() - make_interval(secs => p_stale_seconds)))::integer,
         count(*) FILTER (WHERE j.status = 'failed' AND j.finished_at >= now() - interval '24 hours')::integer,
         count(*) FILTER (WHERE j.status = 'success' AND j.finished_at >= now() - interval '24 hours')::integer,
         count(*) FILTER (WHERE j.updated_at >= now() - interval '24 hours' AND COALESCE((j.metadata ->> 'rateLimitHits')::integer, 0) > 0)::integer,
         (array_agg(j.error_code ORDER BY j.updated_at DESC) FILTER (WHERE j.error_code IS NOT NULL AND j.updated_at >= now() - interval '24 hours'))[1],
         max(j.updated_at) FILTER (WHERE j.error_code IS NOT NULL AND j.updated_at >= now() - interval '24 hours')
  FROM public.channel_sync_jobs j
  WHERE j.status IN ('pending', 'running', 'retry') OR j.updated_at >= now() - interval '24 hours'
  GROUP BY j.shop_id, j.sync_type;
$$;

-- Provider calls per endpoint in the last p_hours (from the jobs' own meters:
-- metadata.apiCalls + metadata.latencyMs, cumulative per job) — call volume,
-- avg / p95 / max latency, per shop. db_checkpoint = Supabase round trip.
CREATE OR REPLACE FUNCTION public.get_sync_api_stats(p_hours integer DEFAULT 24)
RETURNS TABLE (shop_id uuid, endpoint text, calls bigint, timed_calls bigint, avg_ms integer, p95_ms integer, max_ms integer)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH jobs AS (
    SELECT j.shop_id, j.metadata
    FROM public.channel_sync_jobs j
    WHERE j.updated_at >= now() - make_interval(hours => p_hours) AND j.metadata IS NOT NULL
  ), calls AS (
    SELECT j.shop_id, c.key AS endpoint, sum((c.value)::text::bigint) AS calls
    FROM jobs j, jsonb_each(COALESCE(j.metadata -> 'apiCalls', '{}'::jsonb)) c
    GROUP BY 1, 2
  ), lat AS (
    SELECT j.shop_id, l.key AS endpoint,
           sum((l.value ->> 'n')::bigint) AS n, sum((l.value ->> 'totalMs')::numeric) AS total_ms, max((l.value ->> 'maxMs')::integer) AS max_ms
    FROM jobs j, jsonb_each(COALESCE(j.metadata -> 'latencyMs', '{}'::jsonb)) l
    GROUP BY 1, 2
  ), samples AS (
    SELECT j.shop_id, l.key AS endpoint, percentile_cont(0.95) WITHIN GROUP (ORDER BY s.v::numeric) AS p95
    FROM jobs j, jsonb_each(COALESCE(j.metadata -> 'latencyMs', '{}'::jsonb)) l, jsonb_array_elements_text(COALESCE(l.value -> 'samples', '[]'::jsonb)) s(v)
    GROUP BY 1, 2
  )
  SELECT COALESCE(c.shop_id, l.shop_id), COALESCE(c.endpoint, l.endpoint), COALESCE(c.calls, 0), COALESCE(l.n, 0),
         CASE WHEN COALESCE(l.n, 0) > 0 THEN round(l.total_ms / l.n)::integer END, round(s.p95)::integer, l.max_ms
  FROM calls c
  FULL JOIN lat l ON l.shop_id = c.shop_id AND l.endpoint = c.endpoint
  LEFT JOIN samples s ON s.shop_id = COALESCE(c.shop_id, l.shop_id) AND s.endpoint = COALESCE(c.endpoint, l.endpoint);
$$;

-- Approximate size of the growing tables (planner statistics; no full scans).
CREATE OR REPLACE FUNCTION public.get_channel_table_stats()
RETURNS TABLE (table_name text, approx_rows bigint, total_bytes bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.relname::text, GREATEST(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid)
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN ('channel_api_snapshots', 'channel_sync_logs', 'channel_sync_jobs', 'channel_orders', 'channel_order_items',
                      'order_financial_components', 'order_financials', 'channel_returns', 'channel_return_operations',
                      'channel_return_logistics_events', 'inventory_cost_ledger', 'notification_logs')
  ORDER BY pg_total_relation_size(c.oid) DESC;
$$;


-- ============================================================
-- Privileges (cloud: explicit, always)
-- ============================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'record_shop_sync_outcome(uuid, boolean, text, integer, integer)',
    'claim_next_sync_job(text, integer, text[], uuid[], integer)',
    'prune_channel_api_snapshots(integer, integer, integer)',
    'prune_channel_sync_logs(integer, integer, integer)',
    'get_sync_queue_health(integer)',
    'get_sync_api_stats(integer)',
    'get_channel_table_stats()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
