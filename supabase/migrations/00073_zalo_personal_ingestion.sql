-- ============================================================
-- ZALO PERSONAL — Phase 02: ingestion of messages from the zca-js worker
-- (services/zalo-personal-worker) into PostgreSQL. Additive only: no
-- existing table, policy or function is changed. Zalo OA (zalo_*,
-- notification_*) and the Web / OA assistant threads (ai_conversations,
-- ai_messages) are untouched — this channel has its own namespace.
--
--   zalo_personal_connections      one Zalo personal account, owned by ONE profile
--   zalo_personal_workers          worker identities (HMAC secret encrypted with APP_ENCRYPTION_KEY)
--   zalo_personal_request_nonces   replay protection + distributed rate limit
--   zalo_personal_groups           groups seen / discovered, mode + consent (default disabled)
--   zalo_personal_conversations    1-1 and group threads of one connection
--   zalo_personal_messages         stored messages (text only where policy allows)
--   zalo_personal_ingestion_events idempotency + outcome per event identity (no payload)
--   zalo_personal_sync_state       per-worker heartbeat / delivery state
--
-- Isolation is enforced by the database, not only by the API:
--   * every row carries connection_id; children reference (id, connection_id)
--     composite keys, so a message can never point at another connection's
--     conversation, nor a conversation at another connection's group;
--   * the ingestion functions derive the connection from the authenticated
--     worker row — never from the request payload;
--   * RLS on, nothing granted to anon / authenticated (not even the owner:
--     there is no UI in Phase 02; a future screen reads through the server
--     after an owner check). Only service_role, from trusted backend code.
-- There is no workspace / tenant concept in this application (single
-- tenant, see docs/zalo-ai/decisions.md C1): the owner profile of the
-- connection is the isolation boundary.
-- After `db push`: NOTIFY pgrst, 'reload schema'.
-- ============================================================

