-- ============================================================
-- PHASE SHOPEE-PERF-1: background sync job queue (multi-shop).
--
-- Shopee API → sync job → database → UI. Pages never call the provider; the
-- "Đồng bộ ngay" button only enqueues a job here.
--
--   channel_sync_jobs   execution / control / checkpoint of one sync job
--   channel_sync_logs   one summary row per job (historical audit) — linked
--                       by job_id, written when the job starts / finishes
--   channel_sync_states incremental checkpoint per (shop, sync_type) —
--                       last_success_at only advances on a clean job
--
-- Uniqueness (v1): at most ONE active (pending/running/retry) job per
-- shop + sync_type + lane, where lane = backfill | live (incremental, manual,
-- repair). So a long backfill never blocks — or is duplicated by — the
-- frequent incremental job of the same shop; the claim below still never
-- RUNS two jobs of the same shop + sync_type at once.
--
-- Priority: LOWER value = picked FIRST (manual 5, incremental 10, repair 50,
-- backfill 100).
--
-- Every function below is SECURITY INVOKER and is granted to service_role
-- EXPLICITLY (cloud Supabase has no default EXECUTE grant — see 00044).
-- ============================================================

CREATE TABLE public.channel_sync_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  sync_type        text        NOT NULL CHECK (sync_type IN ('product', 'order', 'escrow', 'income', 'return', 'payout')),
  mode             text        NOT NULL DEFAULT 'incremental' CHECK (mode IN ('incremental', 'backfill', 'repair', 'manual')),
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'retry', 'success', 'failed', 'cancelled')),
  priority         integer     NOT NULL DEFAULT 100,
  window_from      timestamptz,
  window_to        timestamptz,
  -- Provider pagination checkpoint (order: get_order_list cursor; product: get_item_list offset).
  cursor           text,
  offset_value     integer     CHECK (offset_value IS NULL OR offset_value >= 0),
  batch_size       integer     CHECK (batch_size IS NULL OR batch_size > 0),
  -- Consecutive attempts without progress (reset when a slice makes progress).
  attempt_count    integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts     integer     NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  next_attempt_at  timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  -- Lease: set on claim, refreshed (heartbeat) on every checkpoint.
  locked_at        timestamptz,
  lock_owner       text,
  records_fetched  integer     NOT NULL DEFAULT 0 CHECK (records_fetched >= 0),
  records_created  integer     NOT NULL DEFAULT 0 CHECK (records_created >= 0),
  records_updated  integer     NOT NULL DEFAULT 0 CHECK (records_updated >= 0),
  records_failed   integer     NOT NULL DEFAULT 0 CHECK (records_failed >= 0),
  error_code       text,
  error_message    text,
  -- Runner checkpoint + metrics (apiCalls, pages, detailsFetched,
  -- detailsSkippedUnchanged, rateLimitHits, slices, recoveries, …) and the
  -- bounded repair scope (orderSns / itemIds). Never secrets.
  metadata         jsonb,
  -- Cancellation of a RUNNING job is cooperative: the worker checks this
  -- flag between batches (no hard kill inside a transaction).
  cancel_requested boolean     NOT NULL DEFAULT false,
  cancelled_at     timestamptz,
  cancelled_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (window_to IS NULL OR window_from IS NULL OR window_to >= window_from)
);

CREATE INDEX idx_channel_sync_jobs_status          ON public.channel_sync_jobs (status);
CREATE INDEX idx_channel_sync_jobs_next_attempt_at ON public.channel_sync_jobs (next_attempt_at);
CREATE INDEX idx_channel_sync_jobs_shop_id         ON public.channel_sync_jobs (shop_id);
CREATE INDEX idx_channel_sync_jobs_sync_type       ON public.channel_sync_jobs (sync_type);
CREATE INDEX idx_channel_sync_jobs_created_at      ON public.channel_sync_jobs (created_at);
CREATE INDEX idx_channel_sync_jobs_priority        ON public.channel_sync_jobs (priority);
-- Claim scan: eligible jobs in pick order.
CREATE INDEX idx_channel_sync_jobs_claim ON public.channel_sync_jobs (priority, created_at)
  WHERE status IN ('pending', 'retry');
