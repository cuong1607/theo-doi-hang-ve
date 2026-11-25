-- ============================================================
-- PHASE 06 — AI Task Detection & Smart Reminder Engine.
--
-- Additive only: no existing table / function / policy is changed except the
-- ai_request_usage feature CHECK (one value added, same as 00077 did). Zalo OA
-- (zalo_*, notification_*) and Web threads (ai_conversations, ai_messages) are
-- untouched; notification_logs / notification_recipients (the OA broadcast
-- module) are not read or written.
--
--   ai_task_scan_state        per-connection cursor over zalo_personal_messages (+ lease)
--   ai_mention_events         mention of a Zalo UID in a group message (metadata only)
--   ai_task_candidates        message that MAY assign work (rules) → extraction queue (+ lease)
--   ai_tasks                  proposed / confirmed task (AI → pending_confirmation only)
--   ai_task_source_messages   provenance: task ↔ message
--   ai_task_assignments       assignee: Zalo UID (from the chat) or internal user (manual)
--   ai_task_recipients        who gets reminders (computed by the server at confirm / edit)
--   ai_task_activity          append-only audit of every task change
--   ai_reminder_preferences   per user: which reminder kinds / channels
--   ai_reminder_schedules     one row per reminder OCCURRENCE (idempotency key, lease, retry)
--   user_notifications        Web Inbox (per user; read / unread; deduped)
--   notification_deliveries   per notification × channel delivery state
--   ai_task_worker_runs       one row per engine tick (health monitoring)
--
-- Isolation: there is no workspace table in this application (single tenant,
-- docs/zalo-ai/decisions.md C1); the CONNECTION (owned by one profile) is the
-- tenant boundary, exactly as in 00073. Every task / mention / candidate row
-- carries connection_id + conversation_id with composite FKs, so it can never
-- point at another connection's conversation. Who may READ a task is decided
-- by the server with the Phase 03 scope (owner / grants) on every request.
--
-- Everything: RLS on, nothing for anon / authenticated, explicit service_role
-- grants (cloud has no default EXECUTE grants). After db push:
-- NOTIFY pgrst, 'reload schema'.
-- ============================================================

-- ------------------------------------------------------------ 0. shared budget label
ALTER TABLE public.ai_request_usage DROP CONSTRAINT IF EXISTS ai_request_usage_feature_check;
ALTER TABLE public.ai_request_usage ADD CONSTRAINT ai_request_usage_feature_check
  CHECK (feature IN ('ask', 'summarize', 'system_plan', 'system_answer', 'task_extract'));

-- the scanner reads messages in (ingested_at, id) order per connection
CREATE INDEX IF NOT EXISTS idx_zalo_personal_messages_scan ON public.zalo_personal_messages (connection_id, ingested_at, id);

-- ------------------------------------------------------------ 1. scan cursor
CREATE TABLE public.ai_task_scan_state (
  connection_id  uuid        PRIMARY KEY REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  -- (cursor_at, cursor_id) = last message (ingested_at, id) already scanned
  cursor_at      timestamptz NOT NULL,
  cursor_id      uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  lease_owner    text        CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9][a-z0-9_.:-]{2,63}$'),
  lease_until    timestamptz,
  scanned_total  bigint      NOT NULL DEFAULT 0 CHECK (scanned_total >= 0),
  last_scan_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER set_ai_task_scan_state_updated_at BEFORE UPDATE ON public.ai_task_scan_state
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ 2. mentions
CREATE TABLE public.ai_mention_events (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id          uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id        uuid        NOT NULL,
  message_id             uuid        NOT NULL REFERENCES public.zalo_personal_messages(id) ON DELETE CASCADE,
  mentioned_external_id  text        NOT NULL CHECK (mentioned_external_id ~ '^[0-9]{1,32}$'),
  -- direct = @user metadata with this UID; all = @All metadata
  mention_kind           text        NOT NULL CHECK (mention_kind IN ('direct', 'all')),
  -- self = the connection's own Zalo account; linked = UID mapped to an internal user; unlinked
  target                 text        NOT NULL CHECK (target IN ('self', 'linked', 'unlinked')),
  internal_user_id       uuid        REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, mentioned_external_id),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE,
  CHECK ((target = 'unlinked') = (internal_user_id IS NULL))
);
CREATE INDEX idx_ai_mention_events_conversation ON public.ai_mention_events (conversation_id, created_at DESC);
CREATE INDEX idx_ai_mention_events_user ON public.ai_mention_events (internal_user_id, created_at DESC) WHERE internal_user_id IS NOT NULL;

