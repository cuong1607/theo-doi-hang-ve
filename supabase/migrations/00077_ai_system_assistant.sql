-- ============================================================
-- PHASE 05 — Central AI System Assistant (read-only business tools).
--
--   1. ai_request_usage (00075) also records the system assistant's provider
--      calls: channel web / zalo_oa, features system_plan / system_answer.
--      ONE budget for every Gemini call (same key, same quota):
--      ai_system_reserve() delegates to zp_ai_reserve() — same advisory lock,
--      same limits — and only labels the reserved row with its channel.
--   2. ai_system_requests / ai_system_tool_calls — audit of every question and
--      every tool call (who, channel, audience, tool, outcome, row count). No
--      question text, no answer, no figures: only metadata.
--   3. ai_channel_identities / ai_identity_link_codes — Zalo Personal sender ↔
--      internal user, created ONLY by consuming a one-time code the user made
--      while logged in. Zalo OA keeps its own zalo_user_links (00069).
--
-- Nothing here writes business data. Tables: RLS on, no anon / authenticated
-- access; functions: service_role only (cloud has no default EXECUTE grants).
-- ============================================================

-- ------------------------------------------------------------ 1. usage
ALTER TABLE public.ai_request_usage DROP CONSTRAINT IF EXISTS ai_request_usage_channel_check;
ALTER TABLE public.ai_request_usage ADD CONSTRAINT ai_request_usage_channel_check CHECK (channel IN ('zalo_personal', 'web', 'zalo_oa'));
ALTER TABLE public.ai_request_usage DROP CONSTRAINT IF EXISTS ai_request_usage_feature_check;
ALTER TABLE public.ai_request_usage ADD CONSTRAINT ai_request_usage_feature_check CHECK (feature IN ('ask', 'summarize', 'system_plan', 'system_answer'));

CREATE OR REPLACE FUNCTION public.ai_system_reserve(
  p_user uuid, p_channel text, p_feature text, p_provider text, p_model text, p_estimated integer, p_day_start timestamptz,
  p_max_user_day integer, p_max_day integer, p_max_minute integer, p_cooldown_minutes integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('web', 'zalo_oa', 'zalo_personal') OR p_feature IS NULL OR p_feature NOT IN ('system_plan', 'system_answer') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  -- the SAME reservation as Phase 04 (lock + global / user / minute / cooldown limits)
  v := public.zp_ai_reserve(p_user, p_feature, p_provider, p_model, p_estimated, p_day_start, p_max_user_day, p_max_day, p_max_minute, p_cooldown_minutes);
  IF coalesce((v ->> 'ok')::boolean, false) THEN
    UPDATE public.ai_request_usage SET channel = p_channel WHERE id = (v ->> 'id')::uuid;
  END IF;
  RETURN v;
END;
$$;

-- ------------------------------------------------------------ 2. audit
CREATE TABLE public.ai_system_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = the channel identity could not be resolved to an internal user
  user_id      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  channel      text        NOT NULL CHECK (channel IN ('web', 'zalo_oa', 'zalo_personal')),
  audience     text        NOT NULL CHECK (audience IN ('private', 'group')),
  status       text        NOT NULL CHECK (status IN ('answered', 'insufficient', 'denied', 'unsupported', 'clarify', 'refused', 'error', 'rate_limited')),
  planner      text        NOT NULL CHECK (planner IN ('gemini', 'rules', 'none')),
  synthesis    text        NOT NULL CHECK (synthesis IN ('gemini', 'formatter', 'none')),
  reason       text        CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
  tools        text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(tools) <= 10),
  duration_ms  integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_system_requests_user_time ON public.ai_system_requests (user_id, created_at DESC);
CREATE INDEX idx_ai_system_requests_time ON public.ai_system_requests (created_at DESC);

