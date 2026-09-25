-- ============================================================
-- PHASE ZL1: Zalo OA OAuth foundation — token storage.
--
-- Single OA in scope ("Homies"), so one row per oa_id (UNIQUE), upserted by
-- the OAuth callback. Tokens are never stored in plaintext: the app layer
-- (src/lib/zalo/crypto.ts) encrypts with AES-256-GCM using
-- ZALO_TOKEN_ENCRYPTION_KEY before INSERT/UPDATE, and decrypts only
-- server-side right before calling the Zalo API. This is a lightweight
-- app-layer encryption-at-rest, not a full secrets-manager integration —
-- see docs/zalo-integration.md's "Token storage strategy" section for the
-- documented limitation the phase spec explicitly allows.
--
-- Unlike every other table in this app, this one grants NO policies to
-- `authenticated` — nothing in the browser or any Supabase client-side
-- query ever needs to read this table; only the server-only admin client
-- (service_role, which bypasses RLS) touches it, from src/lib/zalo/token.ts.
-- RLS is enabled with zero policies as a deliberate default-deny, not an
-- oversight.
-- ============================================================
CREATE TABLE public.zalo_connections (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  oa_id                    text          NOT NULL UNIQUE,
  access_token_encrypted   text          NOT NULL,
  refresh_token_encrypted  text,
  expires_at               timestamptz,
  connected_by             uuid          REFERENCES public.profiles(id),
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE TRIGGER set_zalo_connections_updated_at
  BEFORE UPDATE ON public.zalo_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.zalo_connections ENABLE ROW LEVEL SECURITY;
-- No GRANT/POLICY statements — see header comment.
