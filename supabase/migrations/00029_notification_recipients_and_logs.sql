-- ============================================================
-- PHASE ZL2: Notification core — recipients + delivery logs.
--
-- Unlike zalo_connections (00028, which holds secrets and grants nothing to
-- `authenticated`), these two tables hold ordinary business data (names,
-- Zalo UIDs, message text, delivery status) — same RLS shape as every other
-- table in this app (suppliers/invoices/payments/...): full CRUD granted to
-- `authenticated`, with the actual admin-only restriction enforced at the
-- app layer (canManageNotificationRecipients in src/lib/auth/role.ts),
-- pending Phase 5 (Authentication)'s real per-role RLS.
-- ============================================================

-- ------------------------------------------------------------
-- 1. TABLE: notification_recipients
-- ------------------------------------------------------------
CREATE TABLE public.notification_recipients (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  zalo_uid    text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_recipients_zalo_uid_unique UNIQUE (zalo_uid),
  CONSTRAINT notification_recipients_name_not_empty CHECK (btrim(name) <> '')
);

CREATE TRIGGER set_notification_recipients_updated_at
  BEFORE UPDATE ON public.notification_recipients
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.notification_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view notification_recipients"
  ON public.notification_recipients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert notification_recipients"
  ON public.notification_recipients FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update notification_recipients"
  ON public.notification_recipients FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can delete notification_recipients"
  ON public.notification_recipients FOR DELETE
  TO authenticated
  USING (true);


-- ------------------------------------------------------------
-- 2. TABLE: notification_logs
--
-- recipient_id is nullable + ON DELETE SET NULL: deleting a recipient must
-- not erase their send history. recipient_zalo_uid is denormalized (NOT
-- NULL) precisely so a log row — and retryFailedNotification() — remains
-- fully usable even after the recipient row is gone.
-- ------------------------------------------------------------
CREATE TABLE public.notification_logs (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type              text          NOT NULL,
  recipient_id            uuid          REFERENCES public.notification_recipients(id) ON DELETE SET NULL,
  recipient_zalo_uid      text          NOT NULL,
  entity_type             text,
  entity_id               text,
  dedupe_key              text,
  message_text            text          NOT NULL,
  status                  text          NOT NULL,
  provider_message_id     text,
  provider_error_code     text,
  provider_error_message  text,
  sent_at                 timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT notification_logs_status_check CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
);

CREATE INDEX idx_notification_logs_event_type   ON public.notification_logs (event_type);
CREATE INDEX idx_notification_logs_created_at   ON public.notification_logs (created_at);
CREATE INDEX idx_notification_logs_status       ON public.notification_logs (status);
CREATE INDEX idx_notification_logs_recipient_id ON public.notification_logs (recipient_id);
CREATE INDEX idx_notification_logs_dedupe_key   ON public.notification_logs (dedupe_key);

-- Dedupe guard, deliberately NOT a hard global unique: only blocks a SECOND
-- 'sent' row for the same (event_type, recipient_id, dedupe_key) triple.
-- pending/failed/skipped rows for that same triple are unrestricted, so a
-- failed attempt can always be retried (and will still correctly end up
-- blocked from double-sending once one attempt succeeds).
CREATE UNIQUE INDEX idx_notification_logs_dedupe_sent_unique
  ON public.notification_logs (event_type, recipient_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'sent';

ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view notification_logs"
  ON public.notification_logs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert notification_logs"
  ON public.notification_logs FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update notification_logs"
  ON public.notification_logs FOR UPDATE
  TO authenticated
  USING (true);
-- No DELETE policy: logs are an append/update-only audit trail.
