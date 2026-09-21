import { createClient } from "@supabase/supabase-js";

// Server-only. Uses the service_role key, which bypasses RLS entirely — never
// import this from a Client Component or expose SUPABASE_SERVICE_ROLE_KEY via
// NEXT_PUBLIC_*. This is a stand-in until Phase 5 (Authentication) lands a
// per-user server client that can rely on RLS instead.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