-- Status screen: latest jobs of a shop + type.
CREATE INDEX idx_channel_sync_jobs_shop_type_created ON public.channel_sync_jobs (shop_id, sync_type, created_at DESC);

-- v1: one active job per shop + sync_type + lane (backfill | live).
CREATE UNIQUE INDEX uq_channel_sync_jobs_active
  ON public.channel_sync_jobs (shop_id, sync_type, (mode = 'backfill'))
  WHERE status IN ('pending', 'running', 'retry');

CREATE TRIGGER set_channel_sync_jobs_updated_at BEFORE UPDATE ON public.channel_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Sync log = one summary per job.
ALTER TABLE public.channel_sync_logs
  ADD COLUMN job_id uuid REFERENCES public.channel_sync_jobs(id) ON DELETE SET NULL;
CREATE INDEX idx_channel_sync_logs_job_id ON public.channel_sync_logs (job_id);
ALTER TABLE public.channel_sync_logs DROP CONSTRAINT channel_sync_logs_status_check;
ALTER TABLE public.channel_sync_logs
  ADD CONSTRAINT channel_sync_logs_status_check CHECK (status IN ('running', 'success', 'partial', 'failed', 'cancelled'));

-- Same exposure as channel_sync_logs: service_role full, active admins read.
ALTER TABLE public.channel_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_sync_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_sync_jobs TO service_role;
GRANT SELECT ON public.channel_sync_jobs TO authenticated;
CREATE POLICY admins_select ON public.channel_sync_jobs FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['admin']));


-- ------------------------------------------------------------
-- enqueue_sync_job: idempotent. Returns the job and whether it was created.
-- An existing active job of the same lane is returned instead of a
-- duplicate (its priority is raised if the new request is more urgent, so a
-- manual click on a queued incremental job moves it to the front).
-- ------------------------------------------------------------
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
BEGIN
  INSERT INTO public.channel_sync_jobs (shop_id, sync_type, mode, priority, window_from, window_to, metadata, created_by, max_attempts)
  VALUES (p_shop_id, p_sync_type, p_mode, p_priority, p_window_from, p_window_to, p_metadata, p_created_by, p_max_attempts)
  ON CONFLICT (shop_id, sync_type, (mode = 'backfill')) WHERE status IN ('pending', 'running', 'retry')
  DO NOTHING
  RETURNING id, channel_sync_jobs.status INTO v_id, v_status;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true, v_status;
    RETURN;
  END IF;

  UPDATE public.channel_sync_jobs j
  SET priority = LEAST(j.priority, p_priority)
  WHERE j.shop_id = p_shop_id AND j.sync_type = p_sync_type
    AND (j.mode = 'backfill') = (p_mode = 'backfill')
    AND j.status IN ('pending', 'running', 'retry')
  RETURNING j.id, j.status INTO v_id, v_status;

  -- Raced with a job finishing between the INSERT and the UPDATE: try once more.
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


