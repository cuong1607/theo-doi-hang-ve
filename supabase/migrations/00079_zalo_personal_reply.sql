-- ============================================================
-- PHASE 04.5 — Zalo Personal AI Reply MVP
--
--   inbound router   messages that CALL the bot (1-1, @mention metadata, /bot,
--                    LINK <mã>) → one zalo_personal_reply_inbound row per
--                    message (UNIQUE message_id: a replayed scan changes nothing)
--   drafts           one per inbound row (UNIQUE inbound_id = outbound dedupe);
--                    default pending_approval; auto only for allowlisted
--                    conversations of an 'auto' connection
--   outbound queue   the draft row IS the job. Only the worker of the
--                    connection claims it (HMAC endpoint), one at a time, after
--                    every gate is re-checked HERE (emergency stop, pause,
--                    group mode, identity, approver, block list, rate limits,
--                    expiry). Next.js never sends.
--   delivery         sending → sent | failed | delivery_unknown. A send whose
--                    result is unknown is NEVER retried automatically; an
--                    operator confirms it.
-- Every state change is written to zalo_personal_reply_audit (append-only).
-- Tables: RLS on, no grants to anon / authenticated (service_role only).
-- After `db push`: NOTIFY pgrst, 'reload schema'.
-- ============================================================

-- ------------------------------------------------------------ 0. worker endpoint
ALTER TABLE public.zalo_personal_request_nonces DROP CONSTRAINT IF EXISTS zalo_personal_request_nonces_endpoint_check;
ALTER TABLE public.zalo_personal_request_nonces ADD CONSTRAINT zalo_personal_request_nonces_endpoint_check CHECK (endpoint IN ('events', 'heartbeat', 'outbound'));

