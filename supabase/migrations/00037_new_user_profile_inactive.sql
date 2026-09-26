-- ============================================================
-- AUTH fix: 00036's handle_new_auth_user activated a profile when
-- app_metadata.provisioned_by_admin was set, but Supabase Auth (GoTrue)
-- writes custom app_metadata in a separate UPDATE *after* the INSERT that
-- fires the trigger — so the flag is never visible there (verified live).
--
-- Deterministic rule instead: every new auth user gets an INACTIVE viewer
-- profile. The admin-driven creation paths (the /users "Thêm người dùng"
-- server action and scripts/auth/create-admin.ts) activate the profile —
-- and set its role — themselves, with the service-role key, right after
-- creating the user. Any other way an auth user appears (public signup if
-- enabled on the project, Supabase dashboard "Add user") stays locked out
-- until an admin activates it on /users.
-- ============================================================
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
    false
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
