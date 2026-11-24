-- ============================================================
-- ZALO PERSONAL — Phase 04: AI (Gemini) + conversation memory + search.
-- Additive only. No existing table, column, constraint or function is changed:
-- 00073 / 00074 keep their behaviour; Zalo OA (zalo_*), the OA / Web assistant
-- (ai_conversations, ai_messages, ai_usage_logs, ai_analysis_cache) are untouched.
--
-- Memory layers (docs/zalo-ai/phase-04-ai-memory.md):
--   A raw messages      zalo_personal_messages (Phase 02) — the source of truth,
--                       NOT copied; + a full-text index (accent-insensitive)
--   B summaries         ai_conversation_summaries   (+ ai_memory_sources)
--   C structured facts  ai_memory_facts             (+ ai_memory_sources)
--   Ask AI history      ai_assistant_sessions / ai_assistant_turns (per user)
--   budget + audit      ai_request_usage (counts, never prompt / answer text)
--
-- Namespaces: summaries / facts carry namespace IN ('personal_direct',
-- 'personal_group') — the DB refuses any other channel's memory here, so Web /
-- OA history can never land in (or be read from) these tables by mistake.
-- No ai_processing_jobs table: Phase 04 has no background AI job (summaries are
-- made on request only).
--
-- Same access model as 00073 / 00074: RLS on, nothing granted to anon /
-- authenticated, service_role only; the application authorizes every read
-- (src/lib/zalo-personal/ai). After `db push`: NOTIFY pgrst, 'reload schema'.
-- ============================================================

-- ------------------------------------------------------------ Vietnamese folding
-- Lower-case, drop combining marks (NFD input), map precomposed Vietnamese
-- letters to ASCII, đ → d. MUST equal foldVi() in src/lib/ai-assistant/text.ts
-- (parity checked by the integration test).
CREATE OR REPLACE FUNCTION public.zp_fold(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT translate(
    lower(regexp_replace(coalesce(p_text, ''), '[̀-ͯ]', '', 'g')),
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
  );
$$;

-- Full-text search on folded text ('simple' config: Vietnamese words are
-- space-separated syllables, no stemming wanted). Only rows whose content is stored.
CREATE INDEX idx_zalo_personal_messages_fts ON public.zalo_personal_messages
  USING gin (to_tsvector('simple'::regconfig, public.zp_fold(text_content)))
  WHERE content_stored AND text_content IS NOT NULL;

-- ------------------------------------------------------------ Ask AI sessions (per user)
CREATE TABLE public.ai_assistant_sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- where the session lives; never shared with Web / OA conversation threads
  surface     text        NOT NULL DEFAULT 'zalo_personal_dashboard' CHECK (surface IN ('zalo_personal_dashboard')),
  title       text        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_assistant_sessions_user ON public.ai_assistant_sessions (user_id, updated_at DESC);

CREATE TABLE public.ai_assistant_turns (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              uuid        NOT NULL REFERENCES public.ai_assistant_sessions(id) ON DELETE CASCADE,
  user_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  question                text        NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
  -- answered | insufficient (model found nothing) | sources_only (no model call: policy,
  -- budget, AI off, provider error) | failed
  status                  text        NOT NULL CHECK (status IN ('answered', 'insufficient', 'sources_only', 'failed')),
  notice                  text        CHECK (notice IS NULL OR length(notice) <= 64),
  -- { answer, points: [{ text, messageIds }] } — validated citations only
  answer                  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answer) = 'object' AND octet_length(answer::text) <= 32000),
  -- every message shown with the answer (cited + listed); re-checked on read
  source_message_ids      uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(source_message_ids) <= 200),
  scope_conversation_ids  uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(scope_conversation_ids) <= 50),
  period                  jsonb       NOT NULL CHECK (jsonb_typeof(period) = 'object'),
  provider                text        CHECK (provider IS NULL OR length(provider) <= 32),
  model                   text        CHECK (model IS NULL OR length(model) <= 64),
  prompt_version          text        NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 32),
  cache_key               text        CHECK (cache_key IS NULL OR length(cache_key) = 64),
  usage_id                uuid,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_assistant_turns_session ON public.ai_assistant_turns (session_id, created_at);
