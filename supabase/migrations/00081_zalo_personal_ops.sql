-- ============================================================
-- PHASE 07 — Zalo Personal production hardening & controlled auto-reply.
--
--  1. 1-1 content allowlist: direct_message_mode 'linked' = text is kept ONLY
--     for chats with a LINKED person (active identity on this connection) and
--     for a LINK <code> command. Everyone else: metadata only. 'content' (all
--     1-1 text) stays possible but is no longer the recommended mode.
--     content_stored now means "text actually stored" (was: "policy allowed",
--     even when the worker had stripped the text).
--  2. Reply modes: disabled | draft_only (drafts, NEVER sent) | manual_approval
--     | auto_reply_allowlist. Existing rows keep their behaviour:
--     off → disabled, draft_only (approve-then-send) → manual_approval,
--     auto → auto_reply_allowlist (+ auto_direct = all_linked, the owner's
--     2026-11-26 decision). New connections: draft_only, nothing sent.
--  3. Per-connection outbound switch send_enabled (default OFF; ON for a
--     connection that already delivered a reply) + separate auto scopes:
--     auto_direct off | allowlist | all_linked, auto_groups (default OFF).
--  4. Task reminders → Zalo through the SAME durable queue: drafts of kind
--     'reminder' (no inbound), idempotent per notification (source_key),
--     expiring (no stale catch-up after an outage), cancelled when the task
--     closed, status mirrored into notification_deliveries by a trigger.
--  5. Operations: health snapshot, alert state (one alert per state change,
--     no alert loop), last reply tick, 'ops_alert' web notifications.
-- Nothing here sends anything or switches a production flag on.
-- ============================================================

-- ---------------------------------------------------------------- 1. 1-1 content allowlist
ALTER TABLE public.zalo_personal_connections DROP CONSTRAINT IF EXISTS zalo_personal_connections_direct_message_mode_check;
ALTER TABLE public.zalo_personal_connections ADD CONSTRAINT zalo_personal_connections_direct_message_mode_check
  CHECK (direct_message_mode IN ('off', 'metadata', 'linked', 'content'));

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

    BEGIN
    INSERT INTO public.zalo_personal_ingestion_events AS ie (connection_id, worker_id, event_key, kind, conversation_type, outcome, occurred_at)
    VALUES (c.id, w.id, v_key, v_kind, v_type, 'ignored', v_occurred)
    ON CONFLICT (connection_id, event_key) DO UPDATE SET delivery_count = ie.delivery_count + 1, last_received_at = now()
    RETURNING id, (xmax = 0), outcome INTO v_event_id, v_inserted, v_prev_outcome;

    IF NOT v_inserted THEN
      v_results := v_results || jsonb_build_object('eventKey', v_key, 'status', 'duplicate', 'reason', v_prev_outcome);
      CONTINUE;
    END IF;

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
      -- 1-1 text: 'content' = everybody; 'linked' = only a chat with a LINKED
      -- person (either direction), or the LINK command of someone linking now
      v_keep_text := c.direct_message_mode = 'content'
        OR (c.direct_message_mode = 'linked' AND (
              EXISTS (SELECT 1 FROM public.ai_channel_identities i
                      WHERE i.connection_id = c.id AND i.external_user_id = v_ext AND i.status = 'active')
              OR (NOT coalesce((e->>'isSelf')::boolean, false) AND coalesce(e->>'text', '') ~* '^\s*link\s+[a-z2-9]{8}\s*$')));
    END IF;

    IF v_outcome IS NULL THEN
      INSERT INTO public.zalo_personal_conversations AS cv (connection_id, conversation_type, external_conversation_id, group_id, first_message_at, last_message_at)
      VALUES (c.id, v_type, v_ext, v_group_id, v_occurred, v_occurred)
      ON CONFLICT (connection_id, conversation_type, external_conversation_id)
        DO UPDATE SET last_message_at = greatest(cv.last_message_at, EXCLUDED.last_message_at)
      RETURNING id INTO v_conv_id;

      IF v_kind = 'message' THEN
        v_text := CASE WHEN v_keep_text THEN e->>'text' END;
        -- content_stored = the text really is stored (a worker in metadata mode sends none)
        INSERT INTO public.zalo_personal_messages (connection_id, conversation_id, external_message_id, sender_external_id, message_type, text_content, content_stored,
                                                   text_length, mentions, mentions_self, is_self, sent_at, received_at, ingestion_event_id)
        VALUES (c.id, v_conv_id, e->>'externalMessageId', e->>'senderId', e->>'messageType', v_text, v_text IS NOT NULL,
                coalesce((e->>'textLength')::integer, 0), coalesce(e->'mentions', '[]'::jsonb), coalesce((e->>'mentionsSelf')::boolean, false),
                (e->>'isSelf')::boolean, (e->>'sentAt')::timestamptz, v_occurred, v_event_id)
        ON CONFLICT ON CONSTRAINT ux_zalo_personal_messages_identity DO NOTHING
        RETURNING id INTO v_msg_id;
        IF v_msg_id IS NULL THEN
          v_outcome := 'stored'; v_reason := 'message_already_stored';
        ELSE
          v_outcome := 'stored';
          -- the worker stripped a 1-1 text the server would have kept: say so (diagnosable)
          IF v_keep_text AND v_text IS NULL AND coalesce((e->>'textLength')::integer, 0) > 0 THEN v_reason := 'text_not_sent'; END IF;
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

