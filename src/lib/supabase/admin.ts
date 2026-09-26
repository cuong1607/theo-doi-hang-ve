import "server-only";

import { createClient } from "@supabase/supabase-js";

// Server-only (enforced by the "server-only" import: bundling this into a
// Client Component fails the build). Uses the service_role key, which
// bypasses RLS — so every caller must have authorized the request first via
// src/lib/auth/session.ts. Never expose SUPABASE_SERVICE_ROLE_KEY via
// NEXT_PUBLIC_*.
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