-- ------------------------------------------------------------ 3. candidates (extraction queue)
CREATE TABLE public.ai_task_candidates (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id  uuid        NOT NULL,
  -- one candidate per message: a replayed event can never be analysed twice
  message_id       uuid        NOT NULL UNIQUE REFERENCES public.zalo_personal_messages(id) ON DELETE CASCADE,
  message_at       timestamptz NOT NULL,
  score            smallint    NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons          text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(reasons) <= 16 AND array_to_string(reasons, ',') ~ '^[a-z_,]*$'),
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'task_created', 'no_task', 'needs_clarification', 'skipped', 'failed')),
  reason           text        CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
  extractor        text        CHECK (extractor IS NULL OR extractor IN ('gemini', 'rules')),
  usage_id         uuid        REFERENCES public.ai_request_usage(id) ON DELETE SET NULL,
  attempts         smallint    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_owner      text        CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9][a-z0-9_.:-]{2,63}$'),
  lease_until      timestamptz,
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE,
  CHECK ((status = 'processing') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX idx_ai_task_candidates_queue ON public.ai_task_candidates (next_attempt_at, created_at) WHERE status = 'pending';
CREATE INDEX idx_ai_task_candidates_connection ON public.ai_task_candidates (connection_id, created_at DESC);
CREATE TRIGGER set_ai_task_candidates_updated_at BEFORE UPDATE ON public.ai_task_candidates
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ 4. tasks
CREATE TABLE public.ai_tasks (
  id                            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id                 uuid         NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id               uuid         NOT NULL,
  candidate_id                  uuid         REFERENCES public.ai_task_candidates(id) ON DELETE SET NULL,
  -- sha256(conversation | primary message | normalized title): the same extraction stored twice is one task
  dedupe_key                    text         NOT NULL UNIQUE CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  title                         text         NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description                   text         CHECK (description IS NULL OR length(description) <= 2000),
  assignor_external_id          text         CHECK (assignor_external_id IS NULL OR assignor_external_id ~ '^[0-9]{1,32}$'),
  status                        text         NOT NULL DEFAULT 'pending_confirmation'
                                             CHECK (status IN ('pending_confirmation', 'accepted', 'in_progress', 'completed', 'dismissed', 'overdue', 'cancelled')),
  -- UTC instant; the phrase + timezone it was resolved from are kept for audit
  deadline_at                   timestamptz,
  deadline_timezone             text         NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' CHECK (deadline_timezone = 'Asia/Ho_Chi_Minh'),
  deadline_precision            text         NOT NULL DEFAULT 'none' CHECK (deadline_precision IN ('exact', 'day_part', 'date', 'range', 'none')),
  deadline_phrase               text         CHECK (deadline_phrase IS NULL OR length(deadline_phrase) <= 120),
  -- true = the hour / day was ASSUMED by the resolver ("chiều mai" → 17:00): must be confirmed
  deadline_assumed              boolean      NOT NULL DEFAULT false,
  deadline_confirmed            boolean      NOT NULL DEFAULT false,
  -- a later message suggested another deadline: shown to a manager, never applied automatically
  proposed_deadline_at          timestamptz,
  proposed_deadline_phrase      text         CHECK (proposed_deadline_phrase IS NULL OR length(proposed_deadline_phrase) <= 120),
  proposed_deadline_message_id  uuid         REFERENCES public.zalo_personal_messages(id) ON DELETE SET NULL,
  proposed_at                   timestamptz,
  priority                      text         CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high')),
  confidence                    numeric(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  missing_information           text[]       NOT NULL DEFAULT '{}' CHECK (cardinality(missing_information) <= 8 AND array_to_string(missing_information, ',') ~ '^[a-z_,]*$'),
  -- [{ messageId, quote }] — quotes are short excerpts of the source messages (≤ 4 KB total)
  evidence                      jsonb        NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array' AND octet_length(evidence::text) <= 4000),
  extractor                     text         NOT NULL CHECK (extractor IN ('gemini', 'rules', 'manual')),
  progress                      smallint     NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_note                 text         CHECK (progress_note IS NULL OR length(progress_note) <= 500),
  -- version: bumped whenever reminders must be re-planned (old occurrences become stale)
  version                       integer      NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- revision: optimistic concurrency for every change
  revision                      integer      NOT NULL DEFAULT 1 CHECK (revision >= 1),
  confirmed_by                  uuid         REFERENCES public.profiles(id) ON DELETE SET NULL,
  confirmed_at                  timestamptz,
  completed_by                  uuid         REFERENCES public.profiles(id) ON DELETE SET NULL,
  completed_at                  timestamptz,
  closed_reason                 text         CHECK (closed_reason IS NULL OR length(closed_reason) <= 300),
  source_message_at             timestamptz  NOT NULL,
  created_at                    timestamptz  NOT NULL DEFAULT now(),
  updated_at                    timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE,
  -- nothing becomes active without a human confirmation
  CONSTRAINT ai_tasks_confirmed_required CHECK (status IN ('pending_confirmation', 'dismissed') OR confirmed_at IS NOT NULL),
  CONSTRAINT ai_tasks_completed_at CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT ai_tasks_deadline_precision CHECK ((deadline_at IS NULL) = (deadline_precision = 'none'))
);
CREATE INDEX idx_ai_tasks_conversation ON public.ai_tasks (conversation_id, created_at DESC);
CREATE INDEX idx_ai_tasks_connection_status ON public.ai_tasks (connection_id, status);
CREATE INDEX idx_ai_tasks_deadline ON public.ai_tasks (deadline_at) WHERE status IN ('accepted', 'in_progress', 'overdue');
CREATE TRIGGER set_ai_tasks_updated_at BEFORE UPDATE ON public.ai_tasks
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE public.ai_task_source_messages (
  task_id     uuid        NOT NULL REFERENCES public.ai_tasks(id) ON DELETE CASCADE,
  message_id  uuid        NOT NULL REFERENCES public.zalo_personal_messages(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('primary', 'context', 'deadline_update')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, message_id)
);
CREATE INDEX idx_ai_task_source_messages_message ON public.ai_task_source_messages (message_id);

CREATE TABLE public.ai_task_assignments (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid        NOT NULL REFERENCES public.ai_tasks(id) ON DELETE CASCADE,
  -- exactly one: a Zalo UID seen in the chat (resolved to a user only through a
  -- VERIFIED link, at read time) or an internal user picked by a manager
  external_user_id  text        CHECK (external_user_id IS NULL OR external_user_id ~ '^[0-9]{1,32}$'),
  internal_user_id  uuid        REFERENCES public.profiles(id) ON DELETE CASCADE,
  source            text        NOT NULL CHECK (source IN ('mention', 'ai', 'manual')),
  created_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((external_user_id IS NULL) <> (internal_user_id IS NULL))
);
CREATE UNIQUE INDEX uq_ai_task_assignments_external ON public.ai_task_assignments (task_id, external_user_id) WHERE external_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ai_task_assignments_internal ON public.ai_task_assignments (task_id, internal_user_id) WHERE internal_user_id IS NOT NULL;

CREATE TABLE public.ai_task_recipients (
  task_id     uuid        NOT NULL REFERENCES public.ai_tasks(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason      text        NOT NULL CHECK (reason IN ('assignee', 'confirmer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX idx_ai_task_recipients_user ON public.ai_task_recipients (user_id);

CREATE TABLE public.ai_task_activity (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id        uuid        NOT NULL REFERENCES public.ai_tasks(id) ON DELETE CASCADE,
  actor_user_id  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_kind     text        NOT NULL CHECK (actor_kind IN ('user', 'system', 'ai')),
  action         text        NOT NULL CHECK (action ~ '^[a-z_]{3,40}$'),
  from_status    text,
  to_status      text,
  -- small structured facts (changed fields, old / new deadline). Never message text.
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_task_activity_task ON public.ai_task_activity (task_id, created_at DESC);

-- Append-only (same rule as zalo_personal_audit_log): the only UPDATE allowed is
-- the ON DELETE SET NULL of actor_user_id. Rows go away only with their task.
CREATE OR REPLACE FUNCTION public.ai_task_activity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.task_id = OLD.task_id AND NEW.action = OLD.action AND NEW.actor_kind = OLD.actor_kind
     AND NEW.from_status IS NOT DISTINCT FROM OLD.from_status AND NEW.to_status IS NOT DISTINCT FROM OLD.to_status
     AND NEW.details = OLD.details AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ai_task_activity is append-only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER ai_task_activity_no_update BEFORE UPDATE ON public.ai_task_activity
  FOR EACH ROW EXECUTE FUNCTION public.ai_task_activity_guard();

-- ------------------------------------------------------------ 5. notifications (Web Inbox)
CREATE TABLE public.user_notifications (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind             text        NOT NULL CHECK (kind IN ('mention', 'task_confirmation', 'deadline_proposal', 'deadline_day', 'deadline_hour', 'overdue', 'overdue_digest', 'morning_digest')),
  title            text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- never group message text: task titles / counts only (re-checked against the reader's scope when listed)
  body             text        CHECK (body IS NULL OR length(body) <= 2000),
  task_id          uuid        REFERENCES public.ai_tasks(id) ON DELETE SET NULL,
  task_ids         uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(task_ids) <= 50),
  connection_id    uuid        REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id  uuid        REFERENCES public.zalo_personal_conversations(id) ON DELETE SET NULL,
  message_id       uuid        REFERENCES public.zalo_personal_messages(id) ON DELETE SET NULL,
  link             text        CHECK (link IS NULL OR link ~ '^/apps/zalo/personal/[A-Za-z0-9/_?=&.%-]{0,240}$'),
  dedupe_key       text        NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 8 AND 200),
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_notifications_user ON public.user_notifications (user_id, created_at DESC);
CREATE INDEX idx_user_notifications_unread ON public.user_notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE public.notification_deliveries (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id      uuid        NOT NULL REFERENCES public.user_notifications(id) ON DELETE CASCADE,
  channel              text        NOT NULL CHECK (channel IN ('web', 'zalo_personal', 'zalo_oa')),
  -- web = 'delivered' in the same transaction as the inbox row. External channels:
  -- pending → sending → sent | failed | unknown (never retried automatically) | skipped
  status               text        NOT NULL CHECK (status IN ('delivered', 'pending', 'sending', 'sent', 'failed', 'unknown', 'skipped')),
  reason               text        CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
  attempts             smallint    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  provider_message_id  text        CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 128),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel)
);
CREATE TRIGGER set_notification_deliveries_updated_at BEFORE UPDATE ON public.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ 6. reminders
CREATE TABLE public.ai_reminder_preferences (
  user_id                uuid        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  day_enabled            boolean     NOT NULL DEFAULT true,
  hour_enabled           boolean     NOT NULL DEFAULT true,
  overdue_enabled        boolean     NOT NULL DEFAULT true,
  morning_enabled        boolean     NOT NULL DEFAULT true,
  mention_enabled        boolean     NOT NULL DEFAULT true,
  confirmation_enabled   boolean     NOT NULL DEFAULT true,
  -- external channels: stored preference only; nothing is sent while the global flags are off
  zalo_personal_enabled  boolean     NOT NULL DEFAULT false,
  zalo_oa_enabled        boolean     NOT NULL DEFAULT false,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER set_ai_reminder_preferences_updated_at BEFORE UPDATE ON public.ai_reminder_preferences
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE public.ai_reminder_schedules (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text        NOT NULL CHECK (kind IN ('DAY', 'HOUR', 'OVERDUE', 'MORNING')),
  task_id          uuid        REFERENCES public.ai_tasks(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  task_version     integer,
  scheduled_for    timestamptz NOT NULL,
  local_date       date        NOT NULL,             -- VN calendar day of scheduled_for
  -- {kind}:{task|-}:{version|-}:{user}:{scheduled_for} — the same occurrence can never exist twice
  idempotency_key  text        NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 10 AND 200),
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'claimed', 'sent', 'sent_late', 'skipped_expired', 'skipped', 'cancelled', 'failed')),
  outcome_reason   text        CHECK (outcome_reason IS NULL OR outcome_reason ~ '^[a-z_]{1,64}$'),
  attempts         smallint    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  max_attempts     smallint    NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at  timestamptz NOT NULL,
  lease_owner      text        CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9][a-z0-9_.:-]{2,63}$'),
  lease_until      timestamptz,
  last_error_code  text        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  notification_id  uuid        REFERENCES public.user_notifications(id) ON DELETE SET NULL,
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'MORNING') = (task_id IS NULL)),
  CHECK (kind = 'MORNING' OR task_version IS NOT NULL),
  CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX idx_ai_reminder_schedules_due ON public.ai_reminder_schedules (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_ai_reminder_schedules_task ON public.ai_reminder_schedules (task_id, status);
CREATE INDEX idx_ai_reminder_schedules_user ON public.ai_reminder_schedules (user_id, scheduled_for DESC);
CREATE TRIGGER set_ai_reminder_schedules_updated_at BEFORE UPDATE ON public.ai_reminder_schedules
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE public.ai_task_worker_runs (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id       text        NOT NULL CHECK (worker_id ~ '^[a-z0-9][a-z0-9_.:-]{2,63}$'),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'error')),
  -- counters only (scanned, candidates, extracted, reminders …)
  stats           jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object' AND octet_length(stats::text) <= 2000),
  error_category  text        CHECK (error_category IS NULL OR error_category ~ '^[a-z0-9_]{1,64}$')
);
CREATE INDEX idx_ai_task_worker_runs_time ON public.ai_task_worker_runs (started_at DESC);

-- ------------------------------------------------------------ privileges
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_task_scan_state', 'ai_mention_events', 'ai_task_candidates', 'ai_tasks', 'ai_task_source_messages', 'ai_task_assignments',
                           'ai_task_recipients', 'ai_task_activity', 'user_notifications', 'notification_deliveries', 'ai_reminder_preferences',
                           'ai_reminder_schedules', 'ai_task_worker_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END;
$$;
GRANT USAGE, SELECT ON SEQUENCE public.ai_task_activity_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ai_task_worker_runs_id_seq TO service_role;


-- ============================================================
-- Functions (service_role only)
-- ============================================================

-- Internal user behind a Zalo UID of a connection: the connection's own account
-- = its owner; otherwise ONLY a verified, active link (00077 ai_channel_identities).
-- A display name never resolves to anybody.
CREATE OR REPLACE FUNCTION public.ai_task_assignee_user(p_connection_id uuid, p_external_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT c.owner_user_id FROM public.zalo_personal_connections c WHERE c.id = p_connection_id AND c.zalo_account_id = p_external_id),
    (SELECT i.internal_user_id FROM public.ai_channel_identities i
      WHERE i.connection_id = p_connection_id AND i.external_user_id = p_external_id AND i.status = 'active' LIMIT 1));