-- ------------------------------------------------------------ 1. global emergency stop (singleton)
CREATE TABLE public.zalo_personal_reply_control (
  id              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  emergency_stop  boolean     NOT NULL DEFAULT false,
  changed_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  changed_at      timestamptz,
  reason          text        CHECK (reason IS NULL OR length(reason) <= 300),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.zalo_personal_reply_control (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TRIGGER set_zalo_personal_reply_control_updated_at BEFORE UPDATE ON public.zalo_personal_reply_control
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ 2. per-connection settings
CREATE TABLE public.zalo_personal_reply_settings (
  connection_id                 uuid        PRIMARY KEY REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  -- off = nothing is answered · draft_only = drafts wait for approval · auto = allowlisted conversations may be sent without approval
  reply_mode                    text        NOT NULL DEFAULT 'draft_only' CHECK (reply_mode IN ('off', 'draft_only', 'auto')),
  direct_enabled                boolean     NOT NULL DEFAULT true,
  -- an UNLINKED 1-1 sender may receive the "how to link" guidance (as a draft)
  unlinked_help                 boolean     NOT NULL DEFAULT false,
  cooldown_seconds              integer     NOT NULL DEFAULT 60 CHECK (cooldown_seconds BETWEEN 10 AND 3600),
  per_user_per_hour             integer     NOT NULL DEFAULT 10 CHECK (per_user_per_hour BETWEEN 1 AND 100),
  per_group_per_hour            integer     NOT NULL DEFAULT 20 CHECK (per_group_per_hour BETWEEN 1 AND 200),
  daily_send_limit              integer     NOT NULL DEFAULT 50 CHECK (daily_send_limit BETWEEN 1 AND 500),
  max_per_conversation_per_day  integer     NOT NULL DEFAULT 20 CHECK (max_per_conversation_per_day BETWEEN 1 AND 200),
  draft_ttl_minutes             integer     NOT NULL DEFAULT 60 CHECK (draft_ttl_minutes BETWEEN 5 AND 1440),
  -- set automatically when Zalo refuses a send (or by the owner); only the owner resumes
  send_paused                   boolean     NOT NULL DEFAULT false,
  paused_reason                 text        CHECK (paused_reason IS NULL OR paused_reason ~ '^[a-z0-9_]{1,64}$'),
  paused_at                     timestamptz,
  updated_by                    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (send_paused = (paused_at IS NOT NULL))
);
CREATE TRIGGER set_zalo_personal_reply_settings_updated_at BEFORE UPDATE ON public.zalo_personal_reply_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ 3. auto-reply allowlist (test conversations)
CREATE TABLE public.zalo_personal_reply_allowlist (
  conversation_id  uuid        PRIMARY KEY,
  connection_id    uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  enabled_by       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  -- why / whose consent (required)
  note             text        NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------ 4. blocked senders (incl. other bots)
CREATE TABLE public.zalo_personal_reply_blocks (
  connection_id     uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  external_user_id  text        NOT NULL CHECK (external_user_id ~ '^[0-9]{1,32}$'),
  blocked_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  note              text        CHECK (note IS NULL OR length(note) <= 300),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_user_id)
);

-- ------------------------------------------------------------ 5. scan cursor
CREATE TABLE public.zalo_personal_reply_scan_state (
  connection_id  uuid        PRIMARY KEY REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  cursor_at      timestamptz NOT NULL,
  cursor_id      uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  lease_owner    text        CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9][a-z0-9_.:-]{2,63}$'),
  lease_until    timestamptz,
  scanned_total  bigint      NOT NULL DEFAULT 0 CHECK (scanned_total >= 0),
  last_scan_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER set_zalo_personal_reply_scan_state_updated_at BEFORE UPDATE ON public.zalo_personal_reply_scan_state
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ 6. inbound router decisions
CREATE TABLE public.zalo_personal_reply_inbound (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id     uuid        NOT NULL,
  message_id          uuid        NOT NULL UNIQUE REFERENCES public.zalo_personal_messages(id) ON DELETE CASCADE,
  sender_external_id  text        NOT NULL CHECK (sender_external_id ~ '^[0-9]{1,32}$'),
  trigger             text        NOT NULL CHECK (trigger IN ('direct', 'mention', 'command', 'link')),
  status              text        NOT NULL CHECK (status IN ('queued', 'processing', 'done', 'skipped', 'failed')),
  reason              text        CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  lease_owner         text        CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9][a-z0-9_.:-]{2,63}$'),
  lease_until         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE
);
CREATE INDEX idx_zp_reply_inbound_queue ON public.zalo_personal_reply_inbound (status, created_at) WHERE status IN ('queued', 'processing');
CREATE INDEX idx_zp_reply_inbound_sender ON public.zalo_personal_reply_inbound (connection_id, sender_external_id, created_at DESC);
CREATE INDEX idx_zp_reply_inbound_conversation ON public.zalo_personal_reply_inbound (conversation_id, created_at DESC);

-- ------------------------------------------------------------ 7. drafts = outbound jobs
CREATE TABLE public.zalo_personal_reply_drafts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id         uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id       uuid        NOT NULL,
  conversation_type     text        NOT NULL CHECK (conversation_type IN ('user', 'group')),
  -- one reply per inbound event (outbound dedupe)
  inbound_id            uuid        NOT NULL UNIQUE REFERENCES public.zalo_personal_reply_inbound(id) ON DELETE CASCADE,
  source_message_id     uuid        NOT NULL REFERENCES public.zalo_personal_messages(id) ON DELETE CASCADE,
  asker_external_id     text        NOT NULL CHECK (asker_external_id ~ '^[0-9]{1,32}$'),
  -- the linked internal user the answer was computed for (NULL = unlinked guidance)
  asker_user_id         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  audience              text        NOT NULL CHECK (audience IN ('private', 'group')),
  kind                  text        NOT NULL CHECK (kind IN ('ai_answer', 'link_help', 'link_result', 'notice')),
  pipeline              text        NOT NULL CHECK (pipeline IN ('system', 'memory', 'none')),
  -- what the approver must ALSO be allowed to see (permissions of the tools used)
  required_permissions  text[]      NOT NULL DEFAULT '{}',
  status                text        NOT NULL CHECK (status IN ('pending_approval', 'queued', 'sending', 'sent', 'failed', 'delivery_unknown', 'rejected', 'cancelled', 'expired')),
  approval              text        CHECK (approval IS NULL OR approval IN ('manual', 'auto')),
  approved_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at           timestamptz,
  original_text         text        NOT NULL CHECK (length(original_text) BETWEEN 1 AND 1800),
  text                  text        NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 1800),
  edited                boolean     NOT NULL DEFAULT false,
  version               integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  citations             jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array' AND jsonb_array_length(citations) <= 30),
  caveats               jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(caveats) = 'array' AND jsonb_array_length(caveats) <= 10),
  response_status       text        CHECK (response_status IS NULL OR response_status ~ '^[a-z_]{1,32}$'),
  model                 text        CHECK (model IS NULL OR length(model) <= 80),
  expires_at            timestamptz NOT NULL,
  -- outbound
  lease_worker_id       uuid        REFERENCES public.zalo_personal_workers(id) ON DELETE SET NULL,
  claim_token           uuid,
  lease_until           timestamptz,
  attempts              integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  sending_started_at    timestamptz,
  zalo_msg_id           text        CHECK (zalo_msg_id IS NULL OR zalo_msg_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  sent_at               timestamptz,
  error_category        text        CHECK (error_category IS NULL OR error_category ~ '^[a-z0-9_]{1,64}$'),
  hold_reason           text        CHECK (hold_reason IS NULL OR hold_reason ~ '^[a-z0-9_]{1,64}$'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE,
  CHECK (audience = CASE WHEN conversation_type = 'group' THEN 'group' ELSE 'private' END),
  CHECK (status <> 'sending' OR (claim_token IS NOT NULL AND lease_until IS NOT NULL AND sending_started_at IS NOT NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CHECK ((approval IS NULL) = (approved_at IS NULL)),
  CHECK (approval IS DISTINCT FROM 'manual' OR approved_by IS NOT NULL),
  CHECK (status NOT IN ('queued', 'sending', 'sent') OR approval IS NOT NULL)
);
CREATE INDEX idx_zp_reply_drafts_queue ON public.zalo_personal_reply_drafts (connection_id, status, created_at);
CREATE INDEX idx_zp_reply_drafts_conversation ON public.zalo_personal_reply_drafts (conversation_id, coalesce(sent_at, sending_started_at));
CREATE INDEX idx_zp_reply_drafts_asker ON public.zalo_personal_reply_drafts (connection_id, asker_external_id, coalesce(sent_at, sending_started_at));
CREATE INDEX idx_zp_reply_drafts_sent ON public.zalo_personal_reply_drafts (coalesce(sent_at, sending_started_at)) WHERE status IN ('sending', 'sent', 'delivery_unknown');
CREATE TRIGGER set_zalo_personal_reply_drafts_updated_at BEFORE UPDATE ON public.zalo_personal_reply_drafts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ 8. audit (append-only)
CREATE TABLE public.zalo_personal_reply_audit (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id  uuid        REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  draft_id       uuid        REFERENCES public.zalo_personal_reply_drafts(id) ON DELETE CASCADE,
  actor_user_id  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_kind     text        NOT NULL CHECK (actor_kind IN ('user', 'system', 'worker')),
  action         text        NOT NULL CHECK (action ~ '^[a-z_.]{2,48}$'),
  from_status    text,
  to_status      text,
  -- small structured facts only: never message text, never secrets
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 1000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_zp_reply_audit_draft ON public.zalo_personal_reply_audit (draft_id, id);
CREATE INDEX idx_zp_reply_audit_connection ON public.zalo_personal_reply_audit (connection_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.zp_reply_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- only the ON DELETE SET NULL of actor_user_id may touch a row
  IF TG_OP = 'UPDATE' AND NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.action = OLD.action AND NEW.details = OLD.details AND NEW.created_at = OLD.created_at
     AND NEW.draft_id IS NOT DISTINCT FROM OLD.draft_id AND NEW.from_status IS NOT DISTINCT FROM OLD.from_status AND NEW.to_status IS NOT DISTINCT FROM OLD.to_status THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'zalo_personal_reply_audit is append-only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER zp_reply_audit_no_update BEFORE UPDATE ON public.zalo_personal_reply_audit
  FOR EACH ROW EXECUTE FUNCTION public.zp_reply_audit_guard();

-- ------------------------------------------------------------ privileges
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_personal_reply_control', 'zalo_personal_reply_settings', 'zalo_personal_reply_allowlist', 'zalo_personal_reply_blocks',
                           'zalo_personal_reply_scan_state', 'zalo_personal_reply_inbound', 'zalo_personal_reply_drafts', 'zalo_personal_reply_audit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END;
$$;
GRANT USAGE, SELECT ON SEQUENCE public.zalo_personal_reply_audit_id_seq TO service_role;


-- ============================================================
-- Functions (service_role only)
-- ============================================================

CREATE OR REPLACE FUNCTION public.zp_reply_vn_day_start()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
$$;

CREATE OR REPLACE FUNCTION public.zp_reply_log(p_connection uuid, p_draft uuid, p_actor uuid, p_kind text, p_action text, p_from text, p_to text, p_details jsonb)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  INSERT INTO public.zalo_personal_reply_audit (connection_id, draft_id, actor_user_id, actor_kind, action, from_status, to_status, details)
  VALUES (p_connection, p_draft, p_actor, p_kind, p_action, p_from, p_to, coalesce(p_details, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------- scan
-- Claims connections to scan. A new cursor starts at now() − backfill
-- (default 0): enabling replies never answers old messages.
CREATE OR REPLACE FUNCTION public.zp_reply_scan_claim(p_worker text, p_lease_seconds integer, p_backfill_minutes integer, p_limit integer)
RETURNS TABLE (connection_id uuid, zalo_account_id text, direct_message_mode text, cursor_at timestamptz, cursor_id uuid)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9][a-z0-9_.:-]{2,63}$' THEN
    RAISE EXCEPTION 'invalid worker id' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.zalo_personal_reply_settings (connection_id)
  SELECT c.id FROM public.zalo_personal_connections c
  ON CONFLICT (connection_id) DO NOTHING;
  INSERT INTO public.zalo_personal_reply_scan_state (connection_id, cursor_at)
  SELECT c.id, now() - make_interval(mins => least(greatest(coalesce(p_backfill_minutes, 0), 0), 1440))
  FROM public.zalo_personal_connections c
  WHERE c.status = 'active' AND c.zalo_account_id IS NOT NULL
  ON CONFLICT (connection_id) DO NOTHING;

  RETURN QUERY
  WITH picked AS (
    SELECT s.connection_id AS cid
    FROM public.zalo_personal_reply_scan_state s
    JOIN public.zalo_personal_connections c ON c.id = s.connection_id
    JOIN public.zalo_personal_reply_settings st ON st.connection_id = s.connection_id
    WHERE c.status = 'active' AND c.zalo_account_id IS NOT NULL AND st.reply_mode <> 'off'
      AND (s.lease_until IS NULL OR s.lease_until < now())
    ORDER BY s.last_scan_at NULLS FIRST
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 50)
    FOR UPDATE OF s SKIP LOCKED
  ), upd AS (
    UPDATE public.zalo_personal_reply_scan_state s
    SET lease_owner = p_worker, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900))
    FROM picked WHERE s.connection_id = picked.cid
    RETURNING s.connection_id AS cid, s.cursor_at AS cat, s.cursor_id AS cuid
  )
  SELECT u.cid, c.zalo_account_id, c.direct_message_mode, u.cat, u.cuid
  FROM upd u JOIN public.zalo_personal_connections c ON c.id = u.cid;
END;
$$;

-- Messages after the cursor (everything: the cursor must pass non-triggering rows too).
CREATE OR REPLACE FUNCTION public.zp_reply_scan_messages(p_connection_id uuid, p_after_at timestamptz, p_after_id uuid, p_until timestamptz, p_limit integer)
RETURNS TABLE (id uuid, conversation_id uuid, conversation_type text, external_conversation_id text, group_mode text, group_consent text,
               message_type text, content_stored boolean, text_content text, mentions jsonb, mentions_self boolean, is_self boolean,
               sender_external_id text, message_at timestamptz, ingested_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.id, m.conversation_id, cv.conversation_type, cv.external_conversation_id, g.mode, g.consent_status,
         m.message_type, m.content_stored, CASE WHEN m.content_stored THEN m.text_content END, m.mentions, m.mentions_self, m.is_self,
         m.sender_external_id, coalesce(m.sent_at, m.received_at), m.ingested_at
  FROM public.zalo_personal_messages m
  JOIN public.zalo_personal_conversations cv ON cv.id = m.conversation_id AND cv.connection_id = m.connection_id
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
  WHERE m.connection_id = p_connection_id
    AND (m.ingested_at, m.id) > (p_after_at, p_after_id)
    AND m.ingested_at < p_until
  ORDER BY m.ingested_at, m.id
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- Stores the router decisions of one batch + moves the cursor, atomically.
-- p_inbound: [{ messageId, trigger, decision: process|skip, reason }].
-- 'process' rows still pass the per-sender hourly and per-conversation daily
-- caps here (shared by every server instance); over a cap → skipped.
CREATE OR REPLACE FUNCTION public.zp_reply_scan_commit(p_connection_id uuid, p_worker text, p_cursor_at timestamptz, p_cursor_id uuid, p_scanned integer, p_inbound jsonb, p_release boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_state public.zalo_personal_reply_scan_state%ROWTYPE;
  st public.zalo_personal_reply_settings%ROWTYPE;
  x jsonb;
  m record;
  v_status text;
  v_reason text;
  v_rows integer;
  v_queued integer := 0;
  v_skipped integer := 0;
BEGIN
  SELECT * INTO v_state FROM public.zalo_personal_reply_scan_state WHERE connection_id = p_connection_id FOR UPDATE;
  IF NOT FOUND OR v_state.lease_owner IS DISTINCT FROM p_worker OR v_state.lease_until < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lease_lost');
  END IF;
  SELECT * INTO st FROM public.zalo_personal_reply_settings WHERE connection_id = p_connection_id;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_inbound, '[]'::jsonb)) LOOP
    SELECT msg.id, msg.connection_id, msg.conversation_id, msg.sender_external_id INTO m
    FROM public.zalo_personal_messages msg WHERE msg.id = (x ->> 'messageId')::uuid AND msg.connection_id = p_connection_id;
    CONTINUE WHEN NOT FOUND;
    v_status := CASE WHEN x ->> 'decision' = 'process' THEN 'queued' ELSE 'skipped' END;
    v_reason := nullif(x ->> 'reason', '');
    IF v_status = 'queued' THEN
      IF (SELECT count(*) FROM public.zalo_personal_reply_inbound i
          WHERE i.connection_id = p_connection_id AND i.sender_external_id = m.sender_external_id
            AND i.created_at > now() - interval '1 hour' AND i.status <> 'skipped') >= st.per_user_per_hour THEN
        v_status := 'skipped'; v_reason := 'user_rate_limited';
      ELSIF (SELECT count(*) FROM public.zalo_personal_reply_inbound i
             WHERE i.conversation_id = m.conversation_id AND i.created_at >= public.zp_reply_vn_day_start() AND i.status <> 'skipped') >= st.max_per_conversation_per_day THEN
        v_status := 'skipped'; v_reason := 'conversation_daily_cap';
      END IF;
    END IF;
    INSERT INTO public.zalo_personal_reply_inbound (connection_id, conversation_id, message_id, sender_external_id, trigger, status, reason, processed_at)
    VALUES (p_connection_id, m.conversation_id, m.id, m.sender_external_id, x ->> 'trigger', v_status, v_reason, CASE WHEN v_status = 'skipped' THEN now() END)
    ON CONFLICT (message_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      IF v_status = 'queued' THEN v_queued := v_queued + 1; ELSE v_skipped := v_skipped + 1; END IF;
    END IF;
  END LOOP;

  UPDATE public.zalo_personal_reply_scan_state
  SET cursor_at = greatest(cursor_at, coalesce(p_cursor_at, cursor_at)),
      cursor_id = CASE WHEN p_cursor_at IS NOT NULL AND (p_cursor_at, p_cursor_id) > (cursor_at, cursor_id) THEN p_cursor_id ELSE cursor_id END,
      scanned_total = scanned_total + greatest(coalesce(p_scanned, 0), 0),
      last_scan_at = now(),
      lease_owner = CASE WHEN p_release THEN NULL ELSE lease_owner END,
      lease_until = CASE WHEN p_release THEN NULL ELSE lease_until END
  WHERE connection_id = p_connection_id;
  RETURN jsonb_build_object('ok', true, 'queued', v_queued, 'skipped', v_skipped);
END;
$$;

CREATE OR REPLACE FUNCTION public.zp_reply_scan_release(p_connection_id uuid, p_worker text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.zalo_personal_reply_scan_state SET lease_owner = NULL, lease_until = NULL
  WHERE connection_id = p_connection_id AND lease_owner = p_worker;
$$;

-- ---------------------------------------------------------------- inbound processing
-- Claims queued inbound rows (and stale leases). A question older than the
-- connection's draft TTL is skipped (an answer would be outdated); after 3
-- attempts a row fails for good.
CREATE OR REPLACE FUNCTION public.zp_reply_claim_inbound(p_worker text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, message_id uuid, trigger text, sender_external_id text, attempts integer)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9][a-z0-9_.:-]{2,63}$' THEN
    RAISE EXCEPTION 'invalid worker id' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.zalo_personal_reply_inbound i
  SET status = 'skipped', reason = 'stale', processed_at = now(), lease_owner = NULL, lease_until = NULL
  FROM public.zalo_personal_reply_settings st
  WHERE st.connection_id = i.connection_id AND i.status IN ('queued', 'processing') AND (i.lease_until IS NULL OR i.lease_until < now())
    AND i.created_at < now() - make_interval(mins => st.draft_ttl_minutes);
  UPDATE public.zalo_personal_reply_inbound i
  SET status = 'failed', reason = coalesce(i.reason, 'max_attempts'), processed_at = now(), lease_owner = NULL, lease_until = NULL
  WHERE i.status = 'processing' AND i.lease_until < now() AND i.attempts >= 3;

  RETURN QUERY
  WITH picked AS (
    SELECT i.id AS iid
    FROM public.zalo_personal_reply_inbound i
    WHERE (i.status = 'queued' OR (i.status = 'processing' AND i.lease_until < now())) AND i.attempts < 3
    ORDER BY i.created_at
    LIMIT least(greatest(coalesce(p_limit, 5), 1), 20)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.zalo_personal_reply_inbound i
  SET status = 'processing', attempts = i.attempts + 1, lease_owner = p_worker,
      lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900))
  FROM picked WHERE i.id = picked.iid
  RETURNING i.id, i.connection_id, i.conversation_id, i.message_id, i.trigger, i.sender_external_id, i.attempts;
END;
$$;

-- Context the pipeline needs for one claimed inbound row (re-read, never trusted from the scan).
CREATE OR REPLACE FUNCTION public.zp_reply_inbound_context(p_inbound_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'inboundId', i.id, 'connectionId', i.connection_id, 'conversationId', i.conversation_id, 'messageId', i.message_id,
    'trigger', i.trigger, 'senderExternalId', i.sender_external_id,
    'conversationType', cv.conversation_type, 'externalConversationId', cv.external_conversation_id,
    'groupMode', g.mode, 'groupConsent', g.consent_status, 'groupSendVerified', g.send_verified_at IS NOT NULL,
    'text', CASE WHEN m.content_stored THEN m.text_content END, 'mentions', m.mentions, 'messageAt', coalesce(m.sent_at, m.received_at),
    'connectionStatus', c.status, 'zaloAccountId', c.zalo_account_id, 'ownerUserId', c.owner_user_id,
    'settings', to_jsonb(st) - 'connection_id' - 'updated_by' - 'created_at' - 'updated_at',
    'allowlisted', EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a WHERE a.conversation_id = i.conversation_id),
    'directVerified', EXISTS (SELECT 1 FROM public.zalo_personal_reply_drafts x WHERE x.conversation_id = i.conversation_id AND x.approval = 'manual' AND x.status = 'sent'),
    'blocked', EXISTS (SELECT 1 FROM public.zalo_personal_reply_blocks b WHERE b.connection_id = i.connection_id AND b.external_user_id = i.sender_external_id),
    'emergencyStop', (SELECT ctl.emergency_stop FROM public.zalo_personal_reply_control ctl WHERE ctl.id = 1))
  FROM public.zalo_personal_reply_inbound i
  JOIN public.zalo_personal_messages m ON m.id = i.message_id
  JOIN public.zalo_personal_conversations cv ON cv.id = i.conversation_id
  JOIN public.zalo_personal_connections c ON c.id = i.connection_id
  LEFT JOIN public.zalo_personal_reply_settings st ON st.connection_id = i.connection_id
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id
  WHERE i.id = p_inbound_id;
$$;

-- Result of the pipeline for one inbound row (lease-checked):
--   { skip: reason }                         → inbound skipped
--   { draft: { kind, pipeline, text, … } }   → draft created (idempotent: UNIQUE inbound_id)
-- autoApprove is honoured ONLY if the connection is in 'auto' mode, the
-- conversation is allowlisted, the sender is linked, and (group) the group is
-- interactive — re-checked here, not trusted from the caller.
CREATE OR REPLACE FUNCTION public.zp_reply_store_result(p_inbound_id uuid, p_worker text, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  i public.zalo_personal_reply_inbound%ROWTYPE;
  st public.zalo_personal_reply_settings%ROWTYPE;
  cv record;
  d jsonb := p_result -> 'draft';
  v_auto boolean;
  v_status text;
  v_id uuid;
BEGIN
  SELECT * INTO i FROM public.zalo_personal_reply_inbound WHERE id = p_inbound_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF i.status <> 'processing' OR i.lease_owner IS DISTINCT FROM p_worker THEN RETURN jsonb_build_object('ok', false, 'error', 'lease_lost'); END IF;

  IF p_result ? 'skip' OR d IS NULL THEN
    UPDATE public.zalo_personal_reply_inbound
    SET status = CASE WHEN p_result ->> 'fail' = 'true' THEN 'failed' ELSE 'skipped' END,
        reason = coalesce(nullif(p_result ->> 'skip', ''), 'skipped'), processed_at = now(), lease_owner = NULL, lease_until = NULL
    WHERE id = i.id;
    RETURN jsonb_build_object('ok', true, 'draftId', NULL);
  END IF;

  SELECT * INTO st FROM public.zalo_personal_reply_settings WHERE connection_id = i.connection_id;
  SELECT c.conversation_type, g.mode AS group_mode, g.consent_status, g.send_verified_at INTO cv
  FROM public.zalo_personal_conversations c LEFT JOIN public.zalo_personal_groups g ON g.id = c.group_id WHERE c.id = i.conversation_id;

  v_auto := coalesce((d ->> 'autoApprove')::boolean, false)
            AND st.reply_mode = 'auto'
            AND d ->> 'kind' = 'ai_answer'
            AND (d ->> 'askerUserId') IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a WHERE a.conversation_id = i.conversation_id)
            AND CASE WHEN cv.conversation_type = 'group'
                     THEN cv.group_mode = 'interactive' AND cv.consent_status = 'granted' AND cv.send_verified_at IS NOT NULL
                     -- 1-1: the sending path is verified once a MANUALLY approved reply reached this chat
                     ELSE EXISTS (SELECT 1 FROM public.zalo_personal_reply_drafts x WHERE x.conversation_id = i.conversation_id AND x.approval = 'manual' AND x.status = 'sent')
                END;
  v_status := CASE WHEN v_auto THEN 'queued' ELSE 'pending_approval' END;

  INSERT INTO public.zalo_personal_reply_drafts (connection_id, conversation_id, conversation_type, inbound_id, source_message_id, asker_external_id, asker_user_id,
                                                 audience, kind, pipeline, required_permissions, status, approval, approved_at, original_text, text,
                                                 citations, caveats, response_status, model, expires_at)
  VALUES (i.connection_id, i.conversation_id, cv.conversation_type, i.id, i.message_id, i.sender_external_id, nullif(d ->> 'askerUserId', '')::uuid,
          CASE WHEN cv.conversation_type = 'group' THEN 'group' ELSE 'private' END, d ->> 'kind', d ->> 'pipeline',
          coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(d -> 'requiredPermissions', '[]'::jsonb))), '{}'),
          v_status, CASE WHEN v_auto THEN 'auto' END, CASE WHEN v_auto THEN now() END,
          d ->> 'text', d ->> 'text', coalesce(d -> 'citations', '[]'::jsonb), coalesce(d -> 'caveats', '[]'::jsonb),
          nullif(d ->> 'responseStatus', ''), nullif(d ->> 'model', ''), now() + make_interval(mins => st.draft_ttl_minutes))
  ON CONFLICT (inbound_id) DO NOTHING
  RETURNING id INTO v_id;

  UPDATE public.zalo_personal_reply_inbound SET status = 'done', reason = NULL, processed_at = now(), lease_owner = NULL, lease_until = NULL WHERE id = i.id;
  IF v_id IS NOT NULL THEN
    PERFORM public.zp_reply_log(i.connection_id, v_id, NULL, 'system', 'draft.created', NULL, 'pending_approval', jsonb_build_object('kind', d ->> 'kind', 'pipeline', d ->> 'pipeline'));
    IF v_auto THEN
      PERFORM public.zp_reply_log(i.connection_id, v_id, NULL, 'system', 'draft.auto_approved', 'pending_approval', 'queued', '{}'::jsonb);
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'draftId', v_id, 'status', v_status);
END;
$$;