-- ------------------------------------------------------------ connections
CREATE TABLE public.zalo_personal_connections (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_key         text        NOT NULL UNIQUE CHECK (connection_key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  owner_user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  -- the Zalo account (own uid) this connection is bound to; set by the first heartbeat, never silently changed
  zalo_account_id        text        CHECK (zalo_account_id IS NULL OR zalo_account_id ~ '^[0-9]{1,32}$'),
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- what is kept from 1-1 chats: nothing / metadata (no text) / content
  direct_message_mode    text        NOT NULL DEFAULT 'metadata' CHECK (direct_message_mode IN ('off', 'metadata', 'content')),
  last_heartbeat_at      timestamptz,
  last_connected_at      timestamptz,
  last_error_category    text        CHECK (last_error_category IS NULL OR length(last_error_category) <= 64),
  created_by             uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- one connection per Zalo account: the same account can never be split across two owners
CREATE UNIQUE INDEX ux_zalo_personal_connections_account ON public.zalo_personal_connections (zalo_account_id) WHERE zalo_account_id IS NOT NULL;
CREATE INDEX idx_zalo_personal_connections_owner ON public.zalo_personal_connections (owner_user_id);
CREATE TRIGGER set_zalo_personal_connections_updated_at BEFORE UPDATE ON public.zalo_personal_connections
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ workers
CREATE TABLE public.zalo_personal_workers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_key         text        NOT NULL UNIQUE CHECK (worker_key ~ '^[a-z0-9][a-z0-9_-]{2,47}$'),
  connection_id      uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  -- HMAC secret, encrypted by the app (src/lib/security/secrets.ts, AAD bound to the worker id). Never plaintext.
  secret_encrypted   text        NOT NULL CHECK (secret_encrypted LIKE 'v1.%'),
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX idx_zalo_personal_workers_connection ON public.zalo_personal_workers (connection_id);
CREATE TRIGGER set_zalo_personal_workers_updated_at BEFORE UPDATE ON public.zalo_personal_workers
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ request nonces (replay + rate limit)
CREATE TABLE public.zalo_personal_request_nonces (
  worker_id   uuid        NOT NULL REFERENCES public.zalo_personal_workers(id) ON DELETE CASCADE,
  nonce       text        NOT NULL CHECK (nonce ~ '^[0-9a-f]{32}$'),
  endpoint    text        NOT NULL CHECK (endpoint IN ('events', 'heartbeat')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, nonce)
);
CREATE INDEX idx_zalo_personal_nonces_time ON public.zalo_personal_request_nonces (worker_id, created_at);

-- ------------------------------------------------------------ groups
CREATE TABLE public.zalo_personal_groups (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id        uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  external_group_id    text        NOT NULL CHECK (external_group_id ~ '^[0-9]{1,32}$'),
  display_name         text        CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 2000),
  mode                 text        NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'monitor', 'mention_only', 'interactive')),
  consent_status       text        NOT NULL DEFAULT 'none' CHECK (consent_status IN ('none', 'granted', 'withdrawn')),
  consent_recorded_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  consent_recorded_at  timestamptz,
  consent_note         text        CHECK (consent_note IS NULL OR length(consent_note) <= 500),
  -- interactive needs a verified sending path (a later phase); nothing sets this in Phase 02
  send_verified_at     timestamptz,
  discovered_via       text        NOT NULL DEFAULT 'event' CHECK (discovered_via IN ('discovery_token', 'event', 'admin')),
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  mode_changed_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  mode_changed_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_group_id),
  UNIQUE (id, connection_id),
  -- content may only be collected from a group whose consent was recorded
  CONSTRAINT zalo_personal_groups_consent_required CHECK (mode = 'disabled' OR consent_status = 'granted'),
  CONSTRAINT zalo_personal_groups_consent_recorded CHECK (consent_status <> 'granted' OR (consent_recorded_by IS NOT NULL AND consent_recorded_at IS NOT NULL)),
  CONSTRAINT zalo_personal_groups_interactive_verified CHECK (mode <> 'interactive' OR send_verified_at IS NOT NULL)
);
CREATE TRIGGER set_zalo_personal_groups_updated_at BEFORE UPDATE ON public.zalo_personal_groups
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ conversations
CREATE TABLE public.zalo_personal_conversations (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id             uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  channel                   text        NOT NULL DEFAULT 'zalo_personal' CHECK (channel = 'zalo_personal'),
  conversation_type         text        NOT NULL CHECK (conversation_type IN ('user', 'group')),
  external_conversation_id  text        NOT NULL CHECK (external_conversation_id ~ '^[0-9]{1,32}$'),
  group_id                  uuid,
  first_message_at          timestamptz,
  last_message_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, conversation_type, external_conversation_id),
  UNIQUE (id, connection_id),
  FOREIGN KEY (group_id, connection_id) REFERENCES public.zalo_personal_groups (id, connection_id) ON DELETE RESTRICT,
  CHECK ((conversation_type = 'group') = (group_id IS NOT NULL))
);
CREATE TRIGGER set_zalo_personal_conversations_updated_at BEFORE UPDATE ON public.zalo_personal_conversations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ ingestion events (idempotency, no payload)
CREATE TABLE public.zalo_personal_ingestion_events (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  worker_id          uuid        REFERENCES public.zalo_personal_workers(id) ON DELETE SET NULL,
  -- sha256 of the event identity, computed by the worker (stable across retries / restarts)
  event_key          text        NOT NULL CHECK (event_key ~ '^[0-9a-f]{64}$'),
  kind               text        NOT NULL CHECK (kind IN ('message', 'undo', 'reaction', 'group_event', 'group_discovery')),
  conversation_type  text        CHECK (conversation_type IS NULL OR conversation_type IN ('user', 'group')),
  outcome            text        NOT NULL CHECK (outcome IN ('stored', 'recorded', 'rejected_group', 'rejected_direct', 'ignored')),
  reason             text        CHECK (reason IS NULL OR length(reason) <= 64),
  message_id         uuid,
  delivery_count     integer     NOT NULL DEFAULT 1 CHECK (delivery_count >= 1),
  occurred_at        timestamptz,
  first_received_at  timestamptz NOT NULL DEFAULT now(),
  last_received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, event_key),
  UNIQUE (id, connection_id)
);
CREATE INDEX idx_zalo_personal_ingestion_events_time ON public.zalo_personal_ingestion_events (connection_id, first_received_at DESC);