$$;

-- One inbox row + its web delivery. NULL when the dedupe key exists already or
-- the recipient profile is not active (a locked user is never notified).
CREATE OR REPLACE FUNCTION public.ai_notify_insert(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_user uuid := (p ->> 'userId')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user AND is_active) THEN RETURN NULL; END IF;
  INSERT INTO public.user_notifications (user_id, kind, title, body, task_id, task_ids, connection_id, conversation_id, message_id, link, dedupe_key)
  VALUES (v_user, p ->> 'kind', left(p ->> 'title', 200), left(p ->> 'body', 2000), nullif(p ->> 'taskId', '')::uuid,
          coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p -> 'taskIds', '[]'::jsonb)))::uuid[], '{}'),
          nullif(p ->> 'connectionId', '')::uuid, nullif(p ->> 'conversationId', '')::uuid, nullif(p ->> 'messageId', '')::uuid,
          p ->> 'link', p ->> 'dedupeKey')
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.notification_deliveries (notification_id, channel, status) VALUES (v_id, 'web', 'delivered');
  END IF;
  RETURN v_id;
END;
$$;

-- ------------------------------------------------------------ scanner
-- Claims up to p_limit active connections for scanning (lease). A connection
-- seen for the first time starts at now() − p_backfill_minutes: history is
-- never re-analysed in bulk.
CREATE OR REPLACE FUNCTION public.ai_task_scan_claim(p_worker text, p_lease_seconds integer, p_backfill_minutes integer, p_limit integer)
RETURNS TABLE (connection_id uuid, owner_user_id uuid, zalo_account_id text, direct_message_mode text, cursor_at timestamptz, cursor_id uuid)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9][a-z0-9_.:-]{2,63}$' THEN
    RAISE EXCEPTION 'invalid worker id' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.ai_task_scan_state (connection_id, cursor_at)
  SELECT c.id, now() - make_interval(mins => least(greatest(coalesce(p_backfill_minutes, 0), 0), 10080))
  FROM public.zalo_personal_connections c
  WHERE c.status = 'active' AND c.zalo_account_id IS NOT NULL
  ON CONFLICT (connection_id) DO NOTHING;

  RETURN QUERY
  WITH picked AS (
    SELECT s.connection_id AS cid
    FROM public.ai_task_scan_state s
    JOIN public.zalo_personal_connections c ON c.id = s.connection_id
    WHERE c.status = 'active' AND (s.lease_until IS NULL OR s.lease_until < now())
    ORDER BY s.last_scan_at NULLS FIRST
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 50)
    FOR UPDATE OF s SKIP LOCKED
  ), upd AS (
    UPDATE public.ai_task_scan_state s
    SET lease_owner = p_worker, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900))
    FROM picked WHERE s.connection_id = picked.cid
    RETURNING s.connection_id AS cid, s.cursor_at AS cat, s.cursor_id AS cuid
  )
  SELECT u.cid, c.owner_user_id, c.zalo_account_id, c.direct_message_mode, u.cat, u.cuid
  FROM upd u JOIN public.zalo_personal_connections c ON c.id = u.cid;
END;
$$;

