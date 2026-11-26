-- ============================================================
-- PHASE 04.5.1 — realtime + 1-1 auto-reply without the review inbox.
--
-- Owner decision (2026-11-26): an 'auto' connection (system flag
-- PERSONAL_AUTO_REPLY_ENABLED + reply_mode = 'auto') sends WITHOUT approval:
--   1-1    every chat of a LINKED user — no allowlist. Kinds: ai_answer (linked
--          asker, any status), notice, link_result (fixed templates). Never
--          link_help: strangers are not answered in auto mode. The sending
--          path must be verified for the CONNECTION (one manually approved
--          reply delivered by it) instead of per chat.
--   group  unchanged: allowlisted + interactive + send verified + answered.
-- Re-checked in both places, as before: zp_reply_store_result (at draft
-- time) and zp_reply_claim_outbound (at the last moment before a send).
-- Also: cooldown minimum 10 → 5 s (= the worker's minimum send interval).
--
-- Rollback (behaviour): reply_mode back to 'draft_only' (dashboard) or the
-- flag off — every new draft waits for approval again and queued auto drafts
-- are cancelled at claim. Full rollback: docs/zalo-ai/phase-04-5-rollback.sql.
-- ============================================================

-- ---------------------------------------------------------------- cooldown floor
ALTER TABLE public.zalo_personal_reply_settings DROP CONSTRAINT IF EXISTS zalo_personal_reply_settings_cooldown_seconds_check;
ALTER TABLE public.zalo_personal_reply_settings ADD CONSTRAINT zalo_personal_reply_settings_cooldown_seconds_check CHECK (cooldown_seconds BETWEEN 5 AND 3600);

-- ---------------------------------------------------------------- inbound context
-- directVerified now = the CONNECTION delivered one manually approved reply.
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
    'directVerified', EXISTS (SELECT 1 FROM public.zalo_personal_reply_drafts x WHERE x.connection_id = i.connection_id AND x.approval = 'manual' AND x.status = 'sent'),
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

-- ---------------------------------------------------------------- store result
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
            AND CASE WHEN cv.conversation_type = 'group'
                     THEN d ->> 'kind' = 'ai_answer'
                          AND (d ->> 'askerUserId') IS NOT NULL
                          AND EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a WHERE a.conversation_id = i.conversation_id)
                          AND cv.group_mode = 'interactive' AND cv.consent_status = 'granted' AND cv.send_verified_at IS NOT NULL
                     -- 1-1: fixed templates or the linked asker's answer; the connection's sending path verified once by hand
                     ELSE d ->> 'kind' IN ('ai_answer', 'notice', 'link_result')
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

-- ---------------------------------------------------------------- claim (last-moment gates)
-- Same as 00079 except the auto re-check: the allowlist is required for
-- GROUPS only; a 1-1 auto draft must be one of the 1-1 auto kinds.
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
        OR (d.conversation_type = 'group' AND NOT EXISTS (SELECT 1 FROM public.zalo_personal_reply_allowlist a WHERE a.conversation_id = d.conversation_id))
        OR (d.conversation_type <> 'group' AND d.kind NOT IN ('ai_answer', 'notice', 'link_result'))) THEN
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

-- ---------------------------------------------------------------- privileges (cloud has no default grants)
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'zp_reply_inbound_context(uuid)',
    'zp_reply_store_result(uuid, text, jsonb)',
    'zp_reply_claim_outbound(uuid, text, integer, integer, boolean)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
