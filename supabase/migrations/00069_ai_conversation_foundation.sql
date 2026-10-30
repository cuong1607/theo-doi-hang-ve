-- ============================================================
-- SHOPEE-PRODUCT-ANALYTICS-1 (part B): Zalo OA conversation foundation.
--
-- Minimal conversation infrastructure ONLY — no product analytics facts are
-- stored here (SQL owns truth in its own tables; this is transport state).
--
--   zalo_user_links      Zalo user (OA follower id) → internal profile. Created
--                        only through a short-lived one-time link code.
--   zalo_link_codes      one-time codes (sha256 hash only, never the code).
--   ai_user_shop_access  explicit shop grants for the conversation agent.
--                        Deny by default: no row = no access, whatever the role.
--   ai_conversations     one per (channel, external user) + light context.
--   ai_messages          inbound / outbound text; inbound provider message id
--                        is UNIQUE per channel → a redelivered webhook cannot
--                        create a second message or a second processing run.
--
-- RLS on, nothing for anon / authenticated: only the service role (webhook,
-- server actions) reads or writes. Cloud has no default grants → explicit.
-- ============================================================

CREATE TABLE public.zalo_user_links (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  zalo_user_id      text        NOT NULL UNIQUE CHECK (zalo_user_id ~ '^[0-9]{1,32}$'),
  internal_user_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  linked_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_zalo_user_links_internal_user ON public.zalo_user_links (internal_user_id);
CREATE TRIGGER set_zalo_user_links_updated_at BEFORE UPDATE ON public.zalo_user_links
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE public.zalo_link_codes (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             text        NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  internal_user_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by            uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  used_by_zalo_user_id  text,
  failed_attempts       integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE public.ai_user_shop_access (
  internal_user_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  shop_id           uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  granted_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (internal_user_id, shop_id)
);

CREATE TABLE public.ai_conversations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             text        NOT NULL CHECK (channel IN ('zalo')),
  external_user_id    text        NOT NULL CHECK (length(external_user_id) BETWEEN 1 AND 64),
  internal_user_id    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- context is a convenience, NEVER an authorization: every use re-checks ai_user_shop_access
  current_shop_id     uuid        REFERENCES public.shops(id) ON DELETE SET NULL,
  current_product_id  uuid        REFERENCES public.products(id) ON DELETE SET NULL,
  last_intent         text        CHECK (last_intent IN ('HELP', 'PRODUCT_ANALYSIS', 'SHOP_ANALYSIS', 'ADS_ANALYSIS', 'UNKNOWN')),
  -- light context only: { productQuery, period, unlinkedNoticeAt } — no metrics, no raw payloads
  context             jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_user_id)
);
CREATE TRIGGER set_ai_conversations_updated_at BEFORE UPDATE ON public.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE public.ai_messages (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid        NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  channel              text        NOT NULL CHECK (channel IN ('zalo')),
  direction            text        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider_message_id  text        CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 128),
  -- only the conversational text (link codes are stored redacted); never the raw webhook payload
  text                 text        NOT NULL CHECK (length(text) <= 4000),
  intent               text        CHECK (intent IN ('HELP', 'PRODUCT_ANALYSIS', 'SHOP_ANALYSIS', 'ADS_ANALYSIS', 'UNKNOWN', 'LINK')),
  -- inbound: pending → replied | ignored | failed; outbound: sent | failed
  processing_status    text        NOT NULL CHECK (processing_status IN ('pending', 'replied', 'ignored', 'failed', 'sent')),
  error_code           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- idempotency: one inbound row per provider message id
CREATE UNIQUE INDEX ux_ai_messages_inbound_provider_id ON public.ai_messages (channel, provider_message_id)
  WHERE direction = 'inbound' AND provider_message_id IS NOT NULL;
CREATE INDEX idx_ai_messages_conversation ON public.ai_messages (conversation_id, created_at DESC);
CREATE TRIGGER set_ai_messages_updated_at BEFORE UPDATE ON public.ai_messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.zalo_user_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_link_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_user_shop_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages         ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.zalo_user_links, public.zalo_link_codes, public.ai_user_shop_access, public.ai_conversations, public.ai_messages FROM anon, authenticated;
-- cloud has no default grants: explicit
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zalo_user_links, public.zalo_link_codes, public.ai_user_shop_access, public.ai_conversations, public.ai_messages TO service_role;