-- ---------------------------------------------------------------- 2-3. reply modes, send switch, auto scopes
ALTER TABLE public.zalo_personal_reply_settings DROP CONSTRAINT IF EXISTS zalo_personal_reply_settings_reply_mode_check;
UPDATE public.zalo_personal_reply_settings
SET reply_mode = CASE reply_mode WHEN 'off' THEN 'disabled' WHEN 'draft_only' THEN 'manual_approval' WHEN 'auto' THEN 'auto_reply_allowlist' ELSE reply_mode END;
ALTER TABLE public.zalo_personal_reply_settings ADD CONSTRAINT zalo_personal_reply_settings_reply_mode_check
  CHECK (reply_mode IN ('disabled', 'draft_only', 'manual_approval', 'auto_reply_allowlist'));
ALTER TABLE public.zalo_personal_reply_settings ALTER COLUMN reply_mode SET DEFAULT 'draft_only';

ALTER TABLE public.zalo_personal_reply_settings
  ADD COLUMN send_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_direct  text    NOT NULL DEFAULT 'off' CHECK (auto_direct IN ('off', 'allowlist', 'all_linked')),
  ADD COLUMN auto_groups  boolean NOT NULL DEFAULT false;

-- keep today's behaviour of existing connections (nothing is widened)
UPDATE public.zalo_personal_reply_settings st SET send_enabled = true
WHERE EXISTS (SELECT 1 FROM public.zalo_personal_reply_drafts d WHERE d.connection_id = st.connection_id AND d.status = 'sent');
UPDATE public.zalo_personal_reply_settings SET auto_direct = 'all_linked' WHERE reply_mode = 'auto_reply_allowlist';
UPDATE public.zalo_personal_reply_settings st SET auto_groups = true
WHERE reply_mode = 'auto_reply_allowlist'
  AND EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a JOIN public.zalo_personal_conversations cv ON cv.id = a.conversation_id
              WHERE a.connection_id = st.connection_id AND cv.conversation_type = 'group');

-- last reply tick (operations)
ALTER TABLE public.zalo_personal_reply_control
  ADD COLUMN last_tick_at     timestamptz,
  ADD COLUMN last_tick_status text CHECK (last_tick_status IS NULL OR last_tick_status IN ('ok', 'partial', 'error', 'disabled'));

-- ---------------------------------------------------------------- 4. reminders in the outbound queue
ALTER TABLE public.zalo_personal_reply_drafts ALTER COLUMN inbound_id DROP NOT NULL;
ALTER TABLE public.zalo_personal_reply_drafts ALTER COLUMN source_message_id DROP NOT NULL;
ALTER TABLE public.zalo_personal_reply_drafts DROP CONSTRAINT IF EXISTS zalo_personal_reply_drafts_kind_check;
ALTER TABLE public.zalo_personal_reply_drafts ADD CONSTRAINT zalo_personal_reply_drafts_kind_check
  CHECK (kind IN ('ai_answer', 'link_help', 'link_result', 'notice', 'reminder'));