-- Next messages after the cursor (ALL conversations, so the cursor always moves
-- on); `eligible` = may be analysed for tasks (content stored under the CURRENT
-- group / direct policy), `mention_eligible` = group allowed to be processed.
-- p_until keeps a small settle lag behind concurrent ingestion.
CREATE OR REPLACE FUNCTION public.ai_task_scan_messages(p_connection_id uuid, p_after_at timestamptz, p_after_id uuid, p_until timestamptz, p_limit integer)
RETURNS TABLE (id uuid, conversation_id uuid, conversation_type text, external_conversation_id text, group_name text, eligible boolean, mention_eligible boolean,
               sender_external_id text, text_content text, mentions jsonb, mentions_self boolean, is_self boolean, message_at timestamptz, ingested_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.id, m.conversation_id, cv.conversation_type, cv.external_conversation_id, g.display_name,
         (m.content_stored AND m.text_content IS NOT NULL AND m.message_type = 'text' AND (
            (cv.conversation_type = 'group' AND g.mode IN ('monitor', 'mention_only', 'interactive') AND g.consent_status = 'granted')
            OR (cv.conversation_type = 'user' AND c.direct_message_mode = 'content'))),
         (cv.conversation_type = 'group' AND coalesce(g.mode IN ('monitor', 'mention_only', 'interactive') AND g.consent_status = 'granted', false)),
         m.sender_external_id, CASE WHEN m.content_stored THEN m.text_content END, m.mentions, m.mentions_self, m.is_self,
         coalesce(m.sent_at, m.received_at), m.ingested_at
  FROM public.zalo_personal_messages m
  JOIN public.zalo_personal_conversations cv ON cv.id = m.conversation_id AND cv.connection_id = m.connection_id
  JOIN public.zalo_personal_connections c ON c.id = m.connection_id
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
  WHERE m.connection_id = p_connection_id
    AND (m.ingested_at, m.id) > (p_after_at, p_after_id)
    AND m.ingested_at < p_until
  ORDER BY m.ingested_at, m.id
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- Stores one scanned batch atomically: mention events, candidates (daily cap:
-- over it → 'skipped' daily_cap, never analysed), mention notifications, cursor.
-- Everything is ON CONFLICT DO NOTHING: replaying a batch changes nothing.
CREATE OR REPLACE FUNCTION public.ai_task_scan_commit(
  p_connection_id uuid, p_worker text, p_cursor_at timestamptz, p_cursor_id uuid, p_scanned integer,
  p_mentions jsonb, p_candidates jsonb, p_notifications jsonb, p_day_start timestamptz, p_max_candidates_per_day integer, p_release boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_state public.ai_task_scan_state%ROWTYPE;
  v_today integer;
  v_rows integer;
  v_mentions integer := 0;
  v_candidates integer := 0;
  v_capped integer := 0;
  v_notes integer := 0;
  x jsonb;
BEGIN
  SELECT * INTO v_state FROM public.ai_task_scan_state WHERE connection_id = p_connection_id FOR UPDATE;
  IF NOT FOUND OR v_state.lease_owner IS DISTINCT FROM p_worker OR v_state.lease_until < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lease_lost');
  END IF;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_mentions, '[]'::jsonb)) LOOP
    INSERT INTO public.ai_mention_events (connection_id, conversation_id, message_id, mentioned_external_id, mention_kind, target, internal_user_id)
    SELECT m.connection_id, m.conversation_id, m.id, x ->> 'externalId', x ->> 'kind', x ->> 'target', nullif(x ->> 'internalUserId', '')::uuid
    FROM public.zalo_personal_messages m
    WHERE m.id = (x ->> 'messageId')::uuid AND m.connection_id = p_connection_id
    ON CONFLICT (message_id, mentioned_external_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_mentions := v_mentions + v_rows;
  END LOOP;

  SELECT count(*) INTO v_today FROM public.ai_task_candidates
  WHERE connection_id = p_connection_id AND created_at >= p_day_start AND NOT (status = 'skipped' AND reason = 'daily_cap');
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) LOOP
    INSERT INTO public.ai_task_candidates (connection_id, conversation_id, message_id, message_at, score, reasons, status, reason)
    SELECT m.connection_id, m.conversation_id, m.id, coalesce(m.sent_at, m.received_at), least(greatest((x ->> 'score')::integer, 0), 100),
           ARRAY(SELECT jsonb_array_elements_text(coalesce(x -> 'reasons', '[]'::jsonb))),
           CASE WHEN v_today >= p_max_candidates_per_day THEN 'skipped' ELSE 'pending' END,
           CASE WHEN v_today >= p_max_candidates_per_day THEN 'daily_cap' END
    FROM public.zalo_personal_messages m
    WHERE m.id = (x ->> 'messageId')::uuid AND m.connection_id = p_connection_id
    ON CONFLICT (message_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      IF v_today >= p_max_candidates_per_day THEN v_capped := v_capped + 1; ELSE v_candidates := v_candidates + 1; v_today := v_today + 1; END IF;
    END IF;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_notifications, '[]'::jsonb)) LOOP
    IF (x ->> 'connectionId')::uuid IS DISTINCT FROM p_connection_id THEN CONTINUE; END IF;
    IF public.ai_notify_insert(x) IS NOT NULL THEN v_notes := v_notes + 1; END IF;
  END LOOP;

  UPDATE public.ai_task_scan_state
  SET cursor_at = CASE WHEN (p_cursor_at, p_cursor_id) > (cursor_at, cursor_id) THEN p_cursor_at ELSE cursor_at END,
      cursor_id = CASE WHEN (p_cursor_at, p_cursor_id) > (cursor_at, cursor_id) THEN p_cursor_id ELSE cursor_id END,
      scanned_total = scanned_total + greatest(coalesce(p_scanned, 0), 0),
      last_scan_at = now(),
      lease_owner = CASE WHEN p_release THEN NULL ELSE lease_owner END,
      lease_until = CASE WHEN p_release THEN NULL ELSE lease_until END
  WHERE connection_id = p_connection_id;

  RETURN jsonb_build_object('ok', true, 'mentions', v_mentions, 'candidates', v_candidates, 'capped', v_capped, 'notifications', v_notes);
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_task_scan_release(p_connection_id uuid, p_worker text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.ai_task_scan_state SET lease_owner = NULL, lease_until = NULL WHERE connection_id = p_connection_id AND lease_owner = p_worker;
$$;

-- ------------------------------------------------------------ extraction queue
-- Expired leases go back to pending first (a crashed extraction is retried, it
-- had written nothing). Then up to p_limit due candidates are claimed (SKIP
-- LOCKED: two workers never get the same row). Current policy fields come
-- along so the caller re-checks them before anything is sent to a model.
CREATE OR REPLACE FUNCTION public.ai_task_claim_candidates(p_worker text, p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, message_id uuid, message_at timestamptz, score smallint, reasons text[], attempts smallint,
               owner_user_id uuid, zalo_account_id text, connection_status text, direct_message_mode text, conversation_type text, group_name text, group_mode text, consent_status text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  UPDATE public.ai_task_candidates SET status = 'pending', lease_owner = NULL, lease_until = NULL
  WHERE status = 'processing' AND lease_until < now();

  RETURN QUERY
  WITH picked AS (
    SELECT t.id AS tid FROM public.ai_task_candidates t
    WHERE t.status = 'pending' AND t.next_attempt_at <= now()
    ORDER BY t.next_attempt_at, t.created_at
    LIMIT least(greatest(coalesce(p_limit, 5), 1), 25)
    FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.ai_task_candidates t
    SET status = 'processing', lease_owner = p_worker, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900)),
        attempts = least(t.attempts + 1, 20)
    FROM picked WHERE t.id = picked.tid
    RETURNING t.id AS tid, t.connection_id AS cid, t.conversation_id AS cvid, t.message_id AS mid, t.message_at AS mat, t.score AS sc, t.reasons AS rs, t.attempts AS att
  )
  SELECT u.tid, u.cid, u.cvid, u.mid, u.mat, u.sc, u.rs, u.att, c.owner_user_id, c.zalo_account_id, c.status, c.direct_message_mode,
         cv.conversation_type, g.display_name, g.mode, g.consent_status
  FROM upd u
  JOIN public.zalo_personal_connections c ON c.id = u.cid
  JOIN public.zalo_personal_conversations cv ON cv.id = u.cvid AND cv.connection_id = u.cid
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id;
END;
$$;

