-- ============================================================
-- PHASE ZL7: Zalo notification production hardening — token refresh safety
--
-- refresh_lock_at: a lightweight cross-instance lock so two concurrent
-- serverless invocations (e.g. a cron run and an admin clicking "test all"
-- at nearly the same moment) never both call Zalo's refresh_token grant
-- with the same refresh_token — if Zalo rotates refresh tokens on use, the
-- loser of that race would get a hard failure instead of just waiting a
-- few hundred ms for the winner's fresh token. See src/lib/zalo/token.ts.
--
-- last_refresh_at / last_refresh_error_code / last_refresh_error_message:
-- feeds the new "Token: Valid / Expired / Refresh failed" health status on
-- /settings/notifications (Phần 2 of the ZL7 spec) — without these, the
-- page could only show "has a row or not", never "the last refresh
-- attempt actually failed".
-- ============================================================
ALTER TABLE public.zalo_connections
  ADD COLUMN refresh_lock_at         timestamptz,
  ADD COLUMN last_refresh_at         timestamptz,
  ADD COLUMN last_refresh_error_code    text,
  ADD COLUMN last_refresh_error_message text;