-- ---------------------------------------------------------------- reviewer actions
-- The application has already checked WHO may act (owner / manage grant +
-- the draft's required permissions). Here: state machine + version + expiry.
--   approve          pending_approval → queued (manual)
--   edit             pending_approval → pending_approval (text, version++)
--   reject           pending_approval → rejected
--   cancel           pending_approval | queued → cancelled
--   confirm_sent     delivery_unknown → sent     (operator saw it on the phone)
--   confirm_not_sent delivery_unknown → failed   (never resent automatically)
CREATE OR REPLACE FUNCTION public.zp_reply_act(p_actor uuid, p_draft_id uuid, p_action text, p_version integer, p_text text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  d public.zalo_personal_reply_drafts%ROWTYPE;
  v_to text;
  v_text text := btrim(coalesce(p_text, ''));
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  SELECT * INTO d FROM public.zalo_personal_reply_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p_version IS DISTINCT FROM d.version THEN RETURN jsonb_build_object('ok', false, 'error', 'version_conflict'); END IF;

  IF p_action IN ('approve', 'edit') AND d.status = 'pending_approval' AND d.expires_at <= now() THEN
    UPDATE public.zalo_personal_reply_drafts SET status = 'expired', version = version + 1 WHERE id = d.id;
    PERFORM public.zp_reply_log(d.connection_id, d.id, NULL, 'system', 'draft.expired', d.status, 'expired', '{}'::jsonb);
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  IF p_action = 'approve' AND d.status = 'pending_approval' THEN
    v_to := 'queued';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, approval = 'manual', approved_by = p_actor, approved_at = now(), version = version + 1, hold_reason = NULL WHERE id = d.id;
  ELSIF p_action = 'edit' AND d.status = 'pending_approval' THEN
    IF length(v_text) < 1 OR length(v_text) > 1800 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_text'); END IF;
    v_to := d.status;
    UPDATE public.zalo_personal_reply_drafts SET text = v_text, edited = (v_text <> original_text), version = version + 1 WHERE id = d.id;
  ELSIF p_action = 'reject' AND d.status = 'pending_approval' THEN
    v_to := 'rejected';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, version = version + 1 WHERE id = d.id;
  ELSIF p_action = 'cancel' AND d.status IN ('pending_approval', 'queued') THEN
    v_to := 'cancelled';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, version = version + 1 WHERE id = d.id;
  ELSIF p_action = 'confirm_sent' AND d.status = 'delivery_unknown' THEN
    v_to := 'sent';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, sent_at = coalesce(sending_started_at, now()), error_category = NULL, version = version + 1 WHERE id = d.id;
  ELSIF p_action = 'confirm_not_sent' AND d.status = 'delivery_unknown' THEN
    v_to := 'failed';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, error_category = 'operator_not_sent', version = version + 1 WHERE id = d.id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition', 'status', d.status);
  END IF;

  PERFORM public.zp_reply_log(d.connection_id, d.id, p_actor, 'user', 'draft.' || p_action, d.status, v_to,
                              CASE WHEN nullif(btrim(coalesce(p_note, '')), '') IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note', left(btrim(p_note), 300)) END
                              || CASE WHEN p_action = 'edit' THEN jsonb_build_object('length', length(v_text)) ELSE '{}'::jsonb END);
  RETURN jsonb_build_object('ok', true, 'status', v_to, 'version', d.version + 1);
END;
$$;

-- ---------------------------------------------------------------- outbound (worker)
-- Expiry + lost-lease recovery. A 'sending' row whose lease ran out (worker
-- died / restarted mid-send, report lost) becomes delivery_unknown: it may
-- have reached Zalo, so it is NEVER put back in the queue.
CREATE OR REPLACE FUNCTION public.zp_reply_recover()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r record;
  v_expired integer := 0;
  v_unknown integer := 0;
BEGIN
  FOR r IN SELECT id, connection_id, status FROM public.zalo_personal_reply_drafts
           WHERE status IN ('pending_approval', 'queued') AND expires_at <= now() ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.zalo_personal_reply_drafts SET status = 'expired', version = version + 1 WHERE id = r.id;
    PERFORM public.zp_reply_log(r.connection_id, r.id, NULL, 'system', 'draft.expired', r.status, 'expired', '{}'::jsonb);
    v_expired := v_expired + 1;
  END LOOP;
  FOR r IN SELECT id, connection_id FROM public.zalo_personal_reply_drafts
           WHERE status = 'sending' AND lease_until < now() ORDER BY sending_started_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.zalo_personal_reply_drafts SET status = 'delivery_unknown', error_category = 'lease_expired', version = version + 1 WHERE id = r.id;
    PERFORM public.zp_reply_log(r.connection_id, r.id, NULL, 'system', 'outbound.lease_expired', 'sending', 'delivery_unknown', '{}'::jsonb);
    v_unknown := v_unknown + 1;
  END LOOP;
  RETURN jsonb_build_object('expired', v_expired, 'unknown', v_unknown);
END;
$$;

-- The ONLY way a reply leaves the system. Called by the HMAC-authenticated
-- worker of the connection. Re-checks, in this order, at the last moment:
-- emergency stop → worker / connection → pause / mode → per draft: expiry,
-- conversation still allowed (group mode / consent, direct enabled, auto
-- rules), sender block, sender identity + profile, approver profile, rate
-- limits. Returns at most ONE job; one 'sending' per conversation at a time.
CREATE OR REPLACE FUNCTION public.zp_reply_claim_outbound(p_worker_id uuid, p_account_id text, p_lease_seconds integer, p_global_daily_cap integer, p_auto_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  w record;
  c record;
  st public.zalo_personal_reply_settings%ROWTYPE;
  d record;
  v_day timestamptz := public.zp_reply_vn_day_start();
  v_cancel text;
  v_hold text;
  v_token uuid;
  v_n integer;
  v_first_hold text;
BEGIN
  IF (SELECT emergency_stop FROM public.zalo_personal_reply_control WHERE id = 1) THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'emergency_stop');
  END IF;
  SELECT * INTO w FROM public.zalo_personal_workers WHERE id = p_worker_id;
  IF NOT FOUND OR w.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'worker_revoked'); END IF;
  SELECT * INTO c FROM public.zalo_personal_connections WHERE id = w.connection_id;
  IF c.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'connection_disabled'); END IF;
  IF c.zalo_account_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_bound'); END IF;
  -- only the Zalo account bound to this connection may send for it
  IF p_account_id IS DISTINCT FROM c.zalo_account_id THEN RETURN jsonb_build_object('ok', false, 'error', 'account_mismatch'); END IF;
  SELECT * INTO st FROM public.zalo_personal_reply_settings WHERE connection_id = c.id;
  IF NOT FOUND OR st.reply_mode = 'off' THEN RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'replies_off'); END IF;
  IF st.send_paused THEN RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'send_paused'); END IF;

  -- global + connection daily caps first (cheap, apply to every draft)
  IF (SELECT count(*) FROM public.zalo_personal_reply_drafts x WHERE x.status IN ('sending', 'sent', 'delivery_unknown') AND coalesce(x.sent_at, x.sending_started_at) >= v_day) >= greatest(coalesce(p_global_daily_cap, 0), 0) THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'global_daily_limit');
  END IF;
  IF (SELECT count(*) FROM public.zalo_personal_reply_drafts x WHERE x.connection_id = c.id AND x.status IN ('sending', 'sent', 'delivery_unknown') AND coalesce(x.sent_at, x.sending_started_at) >= v_day) >= st.daily_send_limit THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'daily_limit');
  END IF;

  FOR d IN
    SELECT x.*, cv.external_conversation_id, g.mode AS group_mode, g.consent_status AS group_consent
    FROM public.zalo_personal_reply_drafts x
    JOIN public.zalo_personal_conversations cv ON cv.id = x.conversation_id
    LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id
    WHERE x.connection_id = c.id AND x.status = 'queued'
    ORDER BY x.approved_at, x.created_at
    LIMIT 10
    FOR UPDATE OF x SKIP LOCKED
  LOOP
    v_cancel := NULL; v_hold := NULL;
    IF d.expires_at <= now() THEN
      UPDATE public.zalo_personal_reply_drafts SET status = 'expired', version = version + 1 WHERE id = d.id;
      PERFORM public.zp_reply_log(c.id, d.id, NULL, 'system', 'draft.expired', 'queued', 'expired', '{}'::jsonb);
      CONTINUE;
    END IF;

    IF d.conversation_type = 'group' THEN
      IF d.group_consent IS DISTINCT FROM 'granted' OR d.group_mode IS NULL OR d.group_mode NOT IN ('mention_only', 'interactive') THEN v_cancel := 'group_not_allowed'; END IF;
      IF v_cancel IS NULL AND d.approval = 'auto' AND d.group_mode <> 'interactive' THEN v_cancel := 'auto_not_allowed'; END IF;
    ELSIF NOT st.direct_enabled THEN
      v_cancel := 'direct_disabled';
    END IF;
    IF v_cancel IS NULL AND d.approval = 'auto' AND (NOT coalesce(p_auto_enabled, false) OR st.reply_mode <> 'auto'
        OR NOT EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a WHERE a.conversation_id = d.conversation_id)) THEN
      v_cancel := 'auto_not_allowed';
    END IF;
    IF v_cancel IS NULL AND EXISTS (SELECT 1 FROM public.zalo_personal_reply_blocks b WHERE b.connection_id = c.id AND b.external_user_id = d.asker_external_id) THEN
      v_cancel := 'sender_blocked';
    END IF;
    IF v_cancel IS NULL AND d.asker_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.ai_channel_identities ci JOIN public.profiles p ON p.id = ci.internal_user_id
        WHERE ci.connection_id = c.id AND ci.external_user_id = d.asker_external_id AND ci.status = 'active'
          AND ci.internal_user_id = d.asker_user_id AND p.is_active) THEN
      v_cancel := 'asker_not_authorized';
    END IF;
    IF v_cancel IS NULL AND d.approval = 'manual' AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = d.approved_by AND p.is_active) THEN
      v_cancel := 'approver_inactive';
    END IF;
    IF v_cancel IS NOT NULL THEN
      UPDATE public.zalo_personal_reply_drafts SET status = 'cancelled', error_category = v_cancel, version = version + 1 WHERE id = d.id;
      PERFORM public.zp_reply_log(c.id, d.id, NULL, 'system', 'outbound.cancelled', 'queued', 'cancelled', jsonb_build_object('reason', v_cancel));
      CONTINUE;
    END IF;

    -- rate limits (a hold keeps the draft queued until it expires)
    IF EXISTS (SELECT 1 FROM public.zalo_personal_reply_drafts x WHERE x.conversation_id = d.conversation_id AND x.id <> d.id
               AND (x.status = 'sending' OR (x.status IN ('sent', 'delivery_unknown') AND coalesce(x.sent_at, x.sending_started_at) > now() - make_interval(secs => st.cooldown_seconds)))) THEN
      v_hold := 'cooldown';
    END IF;
    IF v_hold IS NULL THEN
      SELECT count(*) INTO v_n FROM public.zalo_personal_reply_drafts x
      WHERE x.connection_id = c.id AND x.asker_external_id = d.asker_external_id AND x.status IN ('sending', 'sent', 'delivery_unknown')
        AND coalesce(x.sent_at, x.sending_started_at) > now() - interval '1 hour';
      IF v_n >= st.per_user_per_hour THEN v_hold := 'user_rate_limited'; END IF;
    END IF;
    IF v_hold IS NULL AND d.conversation_type = 'group' THEN
      SELECT count(*) INTO v_n FROM public.zalo_personal_reply_drafts x
      WHERE x.conversation_id = d.conversation_id AND x.status IN ('sending', 'sent', 'delivery_unknown') AND coalesce(x.sent_at, x.sending_started_at) > now() - interval '1 hour';
      IF v_n >= st.per_group_per_hour THEN v_hold := 'group_rate_limited'; END IF;
    END IF;
    IF v_hold IS NULL THEN
      SELECT count(*) INTO v_n FROM public.zalo_personal_reply_drafts x
      WHERE x.conversation_id = d.conversation_id AND x.status IN ('sending', 'sent', 'delivery_unknown') AND coalesce(x.sent_at, x.sending_started_at) >= v_day;
      IF v_n >= st.max_per_conversation_per_day THEN v_hold := 'conversation_daily_cap'; END IF;
    END IF;
    IF v_hold IS NOT NULL THEN
      IF d.hold_reason IS DISTINCT FROM v_hold THEN
        UPDATE public.zalo_personal_reply_drafts SET hold_reason = v_hold WHERE id = d.id;
      END IF;
      v_first_hold := coalesce(v_first_hold, v_hold);
      CONTINUE;
    END IF;

    v_token := gen_random_uuid();
    UPDATE public.zalo_personal_reply_drafts
    SET status = 'sending', claim_token = v_token, lease_worker_id = w.id, attempts = attempts + 1, sending_started_at = now(),
        lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 600)), hold_reason = NULL, version = version + 1
    WHERE id = d.id;
    PERFORM public.zp_reply_log(c.id, d.id, NULL, 'worker', 'outbound.claimed', 'queued', 'sending', jsonb_build_object('attempt', d.attempts + 1));
    RETURN jsonb_build_object('ok', true, 'reason', NULL, 'job', jsonb_build_object(
      'draftId', d.id, 'claimToken', v_token, 'threadId', d.external_conversation_id,
      'threadType', CASE WHEN d.conversation_type = 'group' THEN 'group' ELSE 'user' END, 'text', d.text,
      'leaseUntil', now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 600))));
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', coalesce(v_first_hold, 'empty'));
END;
$$;