-- Messages for one extraction: the candidate messages of ONE conversation plus
-- up to p_before stored text messages before the earliest one (context), with
-- mention metadata. Only content the policy stored is ever returned.
CREATE OR REPLACE FUNCTION public.ai_task_context(p_conversation_id uuid, p_message_ids uuid[], p_before integer)
RETURNS TABLE (id uuid, sender_external_id text, is_self boolean, text_content text, mentions jsonb, message_at timestamptz, is_candidate boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH c AS (
    SELECT m.id, coalesce(m.sent_at, m.received_at) AS at FROM public.zalo_personal_messages m
    WHERE m.conversation_id = p_conversation_id AND m.id = ANY (coalesce(p_message_ids, '{}'))
  ), first AS (SELECT at, id FROM c ORDER BY at, id LIMIT 1)
  SELECT x.id, x.sender_external_id, x.is_self, x.text_content, x.mentions, x.message_at, x.is_candidate FROM (
    (SELECT m.id, m.sender_external_id, m.is_self, m.text_content, m.mentions, coalesce(m.sent_at, m.received_at) AS message_at, false AS is_candidate
     FROM public.zalo_personal_messages m, first f
     WHERE m.conversation_id = p_conversation_id AND m.content_stored AND m.text_content IS NOT NULL
       AND NOT (m.id = ANY (coalesce(p_message_ids, '{}')))
       AND (coalesce(m.sent_at, m.received_at), m.id) < (f.at, f.id)
     ORDER BY coalesce(m.sent_at, m.received_at) DESC, m.id DESC
     LIMIT least(greatest(coalesce(p_before, 6), 0), 20))
    UNION ALL
    (SELECT m.id, m.sender_external_id, m.is_self, m.text_content, m.mentions, coalesce(m.sent_at, m.received_at), true
     FROM public.zalo_personal_messages m
     WHERE m.conversation_id = p_conversation_id AND m.content_stored AND m.text_content IS NOT NULL AND m.id = ANY (coalesce(p_message_ids, '{}')))
  ) x
  ORDER BY x.message_at, x.id;
$$;

-- Writes the outcome of one extraction batch atomically. Every task must come
-- from a candidate this worker still holds, and every source message must belong
-- to the task's conversation. Tasks are ALWAYS created pending_confirmation.
--   p_candidates  [{ id, status, reason, extractor, usageId, retryAt }]
--   p_tasks       [{ dedupeKey, candidateId, conversationId, title, description, assignorExternalId, deadlineAt, deadlinePrecision,
--                    deadlinePhrase, deadlineAssumed, priority, confidence, missing[], evidence[], extractor, sourceMessageAt,
--                    sources [{ messageId, role }], assignees [{ externalId, source }], notify [{ userId, title, body }] }]
--   p_proposals   [{ taskId, conversationId, deadlineAt, phrase, messageId, notify [...] }]
CREATE OR REPLACE FUNCTION public.ai_task_store_extraction(p_worker text, p_candidates jsonb, p_tasks jsonb, p_proposals jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  x jsonb;
  y jsonb;
  v_cand public.ai_task_candidates%ROWTYPE;
  v_task uuid;
  v_created jsonb := '[]'::jsonb;
  v_duplicates integer := 0;
  v_invalid integer := 0;
  v_proposals integer := 0;
  v_updated integer := 0;
  v_rows integer;
BEGIN
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) LOOP
    SELECT * INTO v_cand FROM public.ai_task_candidates WHERE id = (x ->> 'candidateId')::uuid;
    IF NOT FOUND OR v_cand.status <> 'processing' OR v_cand.lease_owner IS DISTINCT FROM p_worker
       OR v_cand.conversation_id IS DISTINCT FROM (x ->> 'conversationId')::uuid THEN
      v_invalid := v_invalid + 1; CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(x -> 'sources', '[]'::jsonb)) s
               WHERE NOT EXISTS (SELECT 1 FROM public.zalo_personal_messages m
                                 WHERE m.id = (s ->> 'messageId')::uuid AND m.conversation_id = v_cand.conversation_id AND m.connection_id = v_cand.connection_id)) THEN
      v_invalid := v_invalid + 1; CONTINUE;
    END IF;

    INSERT INTO public.ai_tasks (connection_id, conversation_id, candidate_id, dedupe_key, title, description, assignor_external_id, status,
                                 deadline_at, deadline_precision, deadline_phrase, deadline_assumed, priority, confidence, missing_information,
                                 evidence, extractor, source_message_at)
    VALUES (v_cand.connection_id, v_cand.conversation_id, v_cand.id, x ->> 'dedupeKey', x ->> 'title', nullif(x ->> 'description', ''),
            nullif(x ->> 'assignorExternalId', ''), 'pending_confirmation',
            nullif(x ->> 'deadlineAt', '')::timestamptz, coalesce(x ->> 'deadlinePrecision', 'none'), nullif(x ->> 'deadlinePhrase', ''),
            coalesce((x ->> 'deadlineAssumed')::boolean, false), nullif(x ->> 'priority', ''), (x ->> 'confidence')::numeric,
            ARRAY(SELECT jsonb_array_elements_text(coalesce(x -> 'missing', '[]'::jsonb))), coalesce(x -> 'evidence', '[]'::jsonb),
            x ->> 'extractor', (x ->> 'sourceMessageAt')::timestamptz)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_task;
    IF v_task IS NULL THEN v_duplicates := v_duplicates + 1; CONTINUE; END IF;

    INSERT INTO public.ai_task_source_messages (task_id, message_id, role)
    SELECT v_task, (s ->> 'messageId')::uuid, s ->> 'role' FROM jsonb_array_elements(coalesce(x -> 'sources', '[]'::jsonb)) s
    ON CONFLICT DO NOTHING;
    INSERT INTO public.ai_task_assignments (task_id, external_user_id, source)
    SELECT v_task, a ->> 'externalId', a ->> 'source' FROM jsonb_array_elements(coalesce(x -> 'assignees', '[]'::jsonb)) a
    ON CONFLICT DO NOTHING;
    INSERT INTO public.ai_task_activity (task_id, actor_kind, action, to_status, details)
    VALUES (v_task, CASE WHEN x ->> 'extractor' = 'gemini' THEN 'ai' ELSE 'system' END, 'proposed', 'pending_confirmation',
            jsonb_build_object('extractor', x ->> 'extractor', 'confidence', x -> 'confidence', 'candidate', v_cand.id));
    FOR y IN SELECT value FROM jsonb_array_elements(coalesce(x -> 'notify', '[]'::jsonb)) LOOP
      PERFORM public.ai_notify_insert(jsonb_build_object(
        'userId', y ->> 'userId', 'kind', 'task_confirmation', 'title', y ->> 'title', 'body', y ->> 'body', 'taskId', v_task,
        'connectionId', v_cand.connection_id, 'conversationId', v_cand.conversation_id, 'messageId', v_cand.message_id,
        'link', '/apps/zalo/personal/tasks/' || v_task, 'dedupeKey', 'confirm:' || v_task || ':' || (y ->> 'userId')));
    END LOOP;
    v_created := v_created || jsonb_build_object('dedupeKey', x ->> 'dedupeKey', 'id', v_task);
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_proposals, '[]'::jsonb)) LOOP
    UPDATE public.ai_tasks t
    SET proposed_deadline_at = (x ->> 'deadlineAt')::timestamptz, proposed_deadline_phrase = left(x ->> 'phrase', 120),
        proposed_deadline_message_id = (x ->> 'messageId')::uuid, proposed_at = now(), revision = t.revision + 1
    WHERE t.id = (x ->> 'taskId')::uuid AND t.conversation_id = (x ->> 'conversationId')::uuid
      AND t.status IN ('pending_confirmation', 'accepted', 'in_progress', 'overdue')
      AND EXISTS (SELECT 1 FROM public.zalo_personal_messages m WHERE m.id = (x ->> 'messageId')::uuid AND m.conversation_id = t.conversation_id)
      AND t.deadline_at IS DISTINCT FROM (x ->> 'deadlineAt')::timestamptz;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      v_proposals := v_proposals + 1;
      INSERT INTO public.ai_task_source_messages (task_id, message_id, role) VALUES ((x ->> 'taskId')::uuid, (x ->> 'messageId')::uuid, 'deadline_update') ON CONFLICT DO NOTHING;
      INSERT INTO public.ai_task_activity (task_id, actor_kind, action, details)
      VALUES ((x ->> 'taskId')::uuid, 'ai', 'deadline_proposed', jsonb_build_object('proposed', x ->> 'deadlineAt'));
      FOR y IN SELECT value FROM jsonb_array_elements(coalesce(x -> 'notify', '[]'::jsonb)) LOOP
        PERFORM public.ai_notify_insert(jsonb_build_object(
          'userId', y ->> 'userId', 'kind', 'deadline_proposal', 'title', y ->> 'title', 'body', y ->> 'body', 'taskId', x ->> 'taskId',
          'conversationId', x ->> 'conversationId', 'messageId', x ->> 'messageId', 'connectionId', (SELECT connection_id FROM public.ai_tasks WHERE id = (x ->> 'taskId')::uuid),
          'link', '/apps/zalo/personal/tasks/' || (x ->> 'taskId'), 'dedupeKey', 'proposal:' || (x ->> 'taskId') || ':' || (x ->> 'messageId') || ':' || (y ->> 'userId')));
      END LOOP;
    END IF;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) LOOP
    UPDATE public.ai_task_candidates
    SET status = x ->> 'status', reason = nullif(x ->> 'reason', ''), extractor = nullif(x ->> 'extractor', ''),
        usage_id = coalesce(nullif(x ->> 'usageId', '')::uuid, usage_id),
        processed_at = CASE WHEN x ->> 'status' = 'pending' THEN processed_at ELSE now() END,
        next_attempt_at = coalesce(nullif(x ->> 'retryAt', '')::timestamptz, next_attempt_at),
        lease_owner = NULL, lease_until = NULL
    WHERE id = (x ->> 'id')::uuid AND status = 'processing' AND lease_owner = p_worker;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_updated := v_updated + v_rows;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'duplicates', v_duplicates, 'invalid', v_invalid, 'proposals', v_proposals, 'candidatesUpdated', v_updated);