CREATE INDEX idx_ai_assistant_turns_cache ON public.ai_assistant_turns (user_id, cache_key, created_at DESC) WHERE cache_key IS NOT NULL;
CREATE INDEX idx_ai_assistant_turns_time ON public.ai_assistant_turns (created_at);

-- ------------------------------------------------------------ B: summaries
CREATE TABLE public.ai_conversation_summaries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace           text        NOT NULL CHECK (namespace IN ('personal_direct', 'personal_group')),
  channel             text        NOT NULL DEFAULT 'zalo_personal' CHECK (channel = 'zalo_personal'),
  connection_id       uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id     uuid        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('daily', 'conversation', 'topic', 'decision')),
  topic               text        CHECK (topic IS NULL OR length(topic) BETWEEN 2 AND 100),
  period_start        timestamptz NOT NULL,
  period_end          timestamptz NOT NULL,
  first_message_at    timestamptz,
  last_message_at     timestamptz,
  message_count       integer     NOT NULL CHECK (message_count >= 0),
  -- messages recorded in ai_memory_sources; fewer left → source deleted → stale
  source_count        integer     NOT NULL CHECK (source_count >= 0),
  -- sha256 over the input message ids (content never changes after ingest)
  source_fingerprint  text        NOT NULL CHECK (length(source_fingerprint) = 64),
  summary_version     integer     NOT NULL DEFAULT 1 CHECK (summary_version >= 1),
  prompt_version      text        NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 32),
  provider            text        NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model               text        NOT NULL CHECK (length(model) BETWEEN 1 AND 64),
  content             jsonb       NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 64000),
  status              text        NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh', 'stale', 'superseded')),
  stale_reason        text        CHECK (stale_reason IS NULL OR stale_reason IN ('source_deleted', 'consent_withdrawn', 'superseded')),
  invalidated_at      timestamptz,
  created_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE,
  CHECK (period_end > period_start),
  CHECK ((kind = 'topic') = (topic IS NOT NULL)),
  CHECK ((status = 'fresh') = (stale_reason IS NULL))
);
CREATE INDEX idx_ai_conversation_summaries_key ON public.ai_conversation_summaries (conversation_id, kind, period_start, period_end, created_at DESC);

-- ------------------------------------------------------------ C: structured facts
CREATE TABLE public.ai_memory_facts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace        text        NOT NULL CHECK (namespace IN ('personal_direct', 'personal_group')),
  channel          text        NOT NULL DEFAULT 'zalo_personal' CHECK (channel = 'zalo_personal'),
  connection_id    uuid        NOT NULL REFERENCES public.zalo_personal_connections(id) ON DELETE CASCADE,
  conversation_id  uuid        NOT NULL,
  summary_id       uuid        REFERENCES public.ai_conversation_summaries(id) ON DELETE SET NULL,
  kind             text        NOT NULL CHECK (kind IN ('fact', 'decision', 'project_ref', 'assignment', 'open_question', 'important_date')),
  statement        text        NOT NULL CHECK (length(statement) BETWEEN 1 AND 500),
  value_date       date,
  confidence       numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- AI output is never a verified fact by itself; only a person can confirm
  evidence_status  text        NOT NULL DEFAULT 'ai_inferred' CHECK (evidence_status IN ('ai_inferred', 'user_confirmed', 'user_rejected')),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'superseded')),
  stale_reason     text        CHECK (stale_reason IS NULL OR stale_reason IN ('source_deleted', 'consent_withdrawn', 'superseded')),
  source_count     integer     NOT NULL CHECK (source_count >= 1),
  created_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, connection_id) REFERENCES public.zalo_personal_conversations (id, connection_id) ON DELETE CASCADE,
  CHECK ((status = 'active') = (stale_reason IS NULL)),
  CHECK ((evidence_status = 'ai_inferred') = (reviewed_at IS NULL))
);
CREATE INDEX idx_ai_memory_facts_conversation ON public.ai_memory_facts (conversation_id, status, created_at DESC);

