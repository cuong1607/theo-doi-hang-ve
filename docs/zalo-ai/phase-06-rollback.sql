-- ============================================================
-- PHASE 06 rollback — removes everything 00078_ai_tasks_reminders.sql created.
-- DESTROYS task / reminder / inbox data. Zalo Personal messages, Phase 04 / 05
-- tables, Zalo OA notification tables are NOT touched.
-- Run as postgres (SQL editor), then:
--   delete from supabase_migrations.schema_migrations where version = '00078';
--   notify pgrst, 'reload schema';
-- Prefer the flag rollback first (AI_TASKS_ENABLED=false): nothing runs, data kept.
-- ============================================================
BEGIN;
SELECT cron.unschedule('ai-tasks-tick') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-tasks-tick');

DROP FUNCTION IF EXISTS public.ai_tasks_cron_tick();
DROP FUNCTION IF EXISTS public.ai_task_health(timestamptz);
DROP FUNCTION IF EXISTS public.ai_task_mark_overdue(integer);
DROP FUNCTION IF EXISTS public.ai_reminder_ensure_morning(date, timestamptz);
DROP FUNCTION IF EXISTS public.ai_reminder_retry(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.ai_reminder_resolve(text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.ai_reminder_claim(text, integer, integer);
DROP FUNCTION IF EXISTS public.ai_task_open_for_user(uuid, integer);
DROP FUNCTION IF EXISTS public.ai_task_list(uuid[], uuid[], uuid[], uuid, text, text, uuid, uuid, text, timestamptz, timestamptz, timestamptz, integer, integer);
DROP FUNCTION IF EXISTS public.ai_task_apply(uuid, uuid, integer, jsonb, text, jsonb, jsonb, jsonb, boolean, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.ai_task_store_extraction(text, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.ai_task_context(uuid, uuid[], integer);
DROP FUNCTION IF EXISTS public.ai_task_claim_candidates(text, integer, integer);
DROP FUNCTION IF EXISTS public.ai_task_scan_release(uuid, text);
DROP FUNCTION IF EXISTS public.ai_task_scan_commit(uuid, text, timestamptz, uuid, integer, jsonb, jsonb, jsonb, timestamptz, integer, boolean);
DROP FUNCTION IF EXISTS public.ai_task_scan_messages(uuid, timestamptz, uuid, timestamptz, integer);
DROP FUNCTION IF EXISTS public.ai_task_scan_claim(text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.ai_notify_insert(jsonb);
DROP FUNCTION IF EXISTS public.ai_task_assignee_user(uuid, text);

DROP TABLE IF EXISTS public.ai_task_worker_runs;
DROP TABLE IF EXISTS public.ai_reminder_schedules;
DROP TABLE IF EXISTS public.ai_reminder_preferences;
DROP TABLE IF EXISTS public.notification_deliveries;
DROP TABLE IF EXISTS public.user_notifications;
DROP TABLE IF EXISTS public.ai_task_activity;
DROP FUNCTION IF EXISTS public.ai_task_activity_guard();
DROP TABLE IF EXISTS public.ai_task_recipients;
DROP TABLE IF EXISTS public.ai_task_assignments;
DROP TABLE IF EXISTS public.ai_task_source_messages;
DROP TABLE IF EXISTS public.ai_tasks;
DROP TABLE IF EXISTS public.ai_task_candidates;
DROP TABLE IF EXISTS public.ai_mention_events;
DROP TABLE IF EXISTS public.ai_task_scan_state;
DROP INDEX IF EXISTS public.idx_zalo_personal_messages_scan;

-- feature CHECK back to the 00077 list (fails if task_extract usage rows exist: delete them first)
DELETE FROM public.ai_request_usage WHERE feature = 'task_extract';
ALTER TABLE public.ai_request_usage DROP CONSTRAINT IF EXISTS ai_request_usage_feature_check;
ALTER TABLE public.ai_request_usage ADD CONSTRAINT ai_request_usage_feature_check CHECK (feature IN ('ask', 'summarize', 'system_plan', 'system_answer'));
COMMIT;