-- Worker report for a claimed job (idempotent; the claim token proves the claim).
--   sent      sending | delivery_unknown → sent (msg id kept). A first MANUAL
--             reply to a group marks the group's sending path as verified.
--   not_sent  definitely not sent (e.g. no connection) → queued again (≤ 3 attempts) or failed
--   failed    Zalo refused → failed AND sending paused for the connection
--   unknown   request made, result unknown → delivery_unknown (operator decides)
CREATE OR REPLACE FUNCTION public.zp_reply_report(p_worker_id uuid, p_draft_id uuid, p_claim_token uuid, p_outcome text, p_zalo_msg_id text, p_error text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  w record;
  d public.zalo_personal_reply_drafts%ROWTYPE;
  v_to text;
  v_err text := CASE WHEN p_error ~ '^[a-z0-9_]{1,64}$' THEN p_error END;
  g record;
BEGIN
  SELECT * INTO w FROM public.zalo_personal_workers WHERE id = p_worker_id;
  IF NOT FOUND OR w.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'worker_revoked'); END IF;
  SELECT * INTO d FROM public.zalo_personal_reply_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND OR d.connection_id <> w.connection_id OR d.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_job');
  END IF;
  IF p_outcome NOT IN ('sent', 'not_sent', 'failed', 'unknown') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_outcome'); END IF;
  IF p_zalo_msg_id IS NOT NULL AND p_zalo_msg_id !~ '^[0-9A-Za-z_-]{1,64}$' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_outcome'); END IF;

  -- final states: a repeated report changes nothing
  IF d.status = 'sent' OR (d.status IN ('failed', 'delivery_unknown') AND p_outcome <> 'sent') OR d.status IN ('cancelled', 'expired', 'rejected') THEN
    RETURN jsonb_build_object('ok', true, 'status', d.status, 'changed', false);
  END IF;
  IF d.status NOT IN ('sending', 'delivery_unknown', 'failed') THEN
    RETURN jsonb_build_object('ok', true, 'status', d.status, 'changed', false);
  END IF;

  IF p_outcome = 'sent' THEN
    v_to := 'sent';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, sent_at = now(), zalo_msg_id = p_zalo_msg_id, error_category = NULL, lease_until = NULL, version = version + 1 WHERE id = d.id;
    IF d.conversation_type = 'group' AND d.approval = 'manual' THEN
      SELECT gr.id, gr.send_verified_at INTO g FROM public.zalo_personal_conversations cv JOIN public.zalo_personal_groups gr ON gr.id = cv.group_id WHERE cv.id = d.conversation_id FOR UPDATE OF gr;
      IF FOUND AND g.send_verified_at IS NULL THEN
        UPDATE public.zalo_personal_groups SET send_verified_at = now() WHERE id = g.id;
        PERFORM public.zp_reply_log(d.connection_id, d.id, NULL, 'system', 'group.send_verified', NULL, NULL, jsonb_build_object('groupId', g.id));
      END IF;
    END IF;
  ELSIF p_outcome = 'not_sent' THEN
    v_to := CASE WHEN d.attempts < 3 AND d.expires_at > now() THEN 'queued' ELSE 'failed' END;
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, claim_token = CASE WHEN v_to = 'queued' THEN NULL ELSE claim_token END, lease_until = NULL,
           sending_started_at = CASE WHEN v_to = 'queued' THEN NULL ELSE sending_started_at END, error_category = coalesce(v_err, 'not_sent'), version = version + 1 WHERE id = d.id;
  ELSIF p_outcome = 'failed' THEN
    v_to := 'failed';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, error_category = coalesce(v_err, 'zalo_rejected'), lease_until = NULL, version = version + 1 WHERE id = d.id;
    -- Zalo refused: stop sending from this account until the owner checks it
    UPDATE public.zalo_personal_reply_settings SET send_paused = true, paused_reason = coalesce(v_err, 'zalo_rejected'), paused_at = now()
    WHERE connection_id = d.connection_id AND NOT send_paused;
    PERFORM public.zp_reply_log(d.connection_id, NULL, NULL, 'system', 'connection.send_paused', NULL, NULL, jsonb_build_object('reason', coalesce(v_err, 'zalo_rejected')));
  ELSE
    v_to := 'delivery_unknown';
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, error_category = coalesce(v_err, 'unknown'), lease_until = NULL, version = version + 1 WHERE id = d.id;
  END IF;
  PERFORM public.zp_reply_log(d.connection_id, d.id, NULL, 'worker', 'outbound.' || p_outcome, d.status, v_to, CASE WHEN v_err IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('error', v_err) END);
  RETURN jsonb_build_object('ok', true, 'status', v_to, 'changed', true);