-- Provenance: which raw messages a summary / fact rests on. A deleted message
-- (retention) removes its rows here → the memory's source_count no longer matches → stale.
CREATE TABLE public.ai_memory_sources (
  memory_kind    text  NOT NULL CHECK (memory_kind IN ('summary', 'fact')),
  memory_id      uuid  NOT NULL,
  message_id     uuid  NOT NULL REFERENCES public.zalo_personal_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_kind, memory_id, message_id)
);
CREATE INDEX idx_ai_memory_sources_message ON public.ai_memory_sources (message_id);

-- ------------------------------------------------------------ usage / budget / audit
-- One row per Ask / Summarize request. Provider calls are the rows that went
-- through zp_ai_reserve (status running → completed | failed). No prompt, no
-- answer, no message text — only counts and categories.
CREATE TABLE public.ai_request_usage (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  channel                  text        NOT NULL DEFAULT 'zalo_personal' CHECK (channel = 'zalo_personal'),
  feature                  text        NOT NULL CHECK (feature IN ('ask', 'summarize')),
  provider                 text        NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model                    text        NOT NULL CHECK (length(model) BETWEEN 1 AND 64),
  -- running/completed/failed = a provider call; rejected = budget refused;
  -- skipped = no call needed / allowed (policy, AI off, nothing found); cache_hit
  status                   text        NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'rejected', 'skipped', 'cache_hit')),
  reason                   text        CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
  estimated_input_tokens   integer     NOT NULL DEFAULT 0 CHECK (estimated_input_tokens >= 0),
  input_tokens             integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens            integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- true = counts reported by the provider; false = estimate
  tokens_confirmed         boolean     NOT NULL DEFAULT false,
  attempts                 integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  redactions               integer     NOT NULL DEFAULT 0 CHECK (redactions >= 0),
  duration_ms              integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz
);
CREATE INDEX idx_ai_request_usage_time ON public.ai_request_usage (created_at DESC);
CREATE INDEX idx_ai_request_usage_user_time ON public.ai_request_usage (user_id, created_at DESC);
CREATE INDEX idx_ai_request_usage_running ON public.ai_request_usage (user_id) WHERE status = 'running';

-- ------------------------------------------------------------ privileges
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_assistant_sessions', 'ai_assistant_turns', 'ai_conversation_summaries', 'ai_memory_facts', 'ai_memory_sources', 'ai_request_usage'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END;
$$;


-- ============================================================
-- Functions (service_role only). Scope arrays as in 00074:
--   p_full  connections the reader sees entirely (owner)
--   p_group connections where the reader sees GROUP conversations only
--   p_ids   single conversations granted
-- p_conversation_ids narrows to the conversations the user picked (already
-- authorized by the server; the scope arrays still apply on top).
-- ============================================================