-- ------------------------------------------------------------
-- claim_next_sync_job: atomic claim of ONE eligible job.
--
--   eligible = status pending/retry, next_attempt_at NULL or due,
--              shop active, no RUNNING job for the same shop + sync_type
--   order    = priority ASC, created_at ASC
--   global   = at most p_max_running jobs running at once
--
-- All claims serialize on one transaction-scoped advisory lock (a claim is a
-- few index lookups), so "count running" and "same shop + type already
-- running" are evaluated without races; FOR UPDATE SKIP LOCKED additionally
-- keeps the row safe from concurrent cancel/enqueue updates.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_next_sync_job(
  p_worker_id   text,
  p_max_running integer DEFAULT 1,
  p_sync_types  text[] DEFAULT NULL,
  p_shop_ids    uuid[] DEFAULT NULL
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
  WHERE j.status IN ('pending', 'retry')
    AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
    AND s.is_active
    AND (p_sync_types IS NULL OR j.sync_type = ANY (p_sync_types))
    AND (p_shop_ids IS NULL OR j.shop_id = ANY (p_shop_ids))
    AND NOT EXISTS (
      SELECT 1 FROM public.channel_sync_jobs r
      WHERE r.shop_id = j.shop_id AND r.sync_type = j.sync_type AND r.status = 'running'
    )
  ORDER BY j.priority ASC, j.created_at ASC
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


-- ------------------------------------------------------------
-- recover_stale_sync_jobs: a serverless worker can die mid-slice. A RUNNING
-- job whose lease (locked_at, refreshed on every checkpoint) is older than
-- p_stale_seconds goes back to 'retry' (due now) — or to 'failed' once it
-- has used max_attempts. Its checkpoint is kept, so the next claim resumes.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recover_stale_sync_jobs(p_stale_seconds integer)
RETURNS TABLE (job_id uuid, new_status text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH recovered AS (
    UPDATE public.channel_sync_jobs j
    SET status = CASE WHEN j.attempt_count >= j.max_attempts THEN 'failed' ELSE 'retry' END,
        finished_at = CASE WHEN j.attempt_count >= j.max_attempts THEN now() ELSE NULL END,
        error_code = CASE WHEN j.attempt_count >= j.max_attempts THEN 'stale_worker' ELSE j.error_code END,
        error_message = CASE WHEN j.attempt_count >= j.max_attempts
                             THEN 'Worker dừng giữa chừng quá số lần cho phép.' ELSE j.error_message END,
        next_attempt_at = now(),
        lock_owner = NULL,
        locked_at = NULL,
        metadata = COALESCE(j.metadata, '{}'::jsonb) || jsonb_build_object(
          'recoveries', COALESCE((j.metadata ->> 'recoveries')::integer, 0) + 1,
          'lastRecoveredAt', now()
        )
    WHERE j.status = 'running'
      AND (j.locked_at IS NULL OR j.locked_at < now() - make_interval(secs => p_stale_seconds))
    RETURNING j.id, j.status
  ),
  closed_logs AS (
    -- A dead-lettered job's summary log must not stay "running" forever.
    UPDATE public.channel_sync_logs l
    SET status = 'failed', completed_at = now(), error_code = 'stale_worker',
        error_message = 'Worker dừng giữa chừng quá số lần cho phép.'
    FROM recovered r
    WHERE l.job_id = r.id AND r.status = 'failed' AND l.status = 'running'
  )
  SELECT r.id, r.status FROM recovered r;
END;
$$;


-- ------------------------------------------------------------
-- Status screen: the latest job of every (shop, sync_type) in one query.
-- ------------------------------------------------------------
CREATE VIEW public.v_channel_sync_latest_jobs
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (j.shop_id, j.sync_type) j.*
FROM public.channel_sync_jobs j
ORDER BY j.shop_id, j.sync_type, j.created_at DESC;

REVOKE ALL ON public.v_channel_sync_latest_jobs FROM anon;
GRANT SELECT ON public.v_channel_sync_latest_jobs TO authenticated, service_role;


REVOKE EXECUTE ON FUNCTION public.enqueue_sync_job(uuid, text, text, integer, timestamptz, timestamptz, jsonb, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_next_sync_job(text, integer, text[], uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stale_sync_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_sync_job(uuid, text, text, integer, timestamptz, timestamptz, jsonb, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_sync_job(text, integer, text[], uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stale_sync_jobs(integer) TO service_role;


-- ------------------------------------------------------------
-- UI query support (SHOPEE-PERF-1 §35–36): the order list sorts ALL shops by
-- created_at_channel; the existing (shop_id, created_at_channel) index only
-- serves a single-shop filter.
-- ------------------------------------------------------------
CREATE INDEX idx_channel_orders_created_global ON public.channel_orders (created_at_channel DESC NULLS LAST, external_order_sn);

-- v_channel_order_summary: same columns, same results (verified identical on
-- a 20k-order / 50k-line load), but per-order aggregation via LATERAL. The
-- list query "ORDER BY created_at_channel DESC LIMIT 25" now walks the index
-- above and aggregates the lines of those 25 orders only, instead of grouping
-- every order line in the database first (68 ms → 0.3 ms on that load; the
-- old plan grew linearly with history). Counts are taken on channel_orders
-- directly when no line-derived filter is used (order-queries.ts).
CREATE OR REPLACE VIEW public.v_channel_order_summary
WITH (security_invoker = true)
AS
SELECT
  o.id                       AS order_id,
  o.shop_id,
  s.shop_name,
  s.data_source,
  o.external_order_sn,
  o.order_status,
  o.financial_status,
  o.currency,
  o.channel_total_amount::text AS channel_total_amount,
  o.created_at_channel,
  o.updated_at_channel,
  o.last_synced_at,
  COALESCE(i.line_count, 0)  AS line_count,
  COALESCE(i.mapped_lines, 0) AS mapped_lines,
  i.total_item_quantity::text AS total_item_quantity,
  CASE WHEN i.lines_missing_price = 0 THEN i.item_gross_value::text END     AS item_gross_value,
  CASE WHEN i.lines_missing_original = 0 THEN i.original_item_value::text END AS original_item_value,
  CASE
    WHEN COALESCE(i.line_count, 0) = 0 THEN 'no_items'
    WHEN i.mapped_lines = i.line_count THEN 'complete'
    WHEN i.mapped_lines = 0 THEN 'unmapped'
    ELSE 'partial'
  END AS mapping_readiness,
  CASE
    WHEN COALESCE(i.line_count, 0) > 0 AND i.costed_lines = i.line_count THEN 'complete'
    WHEN COALESCE(i.costed_lines, 0) > 0 THEN 'partial'
    ELSE 'incomplete'
  END AS cogs_readiness,
  (o.order_status = 'COMPLETED') AS financial_sync_eligible,
  COALESCE(i.costed_lines, 0) AS costed_lines,
  CASE WHEN COALESCE(i.line_count, 0) > 0 AND i.costed_lines = i.line_count THEN COALESCE(i.cogs_sum, 0)::text END AS total_cogs,
  i.cogs_sum::text AS partial_cogs_sum,
  COALESCE(i.reversed_lines, 0) AS reversed_lines
FROM public.channel_orders o
JOIN public.shops s ON s.id = o.shop_id
CROSS JOIN LATERAL (
  SELECT
    count(*)                                                        AS line_count,
    count(*) FILTER (WHERE oi.internal_product_id IS NOT NULL)      AS mapped_lines,
    count(*) FILTER (WHERE oi.total_cogs IS NOT NULL)               AS costed_lines,
    count(*) FILTER (WHERE oi.discounted_unit_price IS NULL)        AS lines_missing_price,
    count(*) FILTER (WHERE oi.original_unit_price IS NULL)          AS lines_missing_original,
    sum(oi.quantity)                                                AS total_item_quantity,
    sum(oi.discounted_unit_price * oi.quantity)                     AS item_gross_value,
    sum(oi.original_unit_price * oi.quantity)                       AS original_item_value,
    sum(oi.total_cogs) FILTER (WHERE oi.cogs_reversed_at IS NULL)   AS cogs_sum,
    count(*) FILTER (WHERE oi.cogs_reversed_at IS NOT NULL)         AS reversed_lines
  FROM public.channel_order_items oi
  WHERE oi.order_id = o.id
) i;