-- ------------------------------------------------------------ messages
CREATE TABLE public.zalo_personal_messages (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id        uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  conversation_id      uuid        NOT NULL,
  external_message_id  text        NOT NULL CHECK (external_message_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  sender_external_id   text        NOT NULL CHECK (sender_external_id ~ '^[0-9]{1,32}$'),
  message_type         text        NOT NULL CHECK (message_type IN ('text', 'image', 'sticker', 'video', 'voice', 'file', 'link', 'location', 'other')),
  -- NULL unless the conversation's policy allows content (group with consent, or direct_message_mode = content)
  text_content         text        CHECK (text_content IS NULL OR length(text_content) <= 4000),
  content_stored       boolean     NOT NULL,
  text_length          integer     NOT NULL DEFAULT 0 CHECK (text_length BETWEEN 0 AND 4000),
  mentions             jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mentions) = 'array' AND jsonb_array_length(mentions) <= 50),
  mentions_self        boolean     NOT NULL DEFAULT false,
  is_self              boolean     NOT NULL,
  sent_at              timestamptz,                -- Zalo timestamp (NULL when implausible)
  received_at          timestamptz NOT NULL,       -- when the worker received it
  ingested_at          timestamptz NOT NULL DEFAULT now(),  -- server receive time
  processing_state     text        NOT NULL DEFAULT 'stored' CHECK (processing_state IN ('stored', 'pending', 'processed', 'failed')),
  ingestion_event_id   uuid        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- deduplication by account (connection) + conversation + Zalo message id — never by text or time
  CONSTRAINT ux_zalo_personal_messages_identity UNIQUE (connection_id, conversation_id, external_message_id),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (ingestion_event_id, connection_id) REFERENCES public.zalo_personal_ingestion_events (id, connection_id) ON DELETE RESTRICT,
  CHECK (content_stored OR text_content IS NULL)
);
CREATE INDEX idx_zalo_personal_messages_conversation ON public.zalo_personal_messages (conversation_id, ingested_at DESC);
CREATE TRIGGER set_zalo_personal_messages_updated_at BEFORE UPDATE ON public.zalo_personal_messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.zalo_personal_ingestion_events
  ADD CONSTRAINT zalo_personal_ingestion_events_message_fk FOREIGN KEY (message_id) REFERENCES public.zalo_personal_messages(id) ON DELETE SET NULL;

-- ------------------------------------------------------------ sync state (one row per worker)
CREATE TABLE public.zalo_personal_sync_state (
  worker_id                 uuid        PRIMARY KEY REFERENCES public.zalo_personal_workers(id) ON DELETE CASCADE,
  connection_id             uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  worker_version            text        CHECK (worker_version IS NULL OR length(worker_version) <= 32),
  worker_started_at         timestamptz,
  last_heartbeat_at         timestamptz,                -- worker online = recent heartbeat
  session_state             text        NOT NULL DEFAULT 'unknown' CHECK (session_state IN ('unknown', 'authenticated', 'unauthenticated', 'rejected')),
  listener_state            text        NOT NULL DEFAULT 'unknown' CHECK (listener_state IN ('unknown', 'active', 'connecting', 'reconnecting', 'inactive', 'error')),
  last_message_received_at  timestamptz,                -- reported by the worker (Zalo → worker)
  last_delivery_ok_at       timestamptz,                -- reported by the worker (backend reachable)
  last_ingested_at          timestamptz,                -- set by the server when an event was stored / recorded
  last_event_at             timestamptz,                -- worker receive time of the newest ingested event
  outbox_depth              integer     CHECK (outbox_depth IS NULL OR outbox_depth >= 0),
  dead_letter_count         integer     CHECK (dead_letter_count IS NULL OR dead_letter_count >= 0),
  outbox_full_drops         integer     CHECK (outbox_full_drops IS NULL OR outbox_full_drops >= 0),
  last_error_category       text        CHECK (last_error_category IS NULL OR length(last_error_category) <= 64),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER set_zalo_personal_sync_state_updated_at BEFORE UPDATE ON public.zalo_personal_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------ privileges
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_personal_connections', 'zalo_personal_workers', 'zalo_personal_request_nonces', 'zalo_personal_groups',
                           'zalo_personal_conversations', 'zalo_personal_ingestion_events', 'zalo_personal_messages', 'zalo_personal_sync_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    -- cloud has no default grants: explicit
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END;
$$;


-- ============================================================
-- Functions (service_role only)
-- ============================================================

-- Replay protection + rate limit, AFTER the HMAC was verified by the server.
-- 'ok' | 'nonce_reused' | 'rate_limited'. A rate-limited request leaves no
-- nonce, so the worker may retry later with a new one.
CREATE OR REPLACE FUNCTION public.zp_register_request(p_worker_id uuid, p_nonce text, p_endpoint text, p_max_per_window integer, p_window_seconds integer)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_recent integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.zalo_personal_request_nonces WHERE worker_id = p_worker_id AND nonce = p_nonce) THEN
    RETURN 'nonce_reused';
  END IF;
  SELECT count(*) INTO v_recent
  FROM public.zalo_personal_request_nonces
  WHERE worker_id = p_worker_id AND created_at > now() - make_interval(secs => p_window_seconds);
  IF v_recent >= p_max_per_window THEN
    RETURN 'rate_limited';
  END IF;
  BEGIN
    INSERT INTO public.zalo_personal_request_nonces (worker_id, nonce, endpoint) VALUES (p_worker_id, p_nonce, p_endpoint);
  EXCEPTION WHEN unique_violation THEN
    RETURN 'nonce_reused'; -- concurrent duplicate
  END;
  -- bounded housekeeping: nonces only need to outlive the timestamp window
  DELETE FROM public.zalo_personal_request_nonces
  WHERE ctid IN (SELECT ctid FROM public.zalo_personal_request_nonces WHERE worker_id = p_worker_id AND created_at < now() - interval '1 hour' LIMIT 200);
  RETURN 'ok';