END;
$$;

-- ------------------------------------------------------------ task changes
-- Every human (or system) change goes through here, in ONE transaction:
-- optimistic concurrency (revision) → whitelisted columns → assignees /
-- recipients (when given) → reminders re-planned (when p_replan: version + 1,
-- pending occurrences cancelled as superseded, new ones inserted) → audit row →
-- notifications. Transition rules themselves live in the server (lifecycle.ts).
CREATE OR REPLACE FUNCTION public.ai_task_apply(
  p_task_id uuid, p_actor uuid, p_expected_revision integer, p_set jsonb, p_action text, p_details jsonb,
  p_assignees jsonb, p_recipients jsonb, p_replan boolean, p_schedules jsonb, p_notifications jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  t public.ai_tasks%ROWTYPE;
  v public.ai_tasks%ROWTYPE;
  s jsonb;
  v_cancelled integer := 0;
  v_planned integer := 0;
  v_rows integer;
BEGIN
  IF p_action IS NULL OR p_action !~ '^[a-z_]{3,40}$' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_request'); END IF;
  SELECT * INTO t FROM public.ai_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF t.revision <> p_expected_revision THEN RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'revision', t.revision); END IF;
  p_set := coalesce(p_set, '{}'::jsonb);

  UPDATE public.ai_tasks SET
    status               = coalesce(p_set ->> 'status', status),
    title                = CASE WHEN p_set ? 'title' THEN p_set ->> 'title' ELSE title END,
    description          = CASE WHEN p_set ? 'description' THEN nullif(p_set ->> 'description', '') ELSE description END,
    deadline_at          = CASE WHEN p_set ? 'deadlineAt' THEN (p_set ->> 'deadlineAt')::timestamptz ELSE deadline_at END,
    deadline_precision   = CASE WHEN p_set ? 'deadlinePrecision' THEN p_set ->> 'deadlinePrecision' ELSE deadline_precision END,
    deadline_phrase      = CASE WHEN p_set ? 'deadlinePhrase' THEN p_set ->> 'deadlinePhrase' ELSE deadline_phrase END,
    deadline_assumed     = CASE WHEN p_set ? 'deadlineAssumed' THEN (p_set ->> 'deadlineAssumed')::boolean ELSE deadline_assumed END,
    deadline_confirmed   = CASE WHEN p_set ? 'deadlineConfirmed' THEN (p_set ->> 'deadlineConfirmed')::boolean ELSE deadline_confirmed END,
    priority             = CASE WHEN p_set ? 'priority' THEN p_set ->> 'priority' ELSE priority END,
    progress             = CASE WHEN p_set ? 'progress' THEN (p_set ->> 'progress')::smallint ELSE progress END,
    progress_note        = CASE WHEN p_set ? 'progressNote' THEN nullif(p_set ->> 'progressNote', '') ELSE progress_note END,
    confirmed_by         = CASE WHEN p_set ? 'confirmedBy' THEN (p_set ->> 'confirmedBy')::uuid ELSE confirmed_by END,
    confirmed_at         = CASE WHEN p_set ? 'confirmedAt' THEN (p_set ->> 'confirmedAt')::timestamptz ELSE confirmed_at END,
    completed_by         = CASE WHEN p_set ? 'completedBy' THEN (p_set ->> 'completedBy')::uuid ELSE completed_by END,
    completed_at         = CASE WHEN p_set ? 'completedAt' THEN (p_set ->> 'completedAt')::timestamptz ELSE completed_at END,
    closed_reason        = CASE WHEN p_set ? 'closedReason' THEN nullif(p_set ->> 'closedReason', '') ELSE closed_reason END,
    proposed_deadline_at = CASE WHEN p_set ? 'clearProposal' THEN NULL ELSE proposed_deadline_at END,
    proposed_deadline_phrase     = CASE WHEN p_set ? 'clearProposal' THEN NULL ELSE proposed_deadline_phrase END,
    proposed_deadline_message_id = CASE WHEN p_set ? 'clearProposal' THEN NULL ELSE proposed_deadline_message_id END,
    proposed_at          = CASE WHEN p_set ? 'clearProposal' THEN NULL ELSE proposed_at END,
    revision             = revision + 1,
    version              = version + CASE WHEN coalesce(p_replan, false) THEN 1 ELSE 0 END
  WHERE id = p_task_id
  RETURNING * INTO v;

  IF p_assignees IS NOT NULL THEN
    DELETE FROM public.ai_task_assignments WHERE task_id = p_task_id;
    INSERT INTO public.ai_task_assignments (task_id, external_user_id, internal_user_id, source, created_by)
    SELECT p_task_id, nullif(a ->> 'externalId', ''), nullif(a ->> 'internalUserId', '')::uuid, a ->> 'source', p_actor
    FROM jsonb_array_elements(p_assignees) a
    ON CONFLICT DO NOTHING;
  END IF;
  IF p_recipients IS NOT NULL THEN
    DELETE FROM public.ai_task_recipients WHERE task_id = p_task_id;
    INSERT INTO public.ai_task_recipients (task_id, user_id, reason)
    SELECT p_task_id, (r ->> 'userId')::uuid, r ->> 'reason' FROM jsonb_array_elements(p_recipients) r
    WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (r ->> 'userId')::uuid AND p.is_active)
    ON CONFLICT DO NOTHING;
  END IF;

  IF coalesce(p_replan, false) THEN
    UPDATE public.ai_reminder_schedules SET status = 'cancelled', outcome_reason = 'superseded', processed_at = now()
    WHERE task_id = p_task_id AND status = 'pending';
    GET DIAGNOSTICS v_cancelled = ROW_COUNT;
    FOR s IN SELECT value FROM jsonb_array_elements(coalesce(p_schedules, '[]'::jsonb)) LOOP
      INSERT INTO public.ai_reminder_schedules (kind, task_id, user_id, task_version, scheduled_for, local_date, idempotency_key, next_attempt_at)
      VALUES (s ->> 'kind', p_task_id, (s ->> 'userId')::uuid, v.version, (s ->> 'scheduledFor')::timestamptz, (s ->> 'localDate')::date,
              (s ->> 'kind') || ':' || p_task_id || ':' || v.version || ':' || (s ->> 'userId') || ':' || to_char((s ->> 'scheduledFor')::timestamptz AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MI'),
              (s ->> 'scheduledFor')::timestamptz)
      ON CONFLICT (idempotency_key) DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_planned := v_planned + v_rows;
    END LOOP;
  END IF;

  INSERT INTO public.ai_task_activity (task_id, actor_user_id, actor_kind, action, from_status, to_status, details)
  VALUES (p_task_id, p_actor, CASE WHEN p_actor IS NULL THEN 'system' ELSE 'user' END, p_action, t.status, v.status,
          coalesce(p_details, '{}'::jsonb) || jsonb_build_object('revision', v.revision, 'version', v.version, 'cancelled', v_cancelled, 'planned', v_planned));

  FOR s IN SELECT value FROM jsonb_array_elements(coalesce(p_notifications, '[]'::jsonb)) LOOP
    PERFORM public.ai_notify_insert(s || jsonb_build_object('taskId', p_task_id, 'connectionId', v.connection_id, 'conversationId', v.conversation_id,
                                                            'link', '/apps/zalo/personal/tasks/' || p_task_id));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'revision', v.revision, 'version', v.version, 'status', v.status, 'cancelled', v_cancelled, 'planned', v_planned);
END;
$$;