END;
$$;

-- ---------------------------------------------------------------- admin (settings, allowlist, blocks, stop)
-- The application checks the actor (connection owner; global stop: admin role).
CREATE OR REPLACE FUNCTION public.zp_reply_admin(p_actor uuid, p_action text, p_connection_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v jsonb := coalesce(p_payload, '{}'::jsonb);
  v_note text := nullif(btrim(coalesce(v ->> 'note', '')), '');
  v_conv record;
  v_rows integer;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;

  IF p_action IN ('emergency_stop', 'emergency_resume') THEN
    UPDATE public.zalo_personal_reply_control SET emergency_stop = (p_action = 'emergency_stop'), changed_by = p_actor, changed_at = now(), reason = left(v_note, 300) WHERE id = 1;
    PERFORM public.zp_reply_log(NULL, NULL, p_actor, 'user', 'control.' || p_action, NULL, NULL, CASE WHEN v_note IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note', left(v_note, 300)) END);
    RETURN jsonb_build_object('ok', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.zalo_personal_connections WHERE id = p_connection_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  INSERT INTO public.zalo_personal_reply_settings (connection_id) VALUES (p_connection_id) ON CONFLICT (connection_id) DO NOTHING;

  IF p_action = 'save_settings' THEN
    UPDATE public.zalo_personal_reply_settings SET
      reply_mode = coalesce(v ->> 'replyMode', reply_mode),
      direct_enabled = coalesce((v ->> 'directEnabled')::boolean, direct_enabled),
      unlinked_help = coalesce((v ->> 'unlinkedHelp')::boolean, unlinked_help),
      cooldown_seconds = coalesce((v ->> 'cooldownSeconds')::integer, cooldown_seconds),
      per_user_per_hour = coalesce((v ->> 'perUserPerHour')::integer, per_user_per_hour),
      per_group_per_hour = coalesce((v ->> 'perGroupPerHour')::integer, per_group_per_hour),
      daily_send_limit = coalesce((v ->> 'dailySendLimit')::integer, daily_send_limit),
      max_per_conversation_per_day = coalesce((v ->> 'maxPerConversationPerDay')::integer, max_per_conversation_per_day),
      draft_ttl_minutes = coalesce((v ->> 'draftTtlMinutes')::integer, draft_ttl_minutes),
      updated_by = p_actor
    WHERE connection_id = p_connection_id;
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'settings.saved', NULL, NULL, v - 'note');
  ELSIF p_action = 'pause_sending' THEN
    UPDATE public.zalo_personal_reply_settings SET send_paused = true, paused_reason = 'owner_paused', paused_at = now(), updated_by = p_actor WHERE connection_id = p_connection_id AND NOT send_paused;
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'connection.send_paused', NULL, NULL, jsonb_build_object('reason', 'owner_paused'));
  ELSIF p_action = 'resume_sending' THEN
    UPDATE public.zalo_personal_reply_settings SET send_paused = false, paused_reason = NULL, paused_at = NULL, updated_by = p_actor WHERE connection_id = p_connection_id;
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'connection.send_resumed', NULL, NULL, CASE WHEN v_note IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note', left(v_note, 300)) END);
  ELSIF p_action = 'allow_conversation' THEN
    IF v_note IS NULL OR length(v_note) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'note_required'); END IF;
    SELECT id INTO v_conv FROM public.zalo_personal_conversations WHERE id = (v ->> 'conversationId')::uuid AND connection_id = p_connection_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
    INSERT INTO public.zalo_personal_reply_allowlist (conversation_id, connection_id, enabled_by, note) VALUES (v_conv.id, p_connection_id, p_actor, left(v_note, 300))
    ON CONFLICT (conversation_id) DO UPDATE SET note = EXCLUDED.note, enabled_by = EXCLUDED.enabled_by;
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'allowlist.added', NULL, NULL, jsonb_build_object('conversationId', v_conv.id, 'note', left(v_note, 300)));
  ELSIF p_action = 'disallow_conversation' THEN
    DELETE FROM public.zalo_personal_reply_allowlist WHERE conversation_id = (v ->> 'conversationId')::uuid AND connection_id = p_connection_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    -- auto-approved replies of that conversation that did not leave yet are cancelled
    UPDATE public.zalo_personal_reply_drafts SET status = 'cancelled', error_category = 'auto_not_allowed', version = version + 1
    WHERE conversation_id = (v ->> 'conversationId')::uuid AND status = 'queued' AND approval = 'auto';
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'allowlist.removed', NULL, NULL, jsonb_build_object('conversationId', v ->> 'conversationId', 'removed', v_rows));
  ELSIF p_action = 'block_user' THEN
    IF coalesce(v ->> 'externalUserId', '') !~ '^[0-9]{1,32}$' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
    INSERT INTO public.zalo_personal_reply_blocks (connection_id, external_user_id, blocked_by, note) VALUES (p_connection_id, v ->> 'externalUserId', p_actor, left(v_note, 300))
    ON CONFLICT (connection_id, external_user_id) DO NOTHING;
    UPDATE public.zalo_personal_reply_drafts SET status = 'cancelled', error_category = 'sender_blocked', version = version + 1
    WHERE connection_id = p_connection_id AND asker_external_id = v ->> 'externalUserId' AND status IN ('pending_approval', 'queued');
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'block.added', NULL, NULL, '{}'::jsonb);
  ELSIF p_action = 'unblock_user' THEN
    DELETE FROM public.zalo_personal_reply_blocks WHERE connection_id = p_connection_id AND external_user_id = v ->> 'externalUserId';
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'block.removed', NULL, NULL, '{}'::jsonb);
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
  END IF;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
