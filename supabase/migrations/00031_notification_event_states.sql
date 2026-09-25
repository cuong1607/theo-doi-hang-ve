-- ============================================================
-- PHASE ZL4: Low stock / outstanding alert — state tracking
--
-- notification_logs (00029) alone isn't enough to tell whether a SKU
-- "just transitioned" into an alert-worthy status, since it's a flat send
-- history, not a current-state snapshot. This table stores exactly one row
-- per (event_type, entity_type, entity_id) — its CURRENT status — so
-- evaluateOutstandingNotifications() can compare "new status" against
-- "last known status" and only alert on an actual transition (never on
-- every re-evaluation of an unchanged status).
--
-- No FK on entity_id (kept as text, not uuid) — this table is meant to be
-- reusable by future state-tracked events beyond invoice_item outstanding
-- status, not just this one entity_type.
-- ============================================================
CREATE TABLE public.notification_event_states (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     text        NOT NULL,
  current_state text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (event_type, entity_type, entity_id)
);

CREATE INDEX idx_notification_event_states_entity
  ON public.notification_event_states (entity_type, entity_id);

ALTER TABLE public.notification_event_states ENABLE ROW LEVEL SECURITY;

-- Same tier as notification_recipients/notification_logs (00029): full
-- CRUD for authenticated, app layer enforces admin-only where it matters.
-- No DELETE policy — a state row gets overwritten via upsert, never
-- deleted, mirroring notification_logs' append/update-only convention.
CREATE POLICY notification_event_states_select ON public.notification_event_states
  FOR SELECT TO authenticated USING (true);

CREATE POLICY notification_event_states_insert ON public.notification_event_states
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY notification_event_states_update ON public.notification_event_states
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
