-- ============================================================
-- PRODUCT-ANALYTICS-4: Claude Product Analyst — usage, cache, web channel.
--
--   ai_usage_logs      one row per analysis request (also cache hits and refusals
--                      by the limiter): model, prompt version, tokens, estimated
--                      cost, tool trace (tool NAMES only), latency, status. No
--                      prompt / answer text. Also the source of the per-user rate,
--                      concurrency and daily cost limits.
--   ai_analysis_cache  validated analysis output keyed by product + period + data
--                      version + prompt version + model family + question. Never an
--                      authorization: the caller re-checks access BEFORE reading it.
--   ai_conversations / ai_messages: + channel 'web' (threads stay per channel);
--                      ai_messages.analysis = the validated structured output of a
--                      web answer (bounded), so the chat can re-render it.
--
-- RLS on, nothing for anon / authenticated; explicit service_role grants (cloud
-- has no default grants). After `db push`: NOTIFY pgrst, 'reload schema'.
-- ============================================================

CREATE TABLE public.ai_usage_logs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text        NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model                text        NOT NULL CHECK (length(model) BETWEEN 1 AND 64),
  prompt_version       text        NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 32),
  channel              text        NOT NULL CHECK (channel IN ('zalo', 'web', 'script')),
  conversation_id      uuid        REFERENCES public.ai_conversations(id) ON DELETE SET NULL,
  internal_user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  shop_id              uuid        REFERENCES public.shops(id) ON DELETE SET NULL,
  product_id           uuid        REFERENCES public.shopee_products(id) ON DELETE SET NULL,
  analysis_type        text        NOT NULL CHECK (analysis_type IN ('user_question', 'ui_request', 'signal_triggered', 'daily_batch')),
  -- running → completed | failed; cache_hit / rejected are final at insert
  status               text        NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cache_hit', 'rejected')),
  error_category       text        CHECK (error_category IN ('AUTH_DENIED', 'PRODUCT_NOT_FOUND', 'AMBIGUOUS_PRODUCT', 'DATA_UNAVAILABLE', 'AI_PROVIDER_ERROR', 'AI_RATE_LIMIT', 'TOOL_ERROR', 'OUTPUT_INVALID', 'TIMEOUT', 'LIMIT_REACHED')),
  input_tokens         integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens        integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens  integer     CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  cache_write_tokens   integer     CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  -- USD; NULL when the model's price is not configured (never guessed)
  estimated_cost       numeric(12, 6) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  tool_calls           integer     NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  -- tool names in call order (audit / debug) — never tool payloads
  tool_trace           text[]      NOT NULL DEFAULT '{}',
  model_turns          integer     NOT NULL DEFAULT 0 CHECK (model_turns >= 0),
  duration_ms          integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  model_ms             integer     CHECK (model_ms IS NULL OR model_ms >= 0),
  tool_ms              integer     CHECK (tool_ms IS NULL OR tool_ms >= 0),
  cache_key            text        CHECK (cache_key IS NULL OR length(cache_key) <= 256),
  created_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz
);
CREATE INDEX idx_ai_usage_logs_user_time ON public.ai_usage_logs (internal_user_id, created_at DESC);
CREATE INDEX idx_ai_usage_logs_time ON public.ai_usage_logs (created_at DESC);
CREATE INDEX idx_ai_usage_logs_running ON public.ai_usage_logs (internal_user_id) WHERE status = 'running';

CREATE TABLE public.ai_analysis_cache (
  cache_key       text        PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 256),
  shop_id         uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  product_id      uuid        REFERENCES public.shopee_products(id) ON DELETE CASCADE,
  prompt_version  text        NOT NULL,
  model           text        NOT NULL,
  data_version    text        NOT NULL,
  -- validated AnalystOutput only (bounded)
  output          jsonb       NOT NULL CHECK (jsonb_typeof(output) = 'object' AND octet_length(output::text) <= 32000),
  tool_trace      text[]      NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_ai_analysis_cache_expires ON public.ai_analysis_cache (expires_at);

-- web channel: same tables, separate threads (one per channel + external user)
ALTER TABLE public.ai_conversations DROP CONSTRAINT IF EXISTS ai_conversations_channel_check;
ALTER TABLE public.ai_conversations ADD CONSTRAINT ai_conversations_channel_check CHECK (channel IN ('zalo', 'web'));
ALTER TABLE public.ai_messages DROP CONSTRAINT IF EXISTS ai_messages_channel_check;
ALTER TABLE public.ai_messages ADD CONSTRAINT ai_messages_channel_check CHECK (channel IN ('zalo', 'web'));
ALTER TABLE public.ai_messages ADD COLUMN analysis jsonb
  CHECK (analysis IS NULL OR (jsonb_typeof(analysis) = 'object' AND octet_length(analysis::text) <= 32000));

ALTER TABLE public.ai_usage_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_analysis_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_usage_logs, public.ai_analysis_cache FROM anon, authenticated;
-- cloud has no default grants: explicit
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_logs, public.ai_analysis_cache TO service_role;