END;
$$;

-- Heartbeat: binds the connection to its Zalo account on first use, then
-- refuses any other account (no silent re-binding).
CREATE OR REPLACE FUNCTION public.zp_record_heartbeat(p_worker_id uuid, p_account_id text, p_state jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  w record;
  c record;
  v_listener text := coalesce(p_state->>'listenerState', 'unknown');
BEGIN
  SELECT * INTO w FROM public.zalo_personal_workers WHERE id = p_worker_id;
  IF NOT FOUND OR w.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'worker_revoked'); END IF;
  SELECT * INTO c FROM public.zalo_personal_connections WHERE id = w.connection_id FOR UPDATE;
  IF c.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'connection_disabled'); END IF;

  IF p_account_id IS NOT NULL THEN
    IF c.zalo_account_id IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.zalo_personal_connections WHERE zalo_account_id = p_account_id AND id <> c.id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'account_in_use');
      END IF;
      UPDATE public.zalo_personal_connections SET zalo_account_id = p_account_id WHERE id = c.id;
    ELSIF c.zalo_account_id <> p_account_id THEN
      UPDATE public.zalo_personal_connections SET last_error_category = 'account_mismatch' WHERE id = c.id;
      RETURN jsonb_build_object('ok', false, 'error', 'account_mismatch');
    END IF;
  END IF;

  INSERT INTO public.zalo_personal_sync_state AS s (worker_id, connection_id, worker_version, worker_started_at, last_heartbeat_at, session_state, listener_state,
                                                    last_message_received_at, last_delivery_ok_at, outbox_depth, dead_letter_count, outbox_full_drops, last_error_category)
  VALUES (w.id, c.id, left(p_state->>'workerVersion', 32), (p_state->>'workerStartedAt')::timestamptz, now(),
          coalesce(p_state->>'sessionState', 'unknown'), v_listener,
          (p_state->>'lastMessageReceivedAt')::timestamptz, (p_state->>'lastDeliveryOkAt')::timestamptz,
          (p_state->>'outboxDepth')::integer, (p_state->>'deadLetterCount')::integer, (p_state->>'outboxFullDrops')::integer,
          left(p_state->>'lastErrorCategory', 64))
  ON CONFLICT (worker_id) DO UPDATE SET
    worker_version = EXCLUDED.worker_version,
    worker_started_at = EXCLUDED.worker_started_at,
    last_heartbeat_at = now(),
    session_state = EXCLUDED.session_state,
    listener_state = EXCLUDED.listener_state,
    last_message_received_at = coalesce(EXCLUDED.last_message_received_at, s.last_message_received_at),
    last_delivery_ok_at = coalesce(EXCLUDED.last_delivery_ok_at, s.last_delivery_ok_at),
    outbox_depth = EXCLUDED.outbox_depth,
    dead_letter_count = EXCLUDED.dead_letter_count,
    outbox_full_drops = EXCLUDED.outbox_full_drops,
    last_error_category = EXCLUDED.last_error_category;

  UPDATE public.zalo_personal_connections
  SET last_heartbeat_at = now(),
      last_connected_at = CASE WHEN v_listener = 'active' THEN now() ELSE last_connected_at END,
      last_error_category = left(p_state->>'lastErrorCategory', 64)
  WHERE id = c.id;
  UPDATE public.zalo_personal_workers SET last_seen_at = now() WHERE id = w.id;
  RETURN jsonb_build_object('ok', true, 'serverTime', now());
END;
$$;