-- Tasks inside the reader's scope (arrays exactly as zp_dashboard_conversations).
--   p_view  all | pending | mine | overdue      p_due  today | week | none | NULL
CREATE OR REPLACE FUNCTION public.ai_task_list(
  p_full uuid[], p_group uuid[], p_ids uuid[], p_user uuid, p_view text, p_status text, p_conversation_id uuid, p_assignee uuid,
  p_due text, p_now timestamptz, p_day_end timestamptz, p_week_end timestamptz, p_offset integer, p_limit integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, conversation_type text, external_conversation_id text, group_name text,
               title text, status text, deadline_at timestamptz, deadline_precision text, deadline_assumed boolean, deadline_confirmed boolean,
               priority text, confidence numeric, extractor text, progress smallint, has_proposal boolean, revision integer,
               created_at timestamptz, updated_at timestamptz, mine boolean, total_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH scoped AS (
    SELECT t.*, cv.conversation_type AS cv_type, cv.external_conversation_id AS cv_ext, g.display_name AS g_name,
           (EXISTS (SELECT 1 FROM public.ai_task_recipients r WHERE r.task_id = t.id AND r.user_id = p_user)
            OR EXISTS (SELECT 1 FROM public.ai_task_assignments a WHERE a.task_id = t.id
                       AND (a.internal_user_id = p_user OR public.ai_task_assignee_user(t.connection_id, a.external_user_id) = p_user))) AS is_mine
    FROM public.ai_tasks t
    JOIN public.zalo_personal_conversations cv ON cv.id = t.conversation_id AND cv.connection_id = t.connection_id
    LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
    WHERE (t.connection_id = ANY (coalesce(p_full, '{}'))
           OR (cv.conversation_type = 'group' AND t.connection_id = ANY (coalesce(p_group, '{}')))
           OR cv.id = ANY (coalesce(p_ids, '{}')))
  )
  SELECT s.id, s.connection_id, s.conversation_id, s.cv_type, s.cv_ext, s.g_name, s.title, s.status, s.deadline_at, s.deadline_precision,
         s.deadline_assumed, s.deadline_confirmed, s.priority, s.confidence, s.extractor, s.progress, s.proposed_deadline_at IS NOT NULL, s.revision,
         s.created_at, s.updated_at, s.is_mine, count(*) OVER ()
  FROM scoped s
  WHERE (p_view IS NULL OR p_view = 'all'
         OR (p_view = 'pending' AND s.status = 'pending_confirmation')
         OR (p_view = 'mine' AND s.is_mine AND s.status IN ('accepted', 'in_progress', 'overdue', 'pending_confirmation'))
         OR (p_view = 'overdue' AND (s.status = 'overdue' OR (s.status IN ('accepted', 'in_progress') AND s.deadline_at < p_now))))
    AND (p_status IS NULL OR s.status = p_status)
    AND (p_conversation_id IS NULL OR s.conversation_id = p_conversation_id)
    AND (p_assignee IS NULL OR EXISTS (SELECT 1 FROM public.ai_task_assignments a WHERE a.task_id = s.id
                                       AND (a.internal_user_id = p_assignee OR public.ai_task_assignee_user(s.connection_id, a.external_user_id) = p_assignee)))
    AND (p_due IS NULL
         OR (p_due = 'today' AND s.deadline_at < p_day_end)
         OR (p_due = 'week' AND s.deadline_at < p_week_end)
         OR (p_due = 'none' AND s.deadline_at IS NULL))
  ORDER BY CASE WHEN s.status IN ('completed', 'dismissed', 'cancelled') THEN 1 ELSE 0 END, s.deadline_at NULLS LAST, s.created_at DESC, s.id
  OFFSET greatest(coalesce(p_offset, 0), 0)
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

-- Open tasks a user receives reminders for (morning digest / overdue digest).
CREATE OR REPLACE FUNCTION public.ai_task_open_for_user(p_user uuid, p_limit integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, conversation_type text, title text, status text, deadline_at timestamptz, deadline_precision text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT t.id, t.connection_id, t.conversation_id, cv.conversation_type, t.title, t.status, t.deadline_at, t.deadline_precision
  FROM public.ai_task_recipients r
  JOIN public.ai_tasks t ON t.id = r.task_id
  JOIN public.zalo_personal_conversations cv ON cv.id = t.conversation_id AND cv.connection_id = t.connection_id
  WHERE r.user_id = p_user AND t.status IN ('accepted', 'in_progress', 'overdue')
  ORDER BY t.deadline_at NULLS LAST, t.created_at
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ------------------------------------------------------------ reminder worker
-- 1. recovery: an occurrence claimed by a worker that died (lease expired) goes
--    back to pending — safe, because a web delivery is only ever written in the
--    same transaction as the occurrence's final status (ai_reminder_resolve).
-- 2. claim: due pending occurrences, oldest first, SKIP LOCKED.
CREATE OR REPLACE FUNCTION public.ai_reminder_claim(p_worker text, p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, kind text, task_id uuid, user_id uuid, task_version integer, scheduled_for timestamptz, local_date date, attempts smallint, max_attempts smallint,
               task_status text, task_current_version integer, task_deadline_at timestamptz, task_title text, connection_id uuid, conversation_id uuid,
               conversation_type text, user_active boolean, user_role text, prefs jsonb)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9][a-z0-9_.:-]{2,63}$' THEN
    RAISE EXCEPTION 'invalid worker id' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.ai_reminder_schedules SET status = 'pending', lease_owner = NULL, lease_until = NULL
  WHERE status = 'claimed' AND lease_until < now();

  RETURN QUERY
  WITH picked AS (
    SELECT s.id AS sid FROM public.ai_reminder_schedules s
    WHERE s.status = 'pending' AND s.next_attempt_at <= now()
    ORDER BY s.next_attempt_at, s.scheduled_for
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
    FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.ai_reminder_schedules s
    SET status = 'claimed', lease_owner = p_worker, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900))
    FROM picked WHERE s.id = picked.sid
    RETURNING s.*
  )
  SELECT u.id, u.kind, u.task_id, u.user_id, u.task_version, u.scheduled_for, u.local_date, u.attempts, u.max_attempts,
         t.status, t.version, t.deadline_at, t.title, t.connection_id, t.conversation_id, cv.conversation_type,
         coalesce(p.is_active, false), p.role, to_jsonb(pr) - 'user_id' - 'updated_at'
  FROM upd u
  LEFT JOIN public.ai_tasks t ON t.id = u.task_id
  LEFT JOIN public.zalo_personal_conversations cv ON cv.id = t.conversation_id
  LEFT JOIN public.profiles p ON p.id = u.user_id
  LEFT JOIN public.ai_reminder_preferences pr ON pr.user_id = u.user_id;
END;
$$;

-- Final decision for a set of claimed occurrences, ONE transaction:
--   p_items         [{ id, status, reason }]  status ∈ sent | sent_late | skipped_expired | skipped | cancelled | failed
--   p_notification  inbox row shared by the items marked sent / sent_late (NULL for pure skips)
-- Last-moment guard: an item about to be sent whose task changed meanwhile
-- (version / closed) becomes cancelled superseded and nothing is written to the
-- inbox for it. Only rows this worker still holds are touched (lease).
CREATE OR REPLACE FUNCTION public.ai_reminder_resolve(p_worker text, p_items jsonb, p_notification jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  x jsonb;
  s public.ai_reminder_schedules%ROWTYPE;
  v_task record;
  v_final jsonb := '[]'::jsonb;
  v_status text;
  v_reason text;
  v_send integer := 0;
  v_lost integer := 0;
  v_nid uuid;
  v_created boolean := false;
  v_rows integer;
BEGIN
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    SELECT * INTO s FROM public.ai_reminder_schedules WHERE id = (x ->> 'id')::uuid FOR UPDATE;
    IF NOT FOUND OR s.status <> 'claimed' OR s.lease_owner IS DISTINCT FROM p_worker THEN v_lost := v_lost + 1; CONTINUE; END IF;
    v_status := x ->> 'status';
    v_reason := nullif(x ->> 'reason', '');
    IF v_status NOT IN ('sent', 'sent_late', 'skipped_expired', 'skipped', 'cancelled', 'failed') THEN v_status := 'failed'; v_reason := 'invalid_status'; END IF;
    IF v_status IN ('sent', 'sent_late') AND s.task_id IS NOT NULL THEN
      SELECT status, version INTO v_task FROM public.ai_tasks WHERE id = s.task_id;
      IF NOT FOUND OR v_task.version <> s.task_version OR v_task.status NOT IN ('accepted', 'in_progress', 'overdue') THEN
        v_status := 'cancelled'; v_reason := 'superseded';
      END IF;
    END IF;
    IF v_status IN ('sent', 'sent_late') THEN v_send := v_send + 1; END IF;
    v_final := v_final || jsonb_build_object('id', s.id, 'status', v_status, 'reason', v_reason, 'kind', s.kind, 'taskId', s.task_id);
  END LOOP;

  IF v_send > 0 AND p_notification IS NOT NULL THEN
    v_nid := public.ai_notify_insert(p_notification);
    v_created := v_nid IS NOT NULL;
    IF v_nid IS NULL THEN
      SELECT id INTO v_nid FROM public.user_notifications WHERE dedupe_key = p_notification ->> 'dedupeKey';
    END IF;
  END IF;

  FOR x IN SELECT value FROM jsonb_array_elements(v_final) LOOP
    v_status := x ->> 'status';
    v_reason := x ->> 'reason';
    IF v_status IN ('sent', 'sent_late') AND p_notification IS NOT NULL AND NOT v_created THEN
      -- inbox row existed already (same dedupe key) or the recipient is no longer active
      IF v_nid IS NULL THEN v_status := 'skipped'; v_reason := 'recipient_inactive'; ELSE v_status := 'skipped'; v_reason := 'collapsed'; END IF;
    END IF;
    UPDATE public.ai_reminder_schedules
    SET status = v_status, outcome_reason = v_reason, notification_id = CASE WHEN v_status IN ('sent', 'sent_late') OR v_reason = 'collapsed' THEN v_nid END,
        processed_at = now(), lease_owner = NULL, lease_until = NULL
    WHERE id = (x ->> 'id')::uuid;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'notificationId', v_nid, 'created', v_created, 'items', v_final, 'lost', v_lost);