-- Search inside the scope. p_terms = folded keywords (validated here too);
-- empty → newest messages of the period. Bounded: period + limit ≤ 200.
CREATE OR REPLACE FUNCTION public.zp_ai_search(
  p_full uuid[], p_group uuid[], p_ids uuid[], p_conversation_ids uuid[], p_connection_id uuid, p_type text,
  p_sender text, p_message_type text, p_from timestamptz, p_to timestamptz, p_terms text[], p_limit integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, conversation_type text, external_conversation_id text, group_name text,
               sender_external_id text, message_type text, text_content text, content_stored boolean, text_length integer,
               is_self boolean, message_at timestamptz, rank real)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_terms text[] := ARRAY(SELECT DISTINCT t FROM unnest(coalesce(p_terms, '{}')) t WHERE t ~ '^[a-z0-9]{2,32}$' LIMIT 8);
  v_query tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '93 days' THEN RETURN; END IF;
  -- terms were given but none is valid → nothing (never fall back to "everything")
  IF cardinality(coalesce(p_terms, '{}')) > 0 AND cardinality(v_terms) = 0 THEN RETURN; END IF;
  IF cardinality(v_terms) > 0 THEN
    v_query := to_tsquery('simple', array_to_string(v_terms, ' | '));
  END IF;
  RETURN QUERY
  SELECT m.id, m.connection_id, m.conversation_id, cv.conversation_type, cv.external_conversation_id, g.display_name,
         m.sender_external_id, m.message_type, m.text_content, m.content_stored, m.text_length, m.is_self,
         coalesce(m.sent_at, m.received_at),
         CASE WHEN v_query IS NULL THEN 0::real ELSE ts_rank_cd(to_tsvector('simple'::regconfig, public.zp_fold(m.text_content)), v_query) END
  FROM public.zalo_personal_messages m
  JOIN public.zalo_personal_conversations cv ON cv.id = m.conversation_id AND cv.connection_id = m.connection_id
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
  WHERE (cv.connection_id = ANY (coalesce(p_full, '{}'))
         OR (cv.conversation_type = 'group' AND cv.connection_id = ANY (coalesce(p_group, '{}')))
         OR cv.id = ANY (coalesce(p_ids, '{}')))
    AND (p_conversation_ids IS NULL OR cardinality(p_conversation_ids) = 0 OR cv.id = ANY (p_conversation_ids))
    AND (p_connection_id IS NULL OR cv.connection_id = p_connection_id)
    AND (p_type IS NULL OR cv.conversation_type = p_type)
    AND (p_sender IS NULL OR m.sender_external_id = p_sender)
    AND (p_message_type IS NULL OR m.message_type = p_message_type)
    AND coalesce(m.sent_at, m.received_at) >= p_from AND coalesce(m.sent_at, m.received_at) < p_to
    AND (v_query IS NULL
         OR (m.content_stored AND m.text_content IS NOT NULL
             AND to_tsvector('simple'::regconfig, public.zp_fold(m.text_content)) @@ v_query))
    -- never hand over a message whose text exists but was not stored (1-1 metadata only)
    AND (m.content_stored OR m.text_length = 0)
  ORDER BY 14 DESC, coalesce(m.sent_at, m.received_at) DESC, m.id DESC
  LIMIT v_limit;
END;
$$;

-- Neighbours of a message in its conversation (context expansion).
CREATE OR REPLACE FUNCTION public.zp_ai_context(p_conversation_id uuid, p_at timestamptz, p_id uuid, p_before integer, p_after integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, sender_external_id text, message_type text, text_content text,
               content_stored boolean, text_length integer, is_self boolean, message_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  (SELECT m.id, m.connection_id, m.conversation_id, m.sender_external_id, m.message_type, m.text_content, m.content_stored, m.text_length, m.is_self, coalesce(m.sent_at, m.received_at)
   FROM public.zalo_personal_messages m
   WHERE m.conversation_id = p_conversation_id AND (m.content_stored OR m.text_length = 0)
     AND (coalesce(m.sent_at, m.received_at), m.id) < (p_at, p_id)
   ORDER BY coalesce(m.sent_at, m.received_at) DESC, m.id DESC
   LIMIT least(greatest(coalesce(p_before, 2), 0), 5))
  UNION ALL
  (SELECT m.id, m.connection_id, m.conversation_id, m.sender_external_id, m.message_type, m.text_content, m.content_stored, m.text_length, m.is_self, coalesce(m.sent_at, m.received_at)
   FROM public.zalo_personal_messages m
   WHERE m.conversation_id = p_conversation_id AND (m.content_stored OR m.text_length = 0)
     AND (coalesce(m.sent_at, m.received_at), m.id) > (p_at, p_id)
   ORDER BY coalesce(m.sent_at, m.received_at), m.id
   LIMIT least(greatest(coalesce(p_after, 2), 0), 5));
$$;

-- All messages of ONE conversation in a period, newest p_limit (≤ 400), with the total.
CREATE OR REPLACE FUNCTION public.zp_ai_range(p_conversation_id uuid, p_from timestamptz, p_to timestamptz, p_limit integer)
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, sender_external_id text, message_type text, text_content text,
               content_stored boolean, text_length integer, is_self boolean, message_at timestamptz, total bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.id, m.connection_id, m.conversation_id, m.sender_external_id, m.message_type, m.text_content, m.content_stored, m.text_length, m.is_self,
         coalesce(m.sent_at, m.received_at), count(*) OVER ()
  FROM public.zalo_personal_messages m
  WHERE m.conversation_id = p_conversation_id AND (m.content_stored OR m.text_length = 0)
    AND p_to - p_from <= interval '93 days'
    AND coalesce(m.sent_at, m.received_at) >= p_from AND coalesce(m.sent_at, m.received_at) < p_to
  ORDER BY coalesce(m.sent_at, m.received_at) DESC, m.id DESC
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 400);
$$;