-- Ingests a batch of already validated events for ONE worker. Per event:
--   duplicate event identity            → 'duplicate' (delivery_count++), nothing else
--   group not authorized (disabled)     → 'rejected' group_disabled (group row recorded as disabled, no content)
--   mention_only and bot not mentioned  → 'ignored'  not_mentioned
--   1-1 with direct_message_mode = off  → 'rejected' direct_disabled
--   message                             → 'stored'   (text only where policy allows)
--   undo / reaction / group_event       → 'recorded' (metadata only)
--   group_discovery                     → 'recorded' (group registered as disabled)
-- Returns { ok, results: [{ eventKey, status, reason }] } or { ok: false, error }.
CREATE OR REPLACE FUNCTION public.zp_ingest_events(p_worker_id uuid, p_account_id text, p_events jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  w record;
  c record;
  e jsonb;
  v_results jsonb := '[]'::jsonb;
  v_key text;
  v_kind text;
  v_type text;
  v_ext text;
  v_event_id uuid;
  v_inserted boolean;
  v_prev_outcome text;
  v_group record;
  v_group_id uuid;
  v_conv_id uuid;
  v_msg_id uuid;
  v_outcome text;
  v_reason text;
  v_status text;
  v_keep_text boolean;
  v_text text;
  v_occurred timestamptz;
  v_any boolean := false;
BEGIN
  SELECT * INTO w FROM public.zalo_personal_workers WHERE id = p_worker_id;
  IF NOT FOUND OR w.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'worker_revoked'); END IF;
  SELECT * INTO c FROM public.zalo_personal_connections WHERE id = w.connection_id;
  IF c.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'connection_disabled'); END IF;
  IF c.zalo_account_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_bound'); END IF;
  IF p_account_id IS DISTINCT FROM c.zalo_account_id THEN RETURN jsonb_build_object('ok', false, 'error', 'account_mismatch'); END IF;
  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 50 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_payload'); END IF;

  FOR e IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_key := e->>'eventKey';
    v_kind := e->>'kind';
    v_type := e->>'conversationType';
    v_ext := e->>'conversationId';
    v_occurred := (e->>'receivedAt')::timestamptz;
    v_outcome := NULL; v_reason := NULL; v_msg_id := NULL; v_conv_id := NULL; v_group_id := NULL;

    -- each event in its own subtransaction: one bad event is rejected alone
    -- (final, not retried) instead of failing — and endlessly retrying — the batch
    BEGIN
    -- 1. idempotency: one row per (connection, event identity)
    INSERT INTO public.zalo_personal_ingestion_events AS ie (connection_id, worker_id, event_key, kind, conversation_type, outcome, occurred_at)
    VALUES (c.id, w.id, v_key, v_kind, v_type, 'ignored', v_occurred)
    ON CONFLICT (connection_id, event_key) DO UPDATE SET delivery_count = ie.delivery_count + 1, last_received_at = now()
    RETURNING id, (xmax = 0), outcome INTO v_event_id, v_inserted, v_prev_outcome;

    IF NOT v_inserted THEN
      v_results := v_results || jsonb_build_object('eventKey', v_key, 'status', 'duplicate', 'reason', v_prev_outcome);
      CONTINUE;
    END IF;

    -- 2. policy
    IF v_type = 'group' THEN
      INSERT INTO public.zalo_personal_groups AS g (connection_id, external_group_id, discovered_via)
      VALUES (c.id, v_ext, CASE WHEN v_kind = 'group_discovery' THEN 'discovery_token' ELSE 'event' END)
      ON CONFLICT (connection_id, external_group_id) DO UPDATE SET last_seen_at = now()
      RETURNING * INTO v_group;
      v_group_id := v_group.id;

      IF v_kind = 'group_discovery' THEN
        v_outcome := 'recorded'; v_reason := 'group_registered';
      ELSIF v_group.mode = 'disabled' OR v_group.consent_status <> 'granted' THEN
        v_outcome := 'rejected_group'; v_reason := 'group_disabled';
      ELSIF v_group.mode = 'mention_only' AND v_kind = 'message' AND coalesce((e->>'mentionsSelf')::boolean, false) = false THEN
        v_outcome := 'ignored'; v_reason := 'not_mentioned';
      END IF;
      v_keep_text := true;
    ELSE
      IF v_kind = 'group_discovery' THEN
        v_outcome := 'ignored'; v_reason := 'not_a_group';
      ELSIF c.direct_message_mode = 'off' THEN
        v_outcome := 'rejected_direct'; v_reason := 'direct_disabled';
      END IF;
      v_keep_text := c.direct_message_mode = 'content';
    END IF;

    -- 3. store
    IF v_outcome IS NULL THEN
      INSERT INTO public.zalo_personal_conversations AS cv (connection_id, conversation_type, external_conversation_id, group_id, first_message_at, last_message_at)
      VALUES (c.id, v_type, v_ext, v_group_id, v_occurred, v_occurred)
      ON CONFLICT (connection_id, conversation_type, external_conversation_id)
        DO UPDATE SET last_message_at = greatest(cv.last_message_at, EXCLUDED.last_message_at)
      RETURNING id INTO v_conv_id;

      IF v_kind = 'message' THEN
        v_text := CASE WHEN v_keep_text THEN e->>'text' END;
        INSERT INTO public.zalo_personal_messages (connection_id, conversation_id, external_message_id, sender_external_id, message_type, text_content, content_stored,
                                                   text_length, mentions, mentions_self, is_self, sent_at, received_at, ingestion_event_id)
        VALUES (c.id, v_conv_id, e->>'externalMessageId', e->>'senderId', e->>'messageType', v_text, v_keep_text,
                coalesce((e->>'textLength')::integer, 0), coalesce(e->'mentions', '[]'::jsonb), coalesce((e->>'mentionsSelf')::boolean, false),
                (e->>'isSelf')::boolean, (e->>'sentAt')::timestamptz, v_occurred, v_event_id)
        ON CONFLICT ON CONSTRAINT ux_zalo_personal_messages_identity DO NOTHING
        RETURNING id INTO v_msg_id;
        IF v_msg_id IS NULL THEN
          -- same Zalo message under a different event identity: still stored once
          v_outcome := 'stored'; v_reason := 'message_already_stored';
        ELSE
          v_outcome := 'stored';
        END IF;
      ELSE
        v_outcome := 'recorded';
      END IF;
    END IF;

    UPDATE public.zalo_personal_ingestion_events SET outcome = v_outcome, reason = v_reason, message_id = v_msg_id WHERE id = v_event_id;
    v_status := CASE v_outcome WHEN 'stored' THEN 'stored' WHEN 'recorded' THEN 'recorded' WHEN 'ignored' THEN 'ignored' ELSE 'rejected' END;
    IF v_outcome IN ('stored', 'recorded') THEN v_any := true; END IF;
    v_results := v_results || jsonb_build_object('eventKey', v_key, 'status', v_status, 'reason', v_reason);
    EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation OR invalid_text_representation
                   OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range OR string_data_right_truncation THEN
      v_results := v_results || jsonb_build_object('eventKey', v_key, 'status', 'rejected', 'reason', 'invalid_event');
    END;
  END LOOP;

  IF v_any THEN
    UPDATE public.zalo_personal_sync_state
    SET last_ingested_at = now(),
        last_event_at = greatest(last_event_at, (SELECT max((x->>'receivedAt')::timestamptz) FROM jsonb_array_elements(p_events) x))
    WHERE worker_id = w.id;
  END IF;
  UPDATE public.zalo_personal_workers SET last_seen_at = now() WHERE id = w.id;
  RETURN jsonb_build_object('ok', true, 'results', v_results);