ALTER TABLE public.zalo_personal_reply_drafts
  ADD COLUMN source_key      text UNIQUE CHECK (source_key IS NULL OR source_key ~ '^[A-Za-z0-9:_.-]{8,160}$'),
  ADD COLUMN notification_id uuid REFERENCES public.user_notifications(id) ON DELETE SET NULL;
-- a reply always answers one inbound message; a reminder never does (it has an idempotency key instead)
ALTER TABLE public.zalo_personal_reply_drafts ADD CONSTRAINT zalo_personal_reply_drafts_origin_check CHECK (
  CASE WHEN kind = 'reminder'
       THEN inbound_id IS NULL AND source_message_id IS NULL AND source_key IS NOT NULL AND conversation_type = 'user'
       ELSE inbound_id IS NOT NULL AND source_message_id IS NOT NULL END);

-- reminders enqueued by the Phase 06 engine (adapter "zalo_personal"). The
-- recipient is re-derived here from a verified identity — never from text.
CREATE OR REPLACE FUNCTION public.zp_reply_enqueue_reminder(p_connection_id uuid, p_user_id uuid, p_external_user_id text, p_text text, p_source_key text, p_notification_id uuid, p_expires_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_conv uuid;
  v_id uuid;
  v_text text := left(btrim(coalesce(p_text, '')), 1800);
BEGIN
  IF length(v_text) < 1 OR p_expires_at IS NULL OR p_expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.zalo_personal_connections WHERE id = p_connection_id AND status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'connection_disabled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ai_channel_identities i JOIN public.profiles p ON p.id = i.internal_user_id
                 WHERE i.connection_id = p_connection_id AND i.external_user_id = p_external_user_id AND i.internal_user_id = p_user_id
                   AND i.status = 'active' AND p.is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_verified');
  END IF;
  SELECT id INTO v_conv FROM public.zalo_personal_conversations
  WHERE connection_id = p_connection_id AND conversation_type = 'user' AND external_conversation_id = p_external_user_id;
  IF v_conv IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_conversation'); END IF;

  INSERT INTO public.zalo_personal_reply_drafts (connection_id, conversation_id, conversation_type, inbound_id, source_message_id, asker_external_id, asker_user_id,
                                                 audience, kind, pipeline, status, approval, approved_at, original_text, text, expires_at, source_key, notification_id)
  VALUES (p_connection_id, v_conv, 'user', NULL, NULL, p_external_user_id, p_user_id, 'private', 'reminder', 'none', 'queued', 'auto', now(),
          v_text, v_text, p_expires_at, p_source_key, p_notification_id)
  ON CONFLICT (source_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', true, 'draftId', NULL, 'duplicate', true); END IF;
  IF p_notification_id IS NOT NULL THEN
    INSERT INTO public.notification_deliveries (notification_id, channel, status, attempts) VALUES (p_notification_id, 'zalo_personal', 'pending', 0)
    ON CONFLICT (notification_id, channel) DO NOTHING;
  END IF;
  PERFORM public.zp_reply_log(p_connection_id, v_id, NULL, 'system', 'reminder.queued', NULL, 'queued', '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'draftId', v_id, 'duplicate', false);
END;
$$;

-- every status change of a reminder draft is mirrored into its delivery row
CREATE OR REPLACE FUNCTION public.zp_reply_sync_delivery()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text := CASE NEW.status WHEN 'queued' THEN 'pending' WHEN 'sending' THEN 'sending' WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed'
                                   WHEN 'delivery_unknown' THEN 'unknown' ELSE 'skipped' END;
  v_reason text := CASE WHEN NEW.status = 'expired' THEN 'expired'
                        WHEN NEW.error_category IS NOT NULL THEN left(regexp_replace(lower(NEW.error_category), '[^a-z_]', '_', 'g'), 64) END;
BEGIN
  UPDATE public.notification_deliveries
  SET status = v_status, reason = v_reason, provider_message_id = CASE WHEN NEW.status = 'sent' THEN NEW.zalo_msg_id ELSE provider_message_id END,
      attempts = least(NEW.attempts, 20)
  WHERE notification_id = NEW.notification_id AND channel = 'zalo_personal';
  RETURN NEW;
END;
$$;
CREATE TRIGGER zp_reply_drafts_sync_delivery AFTER UPDATE OF status ON public.zalo_personal_reply_drafts
  FOR EACH ROW WHEN (NEW.notification_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.zp_reply_sync_delivery();

-- ---------------------------------------------------------------- scan: 'disabled' instead of 'off'
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
    WHERE c.status = 'active' AND c.zalo_account_id IS NOT NULL AND st.reply_mode <> 'disabled'
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

-- ---------------------------------------------------------------- store result: auto scopes
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
  v_allowlisted boolean;
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
  IF d ->> 'kind' = 'reminder' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind'); END IF;

  SELECT * INTO st FROM public.zalo_personal_reply_settings WHERE connection_id = i.connection_id;
  SELECT c.conversation_type, g.mode AS group_mode, g.consent_status, g.send_verified_at INTO cv
  FROM public.zalo_personal_conversations c LEFT JOIN public.zalo_personal_groups g ON g.id = c.group_id WHERE c.id = i.conversation_id;
  v_allowlisted := EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a WHERE a.conversation_id = i.conversation_id);

  v_auto := coalesce((d ->> 'autoApprove')::boolean, false)
            AND st.reply_mode = 'auto_reply_allowlist'
            AND CASE WHEN cv.conversation_type = 'group'
                     THEN st.auto_groups AND v_allowlisted
                          AND d ->> 'kind' = 'ai_answer' AND (d ->> 'askerUserId') IS NOT NULL
                          AND cv.group_mode = 'interactive' AND cv.consent_status = 'granted' AND cv.send_verified_at IS NOT NULL
                     ELSE (st.auto_direct = 'all_linked' OR (st.auto_direct = 'allowlist' AND v_allowlisted))
                          AND d ->> 'kind' IN ('ai_answer', 'notice', 'link_result')
                          AND (d ->> 'kind' <> 'ai_answer' OR (d ->> 'askerUserId') IS NOT NULL)
                          AND EXISTS (SELECT 1 FROM public.zalo_personal_reply_drafts x WHERE x.connection_id = i.connection_id AND x.approval = 'manual' AND x.status = 'sent')
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

-- ---------------------------------------------------------------- reviewer actions: draft_only never sends
CREATE OR REPLACE FUNCTION public.zp_reply_act(p_actor uuid, p_draft_id uuid, p_action text, p_version integer, p_text text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  d public.zalo_personal_reply_drafts%ROWTYPE;
  v_mode text;
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
    SELECT reply_mode INTO v_mode FROM public.zalo_personal_reply_settings WHERE connection_id = d.connection_id;
    IF v_mode IS NULL OR v_mode IN ('disabled', 'draft_only') THEN RETURN jsonb_build_object('ok', false, 'error', 'mode_no_send'); END IF;
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
    UPDATE public.zalo_personal_reply_drafts SET status = v_to, error_category = coalesce(error_category, 'operator_cancelled'), version = version + 1 WHERE id = d.id;
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

-- ---------------------------------------------------------------- claim (last-moment gates)
-- Signature change (+ p_reminders_enabled): the old one is dropped.
DROP FUNCTION IF EXISTS public.zp_reply_claim_outbound(uuid, text, integer, integer, boolean);
CREATE OR REPLACE FUNCTION public.zp_reply_claim_outbound(p_worker_id uuid, p_account_id text, p_lease_seconds integer, p_global_daily_cap integer, p_auto_enabled boolean, p_reminders_enabled boolean)
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
  v_allowlisted boolean;
BEGIN
  IF (SELECT emergency_stop FROM public.zalo_personal_reply_control WHERE id = 1) THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'emergency_stop');
  END IF;
  SELECT * INTO w FROM public.zalo_personal_workers WHERE id = p_worker_id;
  IF NOT FOUND OR w.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'worker_revoked'); END IF;
  SELECT * INTO c FROM public.zalo_personal_connections WHERE id = w.connection_id;
  IF c.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'error', 'connection_disabled'); END IF;
  IF c.zalo_account_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_bound'); END IF;
  IF p_account_id IS DISTINCT FROM c.zalo_account_id THEN RETURN jsonb_build_object('ok', false, 'error', 'account_mismatch'); END IF;
  SELECT * INTO st FROM public.zalo_personal_reply_settings WHERE connection_id = c.id;
  IF NOT FOUND OR NOT st.send_enabled THEN RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'connection_send_off'); END IF;
  IF st.send_paused THEN RETURN jsonb_build_object('ok', true, 'job', NULL, 'reason', 'send_paused'); END IF;

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

    IF d.kind = 'reminder' THEN
      -- channel switched off (ZALO_NOTIFY_PERSONAL_ENABLED / kill switch) or the task closed since → never sent
      IF NOT coalesce(p_reminders_enabled, false) THEN v_cancel := 'channel_disabled';
      ELSIF EXISTS (SELECT 1 FROM public.user_notifications n JOIN public.ai_tasks t ON t.id = n.task_id
                    WHERE n.id = d.notification_id AND t.status IN ('completed', 'dismissed', 'cancelled')) THEN v_cancel := 'task_closed';
      END IF;
    ELSE
      IF st.reply_mode IN ('disabled', 'draft_only') THEN
        v_hold := 'mode_no_send';
      ELSIF d.conversation_type = 'group' THEN
        IF d.group_consent IS DISTINCT FROM 'granted' OR d.group_mode IS NULL OR d.group_mode NOT IN ('mention_only', 'interactive') THEN v_cancel := 'group_not_allowed'; END IF;
        IF v_cancel IS NULL AND d.approval = 'auto' AND d.group_mode <> 'interactive' THEN v_cancel := 'auto_not_allowed'; END IF;
      ELSIF NOT st.direct_enabled THEN
        v_cancel := 'direct_disabled';
      END IF;
      IF v_cancel IS NULL AND v_hold IS NULL AND d.approval = 'auto' THEN
        v_allowlisted := EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a WHERE a.conversation_id = d.conversation_id);
        IF NOT coalesce(p_auto_enabled, false) OR st.reply_mode <> 'auto_reply_allowlist'
           OR (d.conversation_type = 'group' AND (NOT st.auto_groups OR NOT v_allowlisted))
           OR (d.conversation_type <> 'group' AND (st.auto_direct = 'off' OR (st.auto_direct = 'allowlist' AND NOT v_allowlisted)
                                                   OR d.kind NOT IN ('ai_answer', 'notice', 'link_result'))) THEN
          v_cancel := 'auto_not_allowed';
        END IF;
      END IF;
    END IF;
    IF v_cancel IS NULL AND v_hold IS NULL AND EXISTS (SELECT 1 FROM public.zalo_personal_reply_blocks b WHERE b.connection_id = c.id AND b.external_user_id = d.asker_external_id) THEN
      v_cancel := 'sender_blocked';
    END IF;
    IF v_cancel IS NULL AND v_hold IS NULL AND d.asker_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.ai_channel_identities ci JOIN public.profiles p ON p.id = ci.internal_user_id
        WHERE ci.connection_id = c.id AND ci.external_user_id = d.asker_external_id AND ci.status = 'active'
          AND ci.internal_user_id = d.asker_user_id AND p.is_active) THEN
      v_cancel := 'asker_not_authorized';
    END IF;
    IF v_cancel IS NULL AND v_hold IS NULL AND d.approval = 'manual' AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = d.approved_by AND p.is_active) THEN
      v_cancel := 'approver_inactive';
    END IF;
    IF v_cancel IS NOT NULL THEN
      UPDATE public.zalo_personal_reply_drafts SET status = 'cancelled', error_category = v_cancel, version = version + 1 WHERE id = d.id;
      PERFORM public.zp_reply_log(c.id, d.id, NULL, 'system', 'outbound.cancelled', 'queued', 'cancelled', jsonb_build_object('reason', v_cancel));
      CONTINUE;
    END IF;

    IF v_hold IS NULL AND EXISTS (SELECT 1 FROM public.zalo_personal_reply_drafts x WHERE x.conversation_id = d.conversation_id AND x.id <> d.id
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

-- ---------------------------------------------------------------- admin: new settings + 1-1 content mode
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
      send_enabled = coalesce((v ->> 'sendEnabled')::boolean, send_enabled),
      auto_direct = coalesce(v ->> 'autoDirect', auto_direct),
      auto_groups = coalesce((v ->> 'autoGroups')::boolean, auto_groups),
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
    -- narrowing auto (mode / scopes) cancels the auto drafts that did not leave yet
    UPDATE public.zalo_personal_reply_drafts d SET status = 'cancelled', error_category = 'auto_not_allowed', version = version + 1
    FROM public.zalo_personal_reply_settings st
    WHERE st.connection_id = p_connection_id AND d.connection_id = p_connection_id AND d.status = 'queued' AND d.approval = 'auto' AND d.kind <> 'reminder'
      AND (st.reply_mode <> 'auto_reply_allowlist' OR (d.conversation_type = 'group' AND NOT st.auto_groups) OR (d.conversation_type = 'user' AND st.auto_direct = 'off'));
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'settings.saved', NULL, NULL, v - 'note');
  ELSIF p_action = 'set_direct_mode' THEN
    UPDATE public.zalo_personal_connections SET direct_message_mode = v ->> 'directMessageMode' WHERE id = p_connection_id;
    PERFORM public.zp_reply_log(p_connection_id, NULL, p_actor, 'user', 'connection.direct_mode', NULL, NULL, jsonb_build_object('mode', v ->> 'directMessageMode'));
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
    UPDATE public.zalo_personal_reply_drafts SET status = 'cancelled', error_category = 'auto_not_allowed', version = version + 1
    WHERE conversation_id = (v ->> 'conversationId')::uuid AND status = 'queued' AND approval = 'auto' AND kind <> 'reminder';
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

