-- ============================================================
-- PHASE SHOPEE-1: cross-instance token-refresh lock for shop_connections.
--
-- Shopee rotates the refresh_token on every refresh: two serverless
-- instances refreshing the same shop at once would let the loser overwrite
-- (or be rejected with) an already-consumed refresh token. The lock is a
-- lease on the connection row, claimed atomically with the DATABASE clock
-- (never the app server's clock):
--
--   claim_shop_token_refresh(shop, provider, seconds) → lock id | NULL
--     NULL = someone else holds an unexpired lease → wait and re-read.
--   release = UPDATE ... SET refresh_lock_id = NULL WHERE refresh_lock_id = <id>
--     (only the holder can release; an expired lease is simply re-claimable).
--
-- Lease length must stay well above one refresh call's timeout so a lease
-- can't expire while its holder is still refreshing (see
-- src/lib/channels/shopee/constants.ts).
--
-- The new columns are NOT added to the authenticated column GRANT of 00038:
-- they are server-only internals.
-- ============================================================
ALTER TABLE public.shop_connections
  ADD COLUMN refresh_lock_id     uuid,
  ADD COLUMN refresh_lock_until  timestamptz;

CREATE OR REPLACE FUNCTION public.claim_shop_token_refresh(
  p_shop_id       uuid,
  p_provider      text,
  p_lease_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_lock_id uuid := gen_random_uuid();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 1 and 600';
  END IF;

  UPDATE public.shop_connections
  SET refresh_lock_id    = v_lock_id,
      refresh_lock_until = now() + make_interval(secs => p_lease_seconds)
  WHERE shop_id = p_shop_id
    AND provider = p_provider
    AND (refresh_lock_until IS NULL OR refresh_lock_until < now());

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN v_lock_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_shop_token_refresh(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shop_token_refresh(uuid, text, integer) TO service_role;
