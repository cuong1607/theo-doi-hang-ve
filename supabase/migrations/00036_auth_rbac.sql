-- ============================================================
-- PHASE AUTHENTICATION AND AUTHORIZATION
--
-- Architecture (see docs/authentication-authorization.md):
--   * Supabase Auth identifies the user; public.profiles holds role +
--     is_active. Only an ACTIVE profile may use the app.
--   * Every business read/write in the app runs server-side (server
--     components, server actions, route handlers) with the service-role
--     client, AFTER the app's own authorization check (src/lib/auth/session.ts).
--   * The database is locked down for direct client access (anon key + user
--     JWT via PostgREST): anon gets nothing; authenticated gets READ-ONLY,
--     RLS-filtered access (active users only; notification tables admin
--     only; profiles = own row or admin). No INSERT/UPDATE/DELETE policy and
--     no write privilege exists for anon/authenticated on any public table,
--     so a user can never mutate data — or their own role/is_active —
--     except through the authorized server paths.
-- Custom SQLSTATE: AU001 = would leave no active admin.
-- ============================================================


-- ------------------------------------------------------------
-- 1. profiles: align with the expected model
-- (role CHECK admin/staff/viewer already exists since 00001.)
-- ------------------------------------------------------------
ALTER TABLE public.profiles ALTER COLUMN full_name DROP NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'viewer';


-- ------------------------------------------------------------
-- 2. RLS helper functions
--
-- SECURITY DEFINER so policies can read profiles without recursing into
-- profiles' own RLS. search_path pinned to '' (all names qualified).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_active_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active;
$$;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.current_active_role() IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.has_any_role(p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(public.current_active_role() = ANY (p_roles), false);
$$;

REVOKE EXECUTE ON FUNCTION public.current_active_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_any_role(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_active_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_any_role(text[]) TO authenticated, service_role;


-- ------------------------------------------------------------
-- 3. Auto-create a profile for every new auth user
--
-- Always role = 'viewer' (never admin by default). is_active depends on HOW
-- the user was created — this is an internal system with admin-provisioned
-- accounts only:
--   * created by the app's /users page or the bootstrap script → the
--     server sets app_metadata.provisioned_by_admin = true (app_metadata is
--     writable ONLY with the service-role key) → active.
--   * anything else (public signup if it were left enabled in the Supabase
--     project, or "Add user" in the Supabase dashboard) → INACTIVE until an
--     admin activates it on /users. A stranger who signs up with the public
--     anon key therefore gets no access at all.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role, is_active)
  VALUES (
    NEW.id,
    NULLIF(btrim(NEW.raw_user_meta_data->>'full_name'), ''),
    'viewer',
    COALESCE((NEW.raw_app_meta_data->>'provisioned_by_admin')::boolean, false)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- Backfill any auth user that predates the trigger (none at the time of
-- writing) — inactive viewers, never auto-promoted.
INSERT INTO public.profiles (id, full_name, role, is_active)
SELECT u.id, NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''), 'viewer', false
FROM auth.users u
ON CONFLICT (id) DO NOTHING;


-- ------------------------------------------------------------
-- 4. Admin safety: never leave the system without an active admin
--
-- Enforced in the database (covers role change, deactivation and deletion
-- — including deleting the auth user, which cascades to profiles), not just
-- in the /users server actions. A transaction-scoped advisory lock
-- serializes concurrent admin changes so two admins demoting each other at
-- the same moment can't both succeed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_last_active_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (OLD.role = 'admin' AND OLD.is_active) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.is_active THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(34002, 1);

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.role = 'admin' AND p.is_active AND p.id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'Phải có ít nhất một tài khoản admin đang hoạt động.' USING ERRCODE = 'AU001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_last_active_admin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_last_active_admin ON public.profiles;
CREATE TRIGGER guard_last_active_admin
  BEFORE UPDATE OF role, is_active OR DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_last_active_admin();


-- ------------------------------------------------------------
-- 5. Table privileges: anon nothing, authenticated read-only
-- ------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Future tables/sequences created by migrations: same baseline (00003 had
-- granted full CRUD by default).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- Views ran with their OWNER's rights (bypassing RLS) — anyone holding the
-- public anon key could read v_outstanding, v_invoice_debt, ... directly.
-- security_invoker makes them evaluate the caller's privileges + RLS.
ALTER VIEW public.v_daily_receipt_summary         SET (security_invoker = true);
ALTER VIEW public.v_daily_receipt_product_summary SET (security_invoker = true);
ALTER VIEW public.v_receipt_summary               SET (security_invoker = true);
ALTER VIEW public.v_outstanding                   SET (security_invoker = true);
ALTER VIEW public.v_invoice_summary               SET (security_invoker = true);
ALTER VIEW public.v_invoice_debt                  SET (security_invoker = true);
ALTER VIEW public.v_supplier_debt_summary         SET (security_invoker = true);
ALTER VIEW public.v_payment_summary               SET (security_invoker = true);


-- ------------------------------------------------------------
-- 6. RLS policies: replace every "authenticated can do everything" policy
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'profiles', 'suppliers', 'products', 'receipts', 'receipt_items',
        'invoices', 'invoice_items', 'invoice_receipt_days', 'payments', 'payment_items',
        'notification_recipients', 'notification_logs', 'notification_event_states'
      )
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END;
$$;

-- Business data: readable by any ACTIVE user (admin/staff/viewer all may
-- view it — see the permission matrix). Inactive or unknown users see
-- nothing.
CREATE POLICY active_users_select ON public.suppliers            FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.products             FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.receipts             FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.receipt_items        FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.invoices             FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.invoice_items        FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.invoice_receipt_days FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.payments             FOR SELECT TO authenticated USING (public.is_active_user());
CREATE POLICY active_users_select ON public.payment_items        FOR SELECT TO authenticated USING (public.is_active_user());

-- Notification config/history: admin only.
CREATE POLICY admins_select ON public.notification_recipients   FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['admin']));
CREATE POLICY admins_select ON public.notification_logs         FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['admin']));
CREATE POLICY admins_select ON public.notification_event_states FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['admin']));

-- Profiles: a user may read their own row (even when inactive, so the app
-- can tell them their account is disabled); an active admin may read all.
-- No UPDATE policy: nobody changes role/is_active (or anything else)
-- through the API with their own JWT — only the admin user-management
-- server actions can, after checking user:manage.
CREATE POLICY own_or_admin_select ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_any_role(ARRAY['admin']));

-- zalo_connections, receipt_no_counters: RLS on, no policies (unchanged).
