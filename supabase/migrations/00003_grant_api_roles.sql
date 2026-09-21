-- ============================================================
-- Fix: missing baseline table privileges for API roles
-- ============================================================
-- Phase 3's migration enabled RLS and added policies, but never
-- GRANTed the underlying table privileges. RLS only filters rows
-- once a role is already allowed to touch the table — without the
-- GRANT below, anon/authenticated/service_role all get
-- "permission denied for table ..." regardless of RLS policies.
--
-- anon/authenticated stay effectively read/write-limited by their
-- existing RLS policies (anon has no policies at all, so it still
-- sees zero rows); service_role bypasses RLS by role attribute and
-- needs this GRANT to access tables at all.
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO anon, authenticated, service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO anon, authenticated, service_role;

-- Apply the same baseline to tables/sequences created by future migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;