END;
$$;

-- Retention (explicit operator action; not scheduled by this migration):
-- nonces past the replay window, never-authorized discovered groups with no
-- conversation, and non-stored ingestion events. Stored messages are never touched.
CREATE OR REPLACE FUNCTION public.zp_prune(p_discovery_days integer DEFAULT 30, p_events_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_nonces integer;
  v_groups integer;
  v_events integer;
BEGIN
  DELETE FROM public.zalo_personal_request_nonces WHERE created_at < now() - interval '1 day';
  GET DIAGNOSTICS v_nonces = ROW_COUNT;
  DELETE FROM public.zalo_personal_groups g
  WHERE g.mode = 'disabled' AND g.consent_status = 'none' AND g.last_seen_at < now() - make_interval(days => p_discovery_days)
    AND NOT EXISTS (SELECT 1 FROM public.zalo_personal_conversations cv WHERE cv.group_id = g.id);
  GET DIAGNOSTICS v_groups = ROW_COUNT;
  DELETE FROM public.zalo_personal_ingestion_events
  WHERE message_id IS NULL AND outcome <> 'stored' AND first_received_at < now() - make_interval(days => p_events_days);
  GET DIAGNOSTICS v_events = ROW_COUNT;
  RETURN jsonb_build_object('nonces', v_nonces, 'groups', v_groups, 'events', v_events);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.zp_register_request(uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_record_heartbeat(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ingest_events(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_prune(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zp_register_request(uuid, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_record_heartbeat(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ingest_events(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_prune(integer, integer) TO service_role;