-- Messages by id with what the server needs to re-check visibility.
CREATE OR REPLACE FUNCTION public.zp_ai_messages_by_ids(p_ids uuid[])
RETURNS TABLE (id uuid, connection_id uuid, conversation_id uuid, conversation_type text, external_conversation_id text, group_name text,
               sender_external_id text, message_type text, text_content text, content_stored boolean, text_length integer,
               is_self boolean, message_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.id, m.connection_id, m.conversation_id, cv.conversation_type, cv.external_conversation_id, g.display_name,
         m.sender_external_id, m.message_type, m.text_content, m.content_stored, m.text_length, m.is_self, coalesce(m.sent_at, m.received_at)
  FROM public.zalo_personal_messages m
  JOIN public.zalo_personal_conversations cv ON cv.id = m.conversation_id AND cv.connection_id = m.connection_id
  LEFT JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
  WHERE m.id = ANY ((coalesce(p_ids, '{}'))[1:400]);
$$;

-- Raw messages behind active facts that match the terms (memory-assisted retrieval).
-- Facts are never evidence themselves: only their source messages are returned.
CREATE OR REPLACE FUNCTION public.zp_ai_fact_sources(p_conversation_ids uuid[], p_terms text[], p_limit integer)
RETURNS TABLE (message_id uuid)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT DISTINCT s.message_id
  FROM public.ai_memory_facts f
  JOIN public.ai_memory_sources s ON s.memory_kind = 'fact' AND s.memory_id = f.id
  WHERE f.conversation_id = ANY (coalesce(p_conversation_ids, '{}'))
    AND f.status = 'active' AND f.evidence_status <> 'user_rejected'
    AND EXISTS (SELECT 1 FROM unnest(coalesce(p_terms, '{}')) t WHERE t ~ '^[a-z0-9]{2,32}$' AND public.zp_fold(f.statement) LIKE '%' || t || '%')
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- ------------------------------------------------------------ budget
-- Atomic reservation of ONE provider call. Serialized by an advisory lock so
-- two concurrent requests can't both take the last slot. Counts provider
-- calls only (running / completed / failed), per VN day (p_day_start).
CREATE OR REPLACE FUNCTION public.zp_ai_reserve(
  p_user uuid, p_feature text, p_provider text, p_model text, p_estimated integer, p_day_start timestamptz,
  p_max_user_day integer, p_max_day integer, p_max_minute integer, p_cooldown_minutes integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('zp_ai_budget'));
  -- a request left running > 5 min (crash) no longer blocks
  IF EXISTS (SELECT 1 FROM public.ai_request_usage WHERE user_id = p_user AND status = 'running' AND created_at > now() - interval '5 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'concurrent');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ai_request_usage WHERE model = p_model AND status = 'failed' AND reason = 'quota_exceeded'
             AND created_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 1))) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quota_cooldown');
  END IF;
  IF (SELECT count(*) FROM public.ai_request_usage WHERE status IN ('running', 'completed', 'failed') AND created_at >= p_day_start) >= p_max_day THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'global_daily');
  END IF;
  IF (SELECT count(*) FROM public.ai_request_usage WHERE user_id = p_user AND status IN ('running', 'completed', 'failed') AND created_at >= p_day_start) >= p_max_user_day THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_daily');
  END IF;
  IF (SELECT count(*) FROM public.ai_request_usage WHERE model = p_model AND status IN ('running', 'completed', 'failed') AND created_at > now() - interval '1 minute') >= p_max_minute THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'model_minute');
  END IF;
  INSERT INTO public.ai_request_usage (user_id, feature, provider, model, status, estimated_input_tokens)
  VALUES (p_user, p_feature, p_provider, p_model, 'running', greatest(coalesce(p_estimated, 0), 0))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.zp_ai_finish(p_id uuid, p_status text, p_reason text, p_input integer, p_output integer, p_confirmed boolean, p_attempts integer, p_redactions integer, p_duration integer)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.ai_request_usage
  SET status = p_status, reason = p_reason, input_tokens = greatest(coalesce(p_input, 0), 0), output_tokens = greatest(coalesce(p_output, 0), 0),
      tokens_confirmed = coalesce(p_confirmed, false), attempts = least(greatest(coalesce(p_attempts, 0), 0), 5),
      redactions = greatest(coalesce(p_redactions, 0), 0), duration_ms = p_duration, finished_at = now()
  WHERE id = p_id AND status = 'running' AND p_status IN ('completed', 'failed');