CREATE TABLE public.ai_system_tool_calls (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid        NOT NULL REFERENCES public.ai_system_requests(id) ON DELETE CASCADE,
  user_id      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  tool         text        NOT NULL CHECK (tool ~ '^[a-z_]{3,64}$'),
  sensitivity  text        NOT NULL CHECK (sensitivity IN ('knowledge', 'operational', 'financial')),
  outcome      text        NOT NULL CHECK (outcome IN ('ok', 'empty', 'denied', 'invalid_args', 'not_found', 'ambiguous', 'unavailable', 'timeout', 'error')),
  -- resolved scope only (period, ids, flags) — never figures, never free text
  scope        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object' AND octet_length(scope::text) <= 2000),
  row_count    integer     NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  duration_ms  integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_system_tool_calls_request ON public.ai_system_tool_calls (request_id);
CREATE INDEX idx_ai_system_tool_calls_time ON public.ai_system_tool_calls (created_at DESC);

-- ------------------------------------------------------------ 3. identity mapping (Zalo Personal)
CREATE TABLE public.ai_channel_identities (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           text        NOT NULL CHECK (channel = 'zalo_personal'),
  connection_id     uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  external_user_id  text        NOT NULL CHECK (external_user_id ~ '^[0-9]{1,32}$'),
  internal_user_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  verified_via      text        NOT NULL CHECK (verified_via = 'link_code'),
  linked_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
-- one ACTIVE mapping per Zalo sender per connection (history kept as revoked rows)
CREATE UNIQUE INDEX uq_ai_channel_identities_active ON public.ai_channel_identities (connection_id, external_user_id) WHERE status = 'active';
CREATE INDEX idx_ai_channel_identities_user ON public.ai_channel_identities (internal_user_id);

CREATE TABLE public.ai_identity_link_codes (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash              text        NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  channel                text        NOT NULL CHECK (channel = 'zalo_personal'),
  internal_user_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  used_at                timestamptz,
  used_connection_id     uuid        REFERENCES public.zalo_personal_connections(id) ON DELETE SET NULL,
  used_external_user_id  text        CHECK (used_external_user_id IS NULL OR used_external_user_id ~ '^[0-9]{1,32}$'),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '1 hour')
);
CREATE INDEX idx_ai_identity_link_codes_user ON public.ai_identity_link_codes (internal_user_id, created_at DESC);

-- Atomic: an unexpired, unused code of an ACTIVE profile → (re)links the sender of
-- that connection. A previous active mapping of the same sender is revoked first.
CREATE OR REPLACE FUNCTION public.ai_identity_consume_code(p_code_hash text, p_channel text, p_connection_id uuid, p_external_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_code public.ai_identity_link_codes%ROWTYPE;
  v_active boolean;
BEGIN
  IF p_channel IS DISTINCT FROM 'zalo_personal' OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_external_user_id !~ '^[0-9]{1,32}$' OR p_connection_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;
  SELECT * INTO v_code FROM public.ai_identity_link_codes
  WHERE code_hash = p_code_hash AND channel = p_channel AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;
  SELECT is_active INTO v_active FROM public.profiles WHERE id = v_code.internal_user_id;
  IF NOT coalesce(v_active, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_inactive');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.zalo_personal_connections WHERE id = p_connection_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;
  UPDATE public.ai_identity_link_codes SET used_at = now(), used_connection_id = p_connection_id, used_external_user_id = p_external_user_id WHERE id = v_code.id;
  UPDATE public.ai_channel_identities SET status = 'revoked', revoked_at = now()
  WHERE connection_id = p_connection_id AND external_user_id = p_external_user_id AND status = 'active';
  INSERT INTO public.ai_channel_identities (channel, connection_id, external_user_id, internal_user_id, verified_via)
  VALUES (p_channel, p_connection_id, p_external_user_id, v_code.internal_user_id, 'link_code');
  RETURN jsonb_build_object('ok', true, 'internal_user_id', v_code.internal_user_id);
END;
$$;

-- ------------------------------------------------------------ privileges
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_system_requests', 'ai_system_tool_calls', 'ai_channel_identities', 'ai_identity_link_codes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_system_reserve(uuid, text, text, text, text, integer, timestamptz, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_identity_consume_code(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_system_reserve(uuid, text, text, text, text, integer, timestamptz, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_identity_consume_code(text, text, uuid, text) TO service_role;