END;
$$;

-- A delivery attempt failed for a reason known NOT to have delivered anything:
-- back to pending after p_delay_seconds (exponential backoff computed by the
-- caller), or 'failed' (dead letter, needs a human) once max_attempts is reached.
CREATE OR REPLACE FUNCTION public.ai_reminder_retry(p_id uuid, p_worker text, p_error text, p_delay_seconds integer)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  s public.ai_reminder_schedules%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.ai_reminder_schedules WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'claimed' OR s.lease_owner IS DISTINCT FROM p_worker THEN RETURN 'lease_lost'; END IF;
  IF s.attempts + 1 >= s.max_attempts THEN
    UPDATE public.ai_reminder_schedules SET status = 'failed', outcome_reason = 'max_attempts', attempts = s.attempts + 1, last_error_code = left(p_error, 64),
           processed_at = now(), lease_owner = NULL, lease_until = NULL WHERE id = p_id;
    RETURN 'failed';
  END IF;
  UPDATE public.ai_reminder_schedules SET status = 'pending', attempts = s.attempts + 1, last_error_code = left(p_error, 64),
         next_attempt_at = now() + make_interval(secs => least(greatest(coalesce(p_delay_seconds, 60), 1), 86400)), lease_owner = NULL, lease_until = NULL
  WHERE id = p_id;
  RETURN 'retry';
END;
$$;

-- MORNING occurrences for one VN day: every active user who receives reminders
-- for at least one open task and has not turned the digest off. Idempotent.
CREATE OR REPLACE FUNCTION public.ai_reminder_ensure_morning(p_local_date date, p_scheduled_for timestamptz)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO public.ai_reminder_schedules (kind, user_id, scheduled_for, local_date, idempotency_key, next_attempt_at)
  SELECT 'MORNING', u.user_id, p_scheduled_for, p_local_date, 'MORNING:-:-:' || u.user_id || ':' || to_char(p_local_date, 'YYYYMMDD'), p_scheduled_for
  FROM (SELECT DISTINCT r.user_id FROM public.ai_task_recipients r
        JOIN public.ai_tasks t ON t.id = r.task_id AND t.status IN ('accepted', 'in_progress', 'overdue')) u
  JOIN public.profiles p ON p.id = u.user_id AND p.is_active
  LEFT JOIN public.ai_reminder_preferences pr ON pr.user_id = u.user_id
  WHERE coalesce(pr.morning_enabled, true)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- Deadline passed (+ grace) on an accepted / in-progress task → 'overdue' (system
-- transition, audited). Independent of reminders: works for tasks nobody is
-- reminded about too. Progress is kept; completing / cancelling stays possible.
CREATE OR REPLACE FUNCTION public.ai_task_mark_overdue(p_grace_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  WITH moved AS (
    UPDATE public.ai_tasks SET status = 'overdue', revision = revision + 1
    WHERE status IN ('accepted', 'in_progress') AND deadline_at <= now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 300), 0))
    RETURNING id
  ), logged AS (
    INSERT INTO public.ai_task_activity (task_id, actor_kind, action, to_status, details)
    SELECT id, 'system', 'marked_overdue', 'overdue', '{}'::jsonb FROM moved
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM logged;
  RETURN v_rows;
END;
$$;

-- Health: backlog and failures (no content).
CREATE OR REPLACE FUNCTION public.ai_task_health(p_since timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'pendingDue', (SELECT count(*) FROM public.ai_reminder_schedules WHERE status = 'pending' AND next_attempt_at < now() - interval '3 minutes'),
    'claimed', (SELECT count(*) FROM public.ai_reminder_schedules WHERE status = 'claimed'),
    'failed', (SELECT count(*) FROM public.ai_reminder_schedules WHERE status = 'failed' AND updated_at >= p_since),
    'candidatesPending', (SELECT count(*) FROM public.ai_task_candidates WHERE status = 'pending'),
    'candidatesFailed', (SELECT count(*) FROM public.ai_task_candidates WHERE status = 'failed' AND updated_at >= p_since),
    'lastRun', (SELECT to_jsonb(r) FROM (SELECT worker_id, started_at, finished_at, status, stats, error_category FROM public.ai_task_worker_runs ORDER BY started_at DESC LIMIT 1) r),
    'lastOkAt', (SELECT max(finished_at) FROM public.ai_task_worker_runs WHERE status IN ('ok', 'partial')));
$$;

-- ------------------------------------------------------------ scheduler (pg_cron)
-- Same mechanism as 00050 (Vercel Hobby cron is daily only): every minute POST
-- the engine tick. Dormant until the owner stores the URL in Vault
-- ('ai_tasks_tick_url'); the bearer secret is the existing internal secret
-- ('shopee_sync_internal_secret', accepted by isAuthorizedInternalRequest).
-- Nothing depends on a Windows machine being on.
CREATE OR REPLACE FUNCTION public.ai_tasks_cron_tick()
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
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'ai_tasks_tick_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'shopee_sync_internal_secret';
  IF v_url IS NULL OR v_secret IS NULL OR length(v_secret) = 0 THEN
    RETURN 'not_configured';
  END IF;
  SELECT net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    timeout_milliseconds := 30000
  ) INTO v_id;
  RETURN 'requested:' || v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.ai_tasks_cron_tick() FROM PUBLIC, anon, authenticated, service_role;
SELECT cron.schedule('ai-tasks-tick', '* * * * *', 'select public.ai_tasks_cron_tick()');

-- ------------------------------------------------------------ function privileges
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ai_task_assignee_user(uuid, text)',
    'ai_notify_insert(jsonb)',
    'ai_task_scan_claim(text, integer, integer, integer)',
    'ai_task_scan_messages(uuid, timestamptz, uuid, timestamptz, integer)',
    'ai_task_scan_commit(uuid, text, timestamptz, uuid, integer, jsonb, jsonb, jsonb, timestamptz, integer, boolean)',
    'ai_task_scan_release(uuid, text)',
    'ai_task_claim_candidates(text, integer, integer)',
    'ai_task_context(uuid, uuid[], integer)',
    'ai_task_store_extraction(text, jsonb, jsonb, jsonb)',
    'ai_task_apply(uuid, uuid, integer, jsonb, text, jsonb, jsonb, jsonb, boolean, jsonb, jsonb)',
    'ai_task_list(uuid[], uuid[], uuid[], uuid, text, text, uuid, uuid, text, timestamptz, timestamptz, timestamptz, integer, integer)',
    'ai_task_open_for_user(uuid, integer)',
    'ai_reminder_claim(text, integer, integer)',
    'ai_reminder_resolve(text, jsonb, jsonb)',
    'ai_reminder_retry(uuid, text, text, integer)',
    'ai_reminder_ensure_morning(date, timestamptz)',
    'ai_task_mark_overdue(integer)',
    'ai_task_health(timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_task_activity_guard() FROM PUBLIC, anon, authenticated;