$$;

-- ------------------------------------------------------------ memory write
-- Stores one summary + its facts + provenance in ONE transaction. Every source
-- message must belong to p_conversation_id (a citation can't point elsewhere).
-- The previous fresh summary of the same key, and its facts, become superseded.
CREATE OR REPLACE FUNCTION public.zp_ai_store_summary(
  p_actor uuid, p_connection_id uuid, p_conversation_id uuid, p_namespace text, p_kind text, p_topic text,
  p_period_start timestamptz, p_period_end timestamptz, p_input_ids uuid[], p_fingerprint text,
  p_prompt_version text, p_provider text, p_model text, p_content jsonb, p_facts jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_conv record;
  v_id uuid;
  v_version integer;
  v_fact jsonb;
  v_fact_id uuid;
  v_fact_sources uuid[];
  v_first timestamptz;
  v_last timestamptz;
  v_count integer;
BEGIN
  SELECT * INTO v_conv FROM public.zalo_personal_conversations WHERE id = p_conversation_id AND connection_id = p_connection_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p_namespace IS DISTINCT FROM (CASE WHEN v_conv.conversation_type = 'group' THEN 'personal_group' ELSE 'personal_direct' END) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'namespace_mismatch');
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_input_ids, '{}')) i
             WHERE NOT EXISTS (SELECT 1 FROM public.zalo_personal_messages m WHERE m.id = i AND m.conversation_id = p_conversation_id)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'foreign_source');
  END IF;
  SELECT min(coalesce(sent_at, received_at)), max(coalesce(sent_at, received_at)), count(*) INTO v_first, v_last, v_count
  FROM public.zalo_personal_messages WHERE id = ANY (p_input_ids);

  SELECT coalesce(max(summary_version), 0) + 1 INTO v_version FROM public.ai_conversation_summaries
  WHERE conversation_id = p_conversation_id AND kind = p_kind AND coalesce(topic, '') = coalesce(p_topic, '') AND period_start = p_period_start AND period_end = p_period_end;

  UPDATE public.ai_memory_facts SET status = 'superseded', stale_reason = 'superseded', updated_at = now()
  WHERE status = 'active' AND summary_id IN (
    SELECT id FROM public.ai_conversation_summaries
    WHERE conversation_id = p_conversation_id AND kind = p_kind AND coalesce(topic, '') = coalesce(p_topic, '')
      AND period_start = p_period_start AND period_end = p_period_end AND status = 'fresh');
  UPDATE public.ai_conversation_summaries SET status = 'superseded', stale_reason = 'superseded', invalidated_at = now()
  WHERE conversation_id = p_conversation_id AND kind = p_kind AND coalesce(topic, '') = coalesce(p_topic, '')
    AND period_start = p_period_start AND period_end = p_period_end AND status = 'fresh';

  INSERT INTO public.ai_conversation_summaries (namespace, connection_id, conversation_id, kind, topic, period_start, period_end, first_message_at, last_message_at,
    message_count, source_count, source_fingerprint, summary_version, prompt_version, provider, model, content, created_by)
  VALUES (p_namespace, p_connection_id, p_conversation_id, p_kind, p_topic, p_period_start, p_period_end, v_first, v_last,
    v_count, v_count, p_fingerprint, v_version, p_prompt_version, p_provider, p_model, p_content, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.ai_memory_sources (memory_kind, memory_id, message_id) SELECT 'summary', v_id, i FROM unnest(p_input_ids) i ON CONFLICT DO NOTHING;

  FOR v_fact IN SELECT * FROM jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) LOOP
    v_fact_sources := ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(v_fact -> 'messageIds') x WHERE (x)::uuid = ANY (p_input_ids));
    CONTINUE WHEN cardinality(v_fact_sources) = 0;
    INSERT INTO public.ai_memory_facts (namespace, connection_id, conversation_id, summary_id, kind, statement, value_date, confidence, source_count, created_by)
    VALUES (p_namespace, p_connection_id, p_conversation_id, v_id, v_fact ->> 'kind', left(v_fact ->> 'statement', 500),
            nullif(v_fact ->> 'valueDate', '')::date, least(greatest(coalesce((v_fact ->> 'confidence')::numeric, 0.5), 0), 1), cardinality(v_fact_sources), p_actor)
    RETURNING id INTO v_fact_id;
    INSERT INTO public.ai_memory_sources (memory_kind, memory_id, message_id) SELECT 'fact', v_fact_id, i FROM unnest(v_fact_sources) i ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'version', v_version);
