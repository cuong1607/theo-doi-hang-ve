-- ============================================================
-- ZALO PERSONAL — Phase 03: dashboard (read + governed changes).
-- Additive only. No existing table, column, constraint or function is
-- changed: 00073 (ingestion) keeps its exact behaviour; Zalo OA (zalo_*,
-- notification_*) and the OA / Web assistant (ai_*) are untouched.
--
--   zalo_personal_access_grants   who besides the owner may see / manage what
--   zalo_personal_audit_log       every governed change (append-only)
--   zalo_personal_status_events   worker status history (state changes only,
--                                 written by a trigger on sync_state, 30 days)
--   zp_update_group               mode / consent change + audit, one transaction
--   zp_grant_access / zp_revoke_access   grant changes + audit
--   zp_conversation_summaries     per-conversation count + newest message
--   zp_ingestion_summary          outcome / reason counts + server-seen redeliveries
--
-- Authorization stays in the application (src/lib/zalo-personal/dashboard):
-- the functions receive an actor that the server already authorized, and
-- re-check only what the database can prove (row belongs to the connection,
-- consent recorded, sending not verified). Same RLS model as 00073: RLS on,
-- nothing granted to anon / authenticated, service_role only.
-- After `db push`: NOTIFY pgrst, 'reload schema'.
-- ============================================================