-- ---------------------------------------------------------------- 5. operations
ALTER TABLE public.user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE public.user_notifications ADD CONSTRAINT user_notifications_kind_check
  CHECK (kind IN ('mention', 'task_confirmation', 'deadline_proposal', 'deadline_day', 'deadline_hour', 'overdue', 'overdue_digest', 'morning_digest', 'ops_alert'));

-- one row per connection: the last computed health + what was already alerted
CREATE TABLE public.zalo_personal_ops_state (
  connection_id    uuid        PRIMARY KEY REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  state            text        NOT NULL CHECK (state IN ('healthy', 'degraded', 'disconnected', 'authentication_required', 'stopped', 'unknown')),
  reasons          text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(reasons) <= 20),
  since            timestamptz NOT NULL DEFAULT now(),
  notified_state   text,
  notified_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zalo_personal_ops_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zalo_personal_ops_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zalo_personal_ops_state TO service_role;

-- Records the computed state. Alerts the connection OWNER on a change into a
-- bad state (and once on recovery) — at most one alert per state per 6 hours:
-- a flapping worker cannot flood the inbox (no alert loop).
CREATE OR REPLACE FUNCTION public.zp_ops_observe(p_connection_id uuid, p_state text, p_reasons text[])
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  s public.zalo_personal_ops_state%ROWTYPE;
  c record;
  v_bad boolean := p_state IN ('degraded', 'disconnected', 'authentication_required');
  v_notify boolean := false;
  v_title text;
