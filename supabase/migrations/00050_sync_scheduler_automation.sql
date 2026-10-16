-- ============================================================
-- PHASE SHOPEE-PERF-2: production auto-sync orchestration.
--
--   channel_sync_heartbeats          scheduler / worker health (UI warns
--                                    when the cron stopped)
--   count_orders_needing_escrow_sync escrow job progress (eligible / remaining)
--   prune_channel_sync_jobs          bounded cleanup of old finished jobs
--   pg_cron + pg_net                 every minute: POST the scheduler endpoint
--
-- The cron job is created here but stays DORMANT until two Vault secrets
-- exist (manual production setup, never committed — see
-- docs/shopee-sync-operations.md §10):
--   shopee_sync_scheduler_url    https://<app>/api/internal/shopee/sync-scheduler
--   shopee_sync_internal_secret  = SHOPEE_SYNC_INTERNAL_SECRET on Vercel
-- Without them public.shopee_sync_cron_tick() returns 'not_configured' and
-- sends nothing.
--
-- Every function is granted EXPLICITLY (cloud has no default EXECUTE grants
-- — 00044).
-- ============================================================

-- ------------------------------------------------------------ health
CREATE TABLE public.channel_sync_heartbeats (
  name            text        PRIMARY KEY,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error_at   timestamptz,
  last_error      text,
  -- Small summary of the last successful run (counts, durations). Never secrets.
  last_result     jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_channel_sync_heartbeats_updated_at BEFORE UPDATE ON public.channel_sync_heartbeats
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.channel_sync_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_sync_heartbeats FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_sync_heartbeats TO service_role;
GRANT SELECT ON public.channel_sync_heartbeats TO authenticated;
CREATE POLICY admins_select ON public.channel_sync_heartbeats FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['admin']));


-- ------------------------------------------------------------ escrow progress
-- Same rule as get_orders_needing_escrow_sync (00049) — counted, not
-- duplicated: the candidate policy lives in ONE function.
CREATE OR REPLACE FUNCTION public.count_orders_needing_escrow_sync(
  p_shop_id            uuid,
  p_now                timestamptz DEFAULT now(),
  p_statuses           text[] DEFAULT ARRAY['COMPLETED'],
  p_refresh_window_days integer DEFAULT 14,
  p_refresh_interval_hours integer DEFAULT 24,
  p_error_backoff_hours integer DEFAULT 6,
  p_calculation_version text DEFAULT NULL
)
RETURNS integer
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT count(*)::integer
  FROM public.get_orders_needing_escrow_sync(
    p_shop_id, 2147483647, p_now, p_statuses,
    p_refresh_window_days, p_refresh_interval_hours, p_error_backoff_hours, p_calculation_version
  )
$$;

REVOKE EXECUTE ON FUNCTION public.count_orders_needing_escrow_sync(uuid, timestamptz, text[], integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_orders_needing_escrow_sync(uuid, timestamptz, text[], integer, integer, integer, text) TO service_role;


-- ------------------------------------------------------------ retention
-- The scheduler enqueues ~400 jobs/day per shop (order every 5 min, escrow
-- every 15, product hourly). Finished success / cancelled jobs older than
-- the retention are deleted in bounded batches; failed jobs stay for
-- investigation. channel_sync_logs (1 summary row per job) is kept — its
-- job_id becomes NULL.
CREATE INDEX idx_channel_sync_jobs_finished_prunable ON public.channel_sync_jobs (finished_at)
  WHERE status IN ('success', 'cancelled');

CREATE OR REPLACE FUNCTION public.prune_channel_sync_jobs(p_older_than_days integer, p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE sql SET search_path = '' AS $$
  WITH doomed AS (
    SELECT id FROM public.channel_sync_jobs
    WHERE status IN ('success', 'cancelled')
      AND finished_at < now() - make_interval(days => GREATEST(p_older_than_days, 1))
    ORDER BY finished_at
    LIMIT GREATEST(p_limit, 0)
  ), removed AS (
    DELETE FROM public.channel_sync_jobs j USING doomed d WHERE j.id = d.id RETURNING 1
  )
  SELECT count(*)::integer FROM removed
$$;

REVOKE EXECUTE ON FUNCTION public.prune_channel_sync_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_channel_sync_jobs(integer, integer) TO service_role;


-- ------------------------------------------------------------ cron
-- Why pg_cron + pg_net and not Vercel Cron: the project is on Vercel Hobby,
-- whose cron runs at most once a day; Supabase pg_cron runs every minute,
-- does not depend on any browser / user traffic, and its run history is
-- queryable (cron.job_run_details).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.shopee_sync_cron_tick()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url    text;
  v_secret text;
  v_id     bigint;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'shopee_sync_scheduler_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'shopee_sync_internal_secret';
  IF v_url IS NULL OR v_secret IS NULL OR length(v_secret) = 0 THEN
    RETURN 'not_configured';
  END IF;
  -- Fire and forget: the endpoint answers after its ~1 s tick and keeps
  -- draining the queue in after(); pg_net stores the response for a few hours.
  SELECT net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    timeout_milliseconds := 10000
  ) INTO v_id;
  RETURN 'requested:' || v_id;
END;
$$;

-- Only the cron (runs as the owner, postgres) may call it.
REVOKE EXECUTE ON FUNCTION public.shopee_sync_cron_tick() FROM PUBLIC, anon, authenticated, service_role;

SELECT cron.schedule('shopee-sync-scheduler', '* * * * *', 'select public.shopee_sync_cron_tick()');
-- pg_cron keeps every run forever; one row per minute adds up.
SELECT cron.schedule('cron-run-history-cleanup', '17 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