END;
$$;

-- ---------------------------------------------------------------- cron (dormant)
-- Same mechanism as 00050 / 00078. Dormant until the owner stores the URL in
-- Vault ('zp_reply_tick_url'); the bearer is the existing internal secret.
CREATE OR REPLACE FUNCTION public.zp_reply_cron_tick()
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
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'zp_reply_tick_url';
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
REVOKE EXECUTE ON FUNCTION public.zp_reply_cron_tick() FROM PUBLIC, anon, authenticated, service_role;
SELECT cron.schedule('zp-reply-tick', '* * * * *', 'select public.zp_reply_cron_tick()');

-- ---------------------------------------------------------------- function privileges
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'zp_reply_vn_day_start()',
    'zp_reply_log(uuid, uuid, uuid, text, text, text, text, jsonb)',
    'zp_reply_scan_claim(text, integer, integer, integer)',
    'zp_reply_scan_messages(uuid, timestamptz, uuid, timestamptz, integer)',
    'zp_reply_scan_commit(uuid, text, timestamptz, uuid, integer, jsonb, boolean)',
    'zp_reply_scan_release(uuid, text)',
    'zp_reply_claim_inbound(text, integer, integer)',
    'zp_reply_inbound_context(uuid)',
    'zp_reply_store_result(uuid, text, jsonb)',
    'zp_reply_act(uuid, uuid, text, integer, text, text)',
    'zp_reply_recover()',
    'zp_reply_claim_outbound(uuid, text, integer, integer, boolean)',
    'zp_reply_report(uuid, uuid, uuid, text, text, text)',
    'zp_reply_admin(uuid, text, uuid, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
