-- ============================================================
-- PHASE 04.5 rollback — removes migration 00079 (Zalo Personal AI Reply).
-- NOT run automatically. Back up first. Loses: reply drafts, outbound
-- history, reply audit, settings, allowlist, block list.
-- Keeps: messages, groups (incl. send_verified_at set by verified sends),
-- identities, Phase 04/05/06 data.
-- Run with the service role / SQL editor, then NOTIFY pgrst.
-- ============================================================
BEGIN;
SELECT cron.unschedule('zp-reply-tick') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'zp-reply-tick');

DROP FUNCTION IF EXISTS public.zp_reply_cron_tick();
DROP FUNCTION IF EXISTS public.zp_reply_admin(uuid, text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.zp_reply_report(uuid, uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.zp_reply_claim_outbound(uuid, text, integer, integer, boolean);
DROP FUNCTION IF EXISTS public.zp_reply_recover();
DROP FUNCTION IF EXISTS public.zp_reply_act(uuid, uuid, text, integer, text, text);
DROP FUNCTION IF EXISTS public.zp_reply_store_result(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.zp_reply_inbound_context(uuid);
DROP FUNCTION IF EXISTS public.zp_reply_claim_inbound(text, integer, integer);
DROP FUNCTION IF EXISTS public.zp_reply_scan_release(uuid, text);
DROP FUNCTION IF EXISTS public.zp_reply_scan_commit(uuid, text, timestamptz, uuid, integer, jsonb, boolean);
DROP FUNCTION IF EXISTS public.zp_reply_scan_messages(uuid, timestamptz, uuid, timestamptz, integer);
DROP FUNCTION IF EXISTS public.zp_reply_scan_claim(text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.zp_reply_log(uuid, uuid, uuid, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.zp_reply_vn_day_start();

DROP TABLE IF EXISTS public.zalo_personal_reply_audit;
DROP FUNCTION IF EXISTS public.zp_reply_audit_guard();
DROP TABLE IF EXISTS public.zalo_personal_reply_drafts;
DROP TABLE IF EXISTS public.zalo_personal_reply_inbound;
DROP TABLE IF EXISTS public.zalo_personal_reply_scan_state;
DROP TABLE IF EXISTS public.zalo_personal_reply_blocks;
DROP TABLE IF EXISTS public.zalo_personal_reply_allowlist;
DROP TABLE IF EXISTS public.zalo_personal_reply_settings;
DROP TABLE IF EXISTS public.zalo_personal_reply_control;

DELETE FROM public.zalo_personal_request_nonces WHERE endpoint = 'outbound';
ALTER TABLE public.zalo_personal_request_nonces DROP CONSTRAINT IF EXISTS zalo_personal_request_nonces_endpoint_check;
ALTER TABLE public.zalo_personal_request_nonces ADD CONSTRAINT zalo_personal_request_nonces_endpoint_check CHECK (endpoint IN ('events', 'heartbeat'));

DELETE FROM supabase_migrations.schema_migrations WHERE version = '00079';
COMMIT;
NOTIFY pgrst, 'reload schema';