BEGIN
  SELECT id, owner_user_id, connection_key INTO c FROM public.zalo_personal_connections WHERE id = p_connection_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  INSERT INTO public.zalo_personal_ops_state (connection_id, state, reasons) VALUES (p_connection_id, p_state, coalesce(p_reasons[1:20], '{}'))
  ON CONFLICT (connection_id) DO NOTHING;
  SELECT * INTO s FROM public.zalo_personal_ops_state WHERE connection_id = p_connection_id FOR UPDATE;
  UPDATE public.zalo_personal_ops_state
  SET state = p_state, reasons = coalesce(p_reasons[1:20], '{}'), since = CASE WHEN s.state = p_state THEN s.since ELSE now() END, updated_at = now()
  WHERE connection_id = p_connection_id;

  IF v_bad AND (s.notified_state IS DISTINCT FROM p_state OR s.notified_at < now() - interval '6 hours') THEN
    v_notify := true;
    v_title := CASE p_state WHEN 'authentication_required' THEN 'Zalo cá nhân ' || c.connection_key || ': cần đăng nhập lại'
                            WHEN 'disconnected' THEN 'Zalo cá nhân ' || c.connection_key || ': worker mất kết nối'
                            ELSE 'Zalo cá nhân ' || c.connection_key || ': hoạt động không ổn định' END;
  ELSIF p_state = 'healthy' AND s.notified_state IN ('degraded', 'disconnected', 'authentication_required') THEN
    v_notify := true;
    v_title := 'Zalo cá nhân ' || c.connection_key || ': đã hoạt động bình thường trở lại';
  END IF;
  IF v_notify THEN
    INSERT INTO public.user_notifications (user_id, kind, title, body, connection_id, link, dedupe_key)
    VALUES (c.owner_user_id, 'ops_alert', left(v_title, 200), left(array_to_string(coalesce(p_reasons[1:10], '{}'), ', '), 2000), p_connection_id,
            '/apps/zalo/personal/operations', 'ops:' || p_connection_id || ':' || p_state || ':' || to_char(now(), 'YYYYMMDDHH24'))
    ON CONFLICT (dedupe_key) DO NOTHING;
    UPDATE public.zalo_personal_ops_state SET notified_state = p_state, notified_at = now() WHERE connection_id = p_connection_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'notified', v_notify);