-- ------------------------------------------------------------ access grants
-- The connection owner (zalo_personal_connections.owner_user_id) always has
-- full access to their own connection. Nobody else has any access — not even
-- an admin — until the owner grants it here.
--   scope connection   level sync   : connection health + sync logs (no groups, no messages)
--                      level read   : + groups and GROUP conversations / messages
--                      level manage : + change group mode / record consent
--   scope conversation level read   : that one conversation (group or 1-1) only
-- 1-1 conversations are never covered by a connection-wide grant.
CREATE TABLE public.zalo_personal_access_grants (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  grantee_user_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  scope            text        NOT NULL CHECK (scope IN ('connection', 'conversation')),
  conversation_id  uuid,
  level            text        NOT NULL CHECK (level IN ('sync', 'read', 'manage')),
  note             text        CHECK (note IS NULL OR length(note) <= 300),
  granted_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  revoked_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoked_at       timestamptz,
  -- a conversation grant can only point at a conversation of the SAME connection
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE RESTRICT,
  CHECK ((scope = 'conversation') = (conversation_id IS NOT NULL)),
  CHECK (scope = 'connection' OR level = 'read'),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
-- one active grant per grantee and target
CREATE UNIQUE INDEX ux_zalo_personal_access_grants_active
  ON public.zalo_personal_access_grants (connection_id, grantee_user_id, coalesce(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX idx_zalo_personal_access_grants_grantee ON public.zalo_personal_access_grants (grantee_user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------ audit log
CREATE TABLE public.zalo_personal_audit_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id  uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE RESTRICT,
  actor_user_id  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  action         text        NOT NULL CHECK (action IN ('group.mode_changed', 'group.consent_granted', 'group.consent_withdrawn', 'access.granted', 'access.revoked')),
  target_type    text        NOT NULL CHECK (target_type IN ('group', 'grant')),
  target_id      uuid        NOT NULL,
  -- small structured facts only (from / to mode, level, note). Never message text, never secrets.
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_zalo_personal_audit_log_connection ON public.zalo_personal_audit_log (connection_id, created_at DESC);

-- Append-only: rows are never edited. The only UPDATE allowed is the
-- ON DELETE SET NULL of actor_user_id when a profile is removed.
CREATE OR REPLACE FUNCTION public.zp_audit_log_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.connection_id = OLD.connection_id AND NEW.action = OLD.action
     AND NEW.target_type = OLD.target_type AND NEW.target_id = OLD.target_id
     AND NEW.details = OLD.details AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'zalo_personal_audit_log is append-only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER zp_audit_log_no_update BEFORE UPDATE ON public.zalo_personal_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.zp_audit_log_guard();

-- ------------------------------------------------------------ status history
-- Only meaningful changes are kept (not every heartbeat): first heartbeat,
-- session / listener / error change, or a heartbeat after a gap (> 5 min).
CREATE TABLE public.zalo_personal_status_events (
  id                     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id              uuid        NOT NULL REFERENCES public.zalo_personal_workers(id) ON DELETE CASCADE,
  connection_id          uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  kind                   text        NOT NULL CHECK (kind IN ('first_seen', 'state_changed', 'resumed')),
  observed_at            timestamptz NOT NULL DEFAULT now(),
  session_state          text        NOT NULL,
  listener_state         text        NOT NULL,
  last_error_category    text        CHECK (last_error_category IS NULL OR length(last_error_category) <= 64),
  outbox_depth           integer,
  dead_letter_count      integer,
  previous_heartbeat_at  timestamptz
);
CREATE INDEX idx_zalo_personal_status_events_connection ON public.zalo_personal_status_events (connection_id, observed_at DESC);
CREATE INDEX idx_zalo_personal_status_events_worker ON public.zalo_personal_status_events (worker_id, observed_at);

CREATE OR REPLACE FUNCTION public.zp_log_status_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_kind := 'first_seen';
  ELSIF NEW.session_state IS DISTINCT FROM OLD.session_state
     OR NEW.listener_state IS DISTINCT FROM OLD.listener_state
     OR NEW.last_error_category IS DISTINCT FROM OLD.last_error_category THEN
    v_kind := 'state_changed';
  ELSIF OLD.last_heartbeat_at IS NOT NULL AND NEW.last_heartbeat_at > OLD.last_heartbeat_at + interval '5 minutes' THEN
    v_kind := 'resumed';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO public.zalo_personal_status_events (worker_id, connection_id, kind, session_state, listener_state, last_error_category, outbox_depth, dead_letter_count, previous_heartbeat_at)
  VALUES (NEW.worker_id, NEW.connection_id, v_kind, NEW.session_state, NEW.listener_state, NEW.last_error_category, NEW.outbox_depth, NEW.dead_letter_count,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.last_heartbeat_at END);
  -- bounded retention (30 days), a few rows per write
  DELETE FROM public.zalo_personal_status_events
  WHERE id IN (SELECT id FROM public.zalo_personal_status_events WHERE worker_id = NEW.worker_id AND observed_at < now() - interval '30 days' ORDER BY observed_at LIMIT 50);
  RETURN NULL;
END;
$$;
CREATE TRIGGER zp_sync_state_history AFTER INSERT OR UPDATE ON public.zalo_personal_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.zp_log_status_change();

-- ------------------------------------------------------------ indexes for the dashboard reads
CREATE INDEX idx_zalo_personal_messages_connection_time ON public.zalo_personal_messages (connection_id, ingested_at DESC);
CREATE INDEX idx_zalo_personal_conversations_connection_time ON public.zalo_personal_conversations (connection_id, last_message_at DESC NULLS LAST);

-- ------------------------------------------------------------ privileges
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_personal_access_grants', 'zalo_personal_audit_log', 'zalo_personal_status_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END;
$$;


-- ============================================================
-- Functions (service_role only). p_actor = the profile the server authorized.
-- ============================================================

-- Group mode / consent. Actions:
--   set_mode          disabled | monitor | mention_only   (interactive refused: no verified sending path)
--   grant_consent     records that the group agreed (note required)
--   withdraw_consent  consent → withdrawn AND mode → disabled
-- Returns { ok, changed, group } or { ok: false, error }.
CREATE OR REPLACE FUNCTION public.zp_update_group(p_actor uuid, p_connection_id uuid, p_group_id uuid, p_action text, p_mode text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  g record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  SELECT * INTO g FROM public.zalo_personal_groups WHERE id = p_group_id AND connection_id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  IF p_action = 'set_mode' THEN
    IF p_mode IS NULL OR p_mode NOT IN ('disabled', 'monitor', 'mention_only', 'interactive') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_mode');
    END IF;
    IF p_mode = 'interactive' AND g.send_verified_at IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'interactive_not_available');
    END IF;
    IF p_mode <> 'disabled' AND g.consent_status <> 'granted' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'consent_required');
    END IF;
    IF p_mode = g.mode THEN
      RETURN jsonb_build_object('ok', true, 'changed', false, 'group', jsonb_build_object('id', g.id, 'mode', g.mode, 'consentStatus', g.consent_status));
    END IF;
    UPDATE public.zalo_personal_groups SET mode = p_mode, mode_changed_by = p_actor, mode_changed_at = now() WHERE id = g.id;
    INSERT INTO public.zalo_personal_audit_log (connection_id, actor_user_id, action, target_type, target_id, details)
    VALUES (p_connection_id, p_actor, 'group.mode_changed', 'group', g.id, jsonb_build_object('from', g.mode, 'to', p_mode));
    RETURN jsonb_build_object('ok', true, 'changed', true, 'group', jsonb_build_object('id', g.id, 'mode', p_mode, 'consentStatus', g.consent_status));

  ELSIF p_action = 'grant_consent' THEN
    IF v_note IS NULL OR length(v_note) < 3 OR length(v_note) > 500 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'note_required');
    END IF;
    IF g.consent_status = 'granted' THEN
      RETURN jsonb_build_object('ok', true, 'changed', false, 'group', jsonb_build_object('id', g.id, 'mode', g.mode, 'consentStatus', g.consent_status));
    END IF;
    UPDATE public.zalo_personal_groups
    SET consent_status = 'granted', consent_recorded_by = p_actor, consent_recorded_at = now(), consent_note = v_note
    WHERE id = g.id;
    INSERT INTO public.zalo_personal_audit_log (connection_id, actor_user_id, action, target_type, target_id, details)
    VALUES (p_connection_id, p_actor, 'group.consent_granted', 'group', g.id, jsonb_build_object('from', g.consent_status, 'note', v_note));
    RETURN jsonb_build_object('ok', true, 'changed', true, 'group', jsonb_build_object('id', g.id, 'mode', g.mode, 'consentStatus', 'granted'));

  ELSIF p_action = 'withdraw_consent' THEN
    IF g.consent_status <> 'granted' THEN
      RETURN jsonb_build_object('ok', true, 'changed', false, 'group', jsonb_build_object('id', g.id, 'mode', g.mode, 'consentStatus', g.consent_status));
    END IF;
    -- one statement: the CHECK (mode = disabled OR consent granted) holds at every step
    UPDATE public.zalo_personal_groups
    SET consent_status = 'withdrawn', mode = 'disabled', mode_changed_by = p_actor, mode_changed_at = now()
    WHERE id = g.id;
    INSERT INTO public.zalo_personal_audit_log (connection_id, actor_user_id, action, target_type, target_id, details)
    VALUES (p_connection_id, p_actor, 'group.consent_withdrawn', 'group', g.id, jsonb_build_object('previousMode', g.mode, 'note', v_note));
    RETURN jsonb_build_object('ok', true, 'changed', true, 'group', jsonb_build_object('id', g.id, 'mode', 'disabled', 'consentStatus', 'withdrawn'));
  END IF;

  RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
END;
$$;

-- Grant access. The application checks that the actor is the owner and that
-- the grantee's role may use the module; the database checks the grantee is an
-- active profile, is not the owner, and the conversation belongs to the
-- connection. An existing active grant for the same target is replaced (level change).
CREATE OR REPLACE FUNCTION public.zp_grant_access(p_actor uuid, p_connection_id uuid, p_grantee uuid, p_scope text, p_conversation_id uuid, p_level text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  c record;
  v_prev record;
  v_id uuid;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  SELECT * INTO c FROM public.zalo_personal_connections WHERE id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p_grantee = c.owner_user_id THEN RETURN jsonb_build_object('ok', false, 'error', 'grantee_is_owner'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_grantee AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'grantee_invalid');
  END IF;
  IF p_scope = 'conversation' THEN
    IF p_conversation_id IS NULL OR p_level <> 'read' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_grant'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.zalo_personal_conversations WHERE id = p_conversation_id AND connection_id = p_connection_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
  ELSIF p_scope = 'connection' THEN
    IF p_conversation_id IS NOT NULL OR p_level NOT IN ('sync', 'read', 'manage') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_grant'); END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_grant');
  END IF;

  SELECT * INTO v_prev FROM public.zalo_personal_access_grants
  WHERE connection_id = p_connection_id AND grantee_user_id = p_grantee AND revoked_at IS NULL
    AND conversation_id IS NOT DISTINCT FROM p_conversation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_prev.level = p_level THEN
      RETURN jsonb_build_object('ok', true, 'changed', false, 'grantId', v_prev.id);
    END IF;
    UPDATE public.zalo_personal_access_grants SET revoked_at = now(), revoked_by = p_actor WHERE id = v_prev.id;
    INSERT INTO public.zalo_personal_audit_log (connection_id, actor_user_id, action, target_type, target_id, details)
    VALUES (p_connection_id, p_actor, 'access.revoked', 'grant', v_prev.id, jsonb_build_object('grantee', p_grantee, 'level', v_prev.level, 'reason', 'replaced'));
  END IF;

  INSERT INTO public.zalo_personal_access_grants (connection_id, grantee_user_id, scope, conversation_id, level, note, granted_by)
  VALUES (p_connection_id, p_grantee, p_scope, p_conversation_id, p_level, left(nullif(btrim(coalesce(p_note, '')), ''), 300), p_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.zalo_personal_audit_log (connection_id, actor_user_id, action, target_type, target_id, details)
  VALUES (p_connection_id, p_actor, 'access.granted', 'grant', v_id,
          jsonb_build_object('grantee', p_grantee, 'scope', p_scope, 'conversationId', p_conversation_id, 'level', p_level));
  RETURN jsonb_build_object('ok', true, 'changed', true, 'grantId', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.zp_revoke_access(p_actor uuid, p_connection_id uuid, p_grant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  g record;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  SELECT * INTO g FROM public.zalo_personal_access_grants WHERE id = p_grant_id AND connection_id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF g.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'changed', false); END IF;
  UPDATE public.zalo_personal_access_grants SET revoked_at = now(), revoked_by = p_actor WHERE id = g.id;
  INSERT INTO public.zalo_personal_audit_log (connection_id, actor_user_id, action, target_type, target_id, details)
  VALUES (p_connection_id, p_actor, 'access.revoked', 'grant', g.id, jsonb_build_object('grantee', g.grantee_user_id, 'level', g.level));
  RETURN jsonb_build_object('ok', true, 'changed', true);
END;
$$;

-- Per conversation: stored message count + newest message (text cut to 160
-- characters; the server blanks it when the reader may not see content).
CREATE OR REPLACE FUNCTION public.zp_conversation_summaries(p_conversation_ids uuid[])
RETURNS TABLE (conversation_id uuid, message_count bigint, last_message_type text, last_text text, last_content_stored boolean, last_is_self boolean, last_sent_at timestamptz, last_ingested_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT cv.id,
         (SELECT count(*) FROM public.zalo_personal_messages m WHERE m.conversation_id = cv.id),
         lm.message_type, left(lm.text_content, 160), lm.content_stored, lm.is_self, lm.sent_at, lm.ingested_at
  FROM public.zalo_personal_conversations cv
  LEFT JOIN LATERAL (
    SELECT m.message_type, m.text_content, m.content_stored, m.is_self, m.sent_at, m.ingested_at
    FROM public.zalo_personal_messages m
    WHERE m.conversation_id = cv.id
    ORDER BY m.ingested_at DESC, m.id DESC
    LIMIT 1
  ) lm ON true
  WHERE cv.id = ANY (p_conversation_ids[1:200]);
$$;

-- Ingestion outcomes since a time: counts per outcome / reason, plus how many
-- deliveries the server saw more than once (worker retries that reached us).
CREATE OR REPLACE FUNCTION public.zp_ingestion_summary(p_connection_id uuid, p_since timestamptz)
RETURNS TABLE (outcome text, reason text, events bigint, redelivered_events bigint, extra_deliveries bigint, last_received_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT e.outcome, e.reason, count(*), count(*) FILTER (WHERE e.delivery_count > 1), coalesce(sum(e.delivery_count - 1), 0), max(e.last_received_at)
  FROM public.zalo_personal_ingestion_events e
  WHERE e.connection_id = p_connection_id AND e.first_received_at >= p_since
  GROUP BY e.outcome, e.reason
  ORDER BY count(*) DESC
  LIMIT 100;
$$;

REVOKE EXECUTE ON FUNCTION public.zp_audit_log_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_log_status_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_update_group(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_grant_access(uuid, uuid, uuid, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_revoke_access(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_conversation_summaries(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ingestion_summary(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zp_update_group(uuid, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_grant_access(uuid, uuid, uuid, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_revoke_access(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_conversation_summaries(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ingestion_summary(uuid, timestamptz) TO service_role;

-- ------------------------------------------------------------ scoped reads
-- The server computes the reader's scope (src/lib/zalo-personal/dashboard/access.ts)
-- and passes it as three arrays; nothing outside it is ever returned:
--   p_full   connections the reader sees entirely (owner)
--   p_group  connections where the reader sees GROUP conversations only (read / manage grant)
--   p_ids    single conversations granted to the reader
-- Message time = coalesce(sent_at, received_at) (Zalo time, else worker receive time).
-- LIKE patterns arrive escaped by the server (\ % _).
CREATE OR REPLACE FUNCTION public.zp_dashboard_conversations(p_full uuid[], p_group uuid[], p_ids uuid[], p_connection_id uuid, p_type text, p_group_id uuid, p_name text, p_offset integer, p_limit integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_type text, external_conversation_id text, group_id uuid, group_name text, group_mode text, first_message_at timestamptz, last_message_at timestamptz, total_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT cv.id, cv.connection_id, cv.conversation_type, cv.external_conversation_id, cv.group_id, g.display_name, g.mode, cv.first_message_at, cv.last_message_at, count(*) OVER ()
  FROM public.zalo_personal_conversations cv
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
  WHERE (cv.connection_id = ANY (coalesce(p_full, '{}'))
         OR (cv.conversation_type = 'group' AND cv.connection_id = ANY (coalesce(p_group, '{}')))
         OR cv.id = ANY (coalesce(p_ids, '{}')))
    AND (p_connection_id IS NULL OR cv.connection_id = p_connection_id)
    AND (p_type IS NULL OR cv.conversation_type = p_type)
    AND (p_group_id IS NULL OR cv.group_id = p_group_id)
    AND (p_name IS NULL OR g.display_name ILIKE '%' || p_name || '%' OR cv.external_conversation_id = p_name)
  ORDER BY cv.last_message_at DESC NULLS LAST, cv.id
  OFFSET greatest(coalesce(p_offset, 0), 0)
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

-- One conversation's history, newest first, keyset paging (before = the last row shown).
CREATE OR REPLACE FUNCTION public.zp_dashboard_messages(p_conversation_id uuid, p_before_at timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE (id uuid, external_message_id text, sender_external_id text, message_type text, text_content text, content_stored boolean, text_length integer, mentions jsonb, mentions_self boolean, is_self boolean, sent_at timestamptz, received_at timestamptz, ingested_at timestamptz, processing_state text, message_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.id, m.external_message_id, m.sender_external_id, m.message_type, m.text_content, m.content_stored, m.text_length, m.mentions, m.mentions_self, m.is_self,
         m.sent_at, m.received_at, m.ingested_at, m.processing_state, coalesce(m.sent_at, m.received_at)
  FROM public.zalo_personal_messages m
  WHERE m.conversation_id = p_conversation_id
    AND (p_before_at IS NULL OR (coalesce(m.sent_at, m.received_at), m.id) < (p_before_at, p_before_id))
  ORDER BY coalesce(m.sent_at, m.received_at) DESC, m.id DESC
  LIMIT least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

-- Search inside the reader's scope. A time window is mandatory (the server caps it);
-- text only matches messages whose content was stored.
CREATE OR REPLACE FUNCTION public.zp_dashboard_search(p_full uuid[], p_group uuid[], p_ids uuid[], p_text text, p_conversation_id uuid, p_sender text, p_type text, p_from timestamptz, p_to timestamptz, p_limit integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, conversation_type text, external_conversation_id text, group_name text, external_message_id text, sender_external_id text, message_type text, text_content text, content_stored boolean, text_length integer, mentions jsonb, mentions_self boolean, is_self boolean, sent_at timestamptz, received_at timestamptz, message_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.id, m.connection_id, m.conversation_id, cv.conversation_type, cv.external_conversation_id, g.display_name, m.external_message_id, m.sender_external_id, m.message_type,
         m.text_content, m.content_stored, m.text_length, m.mentions, m.mentions_self, m.is_self, m.sent_at, m.received_at, coalesce(m.sent_at, m.received_at)
  FROM public.zalo_personal_messages m
  JOIN public.zalo_personal_conversations cv ON cv.id = m.conversation_id AND cv.connection_id = m.connection_id
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
  WHERE p_from IS NOT NULL AND p_to IS NOT NULL
    AND (cv.connection_id = ANY (coalesce(p_full, '{}'))
         OR (cv.conversation_type = 'group' AND cv.connection_id = ANY (coalesce(p_group, '{}')))
         OR cv.id = ANY (coalesce(p_ids, '{}')))
    AND coalesce(m.sent_at, m.received_at) >= p_from AND coalesce(m.sent_at, m.received_at) < p_to
    AND (p_text IS NULL OR (m.content_stored AND m.text_content ILIKE '%' || p_text || '%'))
    AND (p_conversation_id IS NULL OR m.conversation_id = p_conversation_id)
    AND (p_sender IS NULL OR m.sender_external_id = p_sender)
    AND (p_type IS NULL OR m.message_type = p_type)
  ORDER BY coalesce(m.sent_at, m.received_at) DESC, m.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- Overview counters inside the reader's scope.
CREATE OR REPLACE FUNCTION public.zp_dashboard_counts(p_full uuid[], p_group uuid[], p_ids uuid[], p_since timestamptz)
RETURNS TABLE (conversations bigint, messages_since bigint, last_message_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH visible AS (
    SELECT cv.id, cv.last_message_at
    FROM public.zalo_personal_conversations cv
    WHERE cv.connection_id = ANY (coalesce(p_full, '{}'))
       OR (cv.conversation_type = 'group' AND cv.connection_id = ANY (coalesce(p_group, '{}')))
       OR cv.id = ANY (coalesce(p_ids, '{}'))
  )
  SELECT (SELECT count(*) FROM visible),
         (SELECT count(*) FROM public.zalo_personal_messages m WHERE m.conversation_id IN (SELECT id FROM visible) AND m.ingested_at >= p_since),
         (SELECT max(last_message_at) FROM visible);
$$;

REVOKE EXECUTE ON FUNCTION public.zp_dashboard_conversations(uuid[], uuid[], uuid[], uuid, text, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_dashboard_messages(uuid, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_dashboard_search(uuid[], uuid[], uuid[], text, uuid, text, text, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_dashboard_counts(uuid[], uuid[], uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zp_dashboard_conversations(uuid[], uuid[], uuid[], uuid, text, uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_dashboard_messages(uuid, timestamptz, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_dashboard_search(uuid[], uuid[], uuid[], text, uuid, text, text, timestamptz, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_dashboard_counts(uuid[], uuid[], uuid[], timestamptz) TO service_role;