END;
$$;

-- Marks memory stale (lazy, called before memory is read or reused):
--   source_deleted     a source message is gone (retention) → provenance incomplete
--   consent_withdrawn  the group is no longer monitored with consent
CREATE OR REPLACE FUNCTION public.zp_ai_validate_memory(p_conversation_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_summaries integer;
  v_facts integer;
  v_consent integer;
BEGIN
  WITH withdrawn AS (
    SELECT cv.id FROM public.zalo_personal_conversations cv
    JOIN public.zalo_personal_groups g ON g.id = cv.group_id AND g.connection_id = cv.connection_id
    WHERE cv.id = ANY (coalesce(p_conversation_ids, '{}')) AND cv.conversation_type = 'group' AND g.consent_status <> 'granted'
  ), s AS (
    UPDATE public.ai_conversation_summaries x SET status = 'stale', stale_reason = 'consent_withdrawn', invalidated_at = now()
    WHERE x.status = 'fresh' AND x.conversation_id IN (SELECT id FROM withdrawn) RETURNING 1
  ), f AS (
    UPDATE public.ai_memory_facts x SET status = 'stale', stale_reason = 'consent_withdrawn', updated_at = now()
    WHERE x.status = 'active' AND x.conversation_id IN (SELECT id FROM withdrawn) RETURNING 1
  )
  SELECT (SELECT count(*) FROM s) + (SELECT count(*) FROM f) INTO v_consent;

  UPDATE public.ai_conversation_summaries x SET status = 'stale', stale_reason = 'source_deleted', invalidated_at = now()
  WHERE x.status = 'fresh' AND x.conversation_id = ANY (coalesce(p_conversation_ids, '{}'))
    AND (SELECT count(*) FROM public.ai_memory_sources s WHERE s.memory_kind = 'summary' AND s.memory_id = x.id) < x.source_count;
  GET DIAGNOSTICS v_summaries = ROW_COUNT;
  UPDATE public.ai_memory_facts x SET status = 'stale', stale_reason = 'source_deleted', updated_at = now()
  WHERE x.status = 'active' AND x.conversation_id = ANY (coalesce(p_conversation_ids, '{}'))
    AND (SELECT count(*) FROM public.ai_memory_sources s WHERE s.memory_kind = 'fact' AND s.memory_id = x.id) < x.source_count;
  GET DIAGNOSTICS v_facts = ROW_COUNT;
  RETURN jsonb_build_object('consentWithdrawn', v_consent, 'summariesSourceDeleted', v_summaries, 'factsSourceDeleted', v_facts);
END;
$$;

-- Retention. Not scheduled in Phase 04 (run by the owner / a later cron):
--   Ask AI turns + empty sessions older than p_session_days
--   usage rows older than 180 days
--   stale / superseded summaries and facts older than 90 days (with provenance)
CREATE OR REPLACE FUNCTION public.zp_ai_prune(p_session_days integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_turns integer; v_sessions integer; v_usage integer; v_summaries integer; v_facts integer;
BEGIN
  DELETE FROM public.ai_assistant_turns WHERE created_at < now() - make_interval(days => greatest(coalesce(p_session_days, 30), 1));
  GET DIAGNOSTICS v_turns = ROW_COUNT;
  DELETE FROM public.ai_assistant_sessions s WHERE NOT EXISTS (SELECT 1 FROM public.ai_assistant_turns t WHERE t.session_id = s.id)
    AND s.updated_at < now() - make_interval(days => greatest(coalesce(p_session_days, 30), 1));
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  DELETE FROM public.ai_request_usage WHERE created_at < now() - interval '180 days' AND status <> 'running';
  GET DIAGNOSTICS v_usage = ROW_COUNT;
  DELETE FROM public.ai_memory_sources WHERE memory_kind = 'fact' AND memory_id IN (SELECT id FROM public.ai_memory_facts WHERE status <> 'active' AND updated_at < now() - interval '90 days');
  DELETE FROM public.ai_memory_facts WHERE status <> 'active' AND updated_at < now() - interval '90 days';
  GET DIAGNOSTICS v_facts = ROW_COUNT;
  DELETE FROM public.ai_memory_sources WHERE memory_kind = 'summary' AND memory_id IN (SELECT id FROM public.ai_conversation_summaries WHERE status <> 'fresh' AND coalesce(invalidated_at, created_at) < now() - interval '90 days');
  DELETE FROM public.ai_conversation_summaries WHERE status <> 'fresh' AND coalesce(invalidated_at, created_at) < now() - interval '90 days';
  GET DIAGNOSTICS v_summaries = ROW_COUNT;
  RETURN jsonb_build_object('turns', v_turns, 'sessions', v_sessions, 'usage', v_usage, 'summaries', v_summaries, 'facts', v_facts);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.zp_ai_search(uuid[], uuid[], uuid[], uuid[], uuid, text, text, text, timestamptz, timestamptz, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_context(uuid, timestamptz, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_range(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_messages_by_ids(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_fact_sources(uuid[], text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_reserve(uuid, text, text, text, integer, timestamptz, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_finish(uuid, text, text, integer, integer, boolean, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_store_summary(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, uuid[], text, text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_validate_memory(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zp_ai_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zp_ai_search(uuid[], uuid[], uuid[], uuid[], uuid, text, text, text, timestamptz, timestamptz, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_context(uuid, timestamptz, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_range(uuid, timestamptz, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_messages_by_ids(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_fact_sources(uuid[], text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_reserve(uuid, text, text, text, integer, timestamptz, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_finish(uuid, text, text, integer, integer, boolean, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_store_summary(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, uuid[], text, text, text, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_validate_memory(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.zp_ai_prune(integer) TO service_role;
-- zp_fold keeps the default EXECUTE: a pure text function (no data access) that the
-- full-text index evaluates on every message insert, whoever performs it.

NOTIFY pgrst, 'reload schema';