END;
$$;

CREATE OR REPLACE FUNCTION public.zp_reply_record_tick(p_status text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.zalo_personal_reply_control SET last_tick_at = now(), last_tick_status = p_status WHERE id = 1;
$$;

-- Everything the operations page / health evaluation reads, in one call.
-- Counts and timestamps only: no message text, no secret, no Zalo id.
CREATE OR REPLACE FUNCTION public.zp_ops_snapshot(p_connection_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'now', now(),
    'control', (SELECT jsonb_build_object('emergencyStop', emergency_stop, 'lastTickAt', last_tick_at, 'lastTickStatus', last_tick_status) FROM public.zalo_personal_reply_control WHERE id = 1),
    'connections', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'key', c.connection_key, 'status', c.status, 'directMessageMode', c.direct_message_mode, 'accountBound', c.zalo_account_id IS NOT NULL,
        'lastHeartbeatAt', c.last_heartbeat_at, 'lastConnectedAt', c.last_connected_at, 'lastErrorCategory', c.last_error_category,
        'sync', (SELECT jsonb_build_object('sessionState', ss.session_state, 'listenerState', ss.listener_state, 'lastHeartbeatAt', ss.last_heartbeat_at,
                                           'lastMessageReceivedAt', ss.last_message_received_at, 'lastDeliveryOkAt', ss.last_delivery_ok_at, 'lastIngestedAt', ss.last_ingested_at,
                                           'outboxDepth', ss.outbox_depth, 'deadLetters', ss.dead_letter_count, 'lastErrorCategory', ss.last_error_category, 'workerVersion', ss.worker_version)
                 FROM public.zalo_personal_sync_state ss JOIN public.zalo_personal_workers w ON w.id = ss.worker_id
                 WHERE ss.connection_id = c.id AND w.status = 'active' ORDER BY ss.last_heartbeat_at DESC NULLS LAST LIMIT 1),
        'settings', (SELECT jsonb_build_object('replyMode', st.reply_mode, 'sendEnabled', st.send_enabled, 'autoDirect', st.auto_direct, 'autoGroups', st.auto_groups,
                                               'sendPaused', st.send_paused, 'pausedReason', st.paused_reason, 'dailySendLimit', st.daily_send_limit)
                     FROM public.zalo_personal_reply_settings st WHERE st.connection_id = c.id),
        'lastScanAt', (SELECT s.last_scan_at FROM public.zalo_personal_reply_scan_state s WHERE s.connection_id = c.id),
        'lastInboundAt', (SELECT max(i.created_at) FROM public.zalo_personal_reply_inbound i WHERE i.connection_id = c.id),
        'outbound', (SELECT jsonb_build_object(
            'pendingApproval', count(*) FILTER (WHERE d.status = 'pending_approval'),
            'queued', count(*) FILTER (WHERE d.status = 'queued'),
            'sending', count(*) FILTER (WHERE d.status = 'sending'),
            'unknown', count(*) FILTER (WHERE d.status = 'delivery_unknown'),
            'failed24h', count(*) FILTER (WHERE d.status = 'failed' AND d.updated_at > now() - interval '24 hours'),
            'sentToday', count(*) FILTER (WHERE d.status IN ('sent', 'sending', 'delivery_unknown') AND coalesce(d.sent_at, d.sending_started_at) >= public.zp_reply_vn_day_start()),
            'remindersQueued', count(*) FILTER (WHERE d.kind = 'reminder' AND d.status = 'queued'),
            'lastSentAt', max(d.sent_at))
          FROM public.zalo_personal_reply_drafts d WHERE d.connection_id = c.id),
        'groups', (SELECT jsonb_build_object('total', count(*), 'mentionOnly', count(*) FILTER (WHERE g.mode = 'mention_only'), 'interactive', count(*) FILTER (WHERE g.mode = 'interactive'),
                                             'allowlisted', (SELECT count(*) FROM public.zalo_personal_reply_allowlist a JOIN public.zalo_personal_conversations cv ON cv.id = a.conversation_id
                                                             WHERE a.connection_id = c.id AND cv.conversation_type = 'group'))
                   FROM public.zalo_personal_groups g WHERE g.connection_id = c.id),
        'directAllowlisted', (SELECT count(*) FROM public.zalo_personal_reply_allowlist a JOIN public.zalo_personal_conversations cv ON cv.id = a.conversation_id
                              WHERE a.connection_id = c.id AND cv.conversation_type = 'user'),
        'linkedUsers', (SELECT count(*) FROM public.ai_channel_identities i WHERE i.connection_id = c.id AND i.status = 'active'),
        'ops', (SELECT jsonb_build_object('state', o.state, 'since', o.since, 'notifiedState', o.notified_state, 'notifiedAt', o.notified_at)
                FROM public.zalo_personal_ops_state o WHERE o.connection_id = c.id)
      ) ORDER BY c.created_at) FROM public.zalo_personal_connections c WHERE c.id = ANY (p_connection_ids)), '[]'::jsonb),
    -- Gemini of the Zalo assistant (Phase 04 / 05 / 06) books every call in ai_request_usage
    'ai', (SELECT jsonb_build_object(
        'requests24h', count(*) FILTER (WHERE u.status IN ('completed', 'failed', 'cache_hit')),
        'completed24h', count(*) FILTER (WHERE u.status IN ('completed', 'cache_hit')),
        'quotaErrors24h', count(*) FILTER (WHERE u.reason IN ('quota_exceeded', 'rate_limit', 'budget_exceeded', 'budget')),
        'otherErrors24h', count(*) FILTER (WHERE u.status = 'failed' AND coalesce(u.reason, '') NOT IN ('quota_exceeded', 'rate_limit', 'budget_exceeded', 'budget')),
        'refused24h', count(*) FILTER (WHERE u.status IN ('rejected', 'skipped')),
        'inputTokens24h', coalesce(sum(u.input_tokens), 0), 'outputTokens24h', coalesce(sum(u.output_tokens), 0),
        'providers', coalesce(array_agg(DISTINCT u.provider), '{}'),
        'lastOkAt', max(u.created_at) FILTER (WHERE u.status = 'completed'), 'lastErrorAt', max(u.created_at) FILTER (WHERE u.status = 'failed'),
        'lastErrorReason', (SELECT x.reason FROM public.ai_request_usage x WHERE x.status = 'failed' ORDER BY x.created_at DESC LIMIT 1))
      FROM public.ai_request_usage u WHERE u.created_at > now() - interval '24 hours'),
    'reminders', jsonb_build_object(
        'health', public.ai_task_health(now() - interval '24 hours'),
        'zaloDeliveries24h', (SELECT coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) FROM (
            SELECT nd.status, count(*) AS n FROM public.notification_deliveries nd WHERE nd.channel = 'zalo_personal' AND nd.created_at > now() - interval '24 hours' GROUP BY nd.status) x))
  );
$$;

-- ---------------------------------------------------------------- privileges (cloud has no default grants)
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'zp_ingest_events(uuid, text, jsonb)',
    'zp_reply_enqueue_reminder(uuid, uuid, text, text, text, uuid, timestamptz)',
    'zp_reply_scan_claim(text, integer, integer, integer)',
    'zp_reply_store_result(uuid, text, jsonb)',
    'zp_reply_act(uuid, uuid, text, integer, text, text)',
    'zp_reply_claim_outbound(uuid, text, integer, integer, boolean, boolean)',
    'zp_reply_admin(uuid, text, uuid, jsonb)',
    'zp_ops_observe(uuid, text, text[])',
    'zp_reply_record_tick(text)',
    'zp_ops_snapshot(uuid[])'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.zp_reply_sync_delivery() FROM PUBLIC, anon, authenticated;
