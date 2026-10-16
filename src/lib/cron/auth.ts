// PHASE ZL6: shared auth check for /api/cron/* routes — completely separate
// from the app's user auth (src/lib/auth/session.ts). A cron invocation
// isn't a logged-in user (the proxy lets /api/cron/* through without a
// session), so it's gated by a secret only Vercel (and whoever configures
// the Vercel project's env vars) knows.
//
// Pure — takes the header value and the expected secret as plain arguments
// rather than reading `process.env`/`Request` itself, so it's unit-testable
// with plain `node --test`. Route handlers call it as
// `isAuthorizedCronSecret(request.headers.get("authorization"), process.env.CRON_SECRET)`.
//
// Vercel Cron Jobs send `Authorization: Bearer $CRON_SECRET` automatically
// once CRON_SECRET is set in the project's env vars — this is the current
// documented mechanism (vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
// Flagged here for the user to re-verify against Vercel's docs once before
// relying on it in production, same as ZL1 flagged the Zalo endpoint URLs.
export function isAuthorizedCronSecret(authHeader: string | null, expectedSecret: string | undefined): boolean {
  if (!expectedSecret) return false; // fail closed — misconfiguration must never mean "open to anyone"
  return authHeader === `Bearer ${expectedSecret}`;
}

/**
 * Internal endpoints (/api/internal/*): SHOPEE_SYNC_INTERNAL_SECRET
 * (SHOPEE-PERF-2 name — pg_cron sends it), SYNC_WORKER_SECRET (PERF-1 name,
 * still accepted) or CRON_SECRET (what Vercel Cron sends). None set →
 * always refused.
 */
const INTERNAL_SECRET_VARS = ["SHOPEE_SYNC_INTERNAL_SECRET", "SYNC_WORKER_SECRET", "CRON_SECRET"] as const;

export function isAuthorizedInternalRequest(authHeader: string | null, env: Record<string, string | undefined>): boolean {
  return INTERNAL_SECRET_VARS.some((name) => isAuthorizedCronSecret(authHeader, env[name]));
}

/** The secret this server uses to call its own internal endpoints (first one set). */
export function internalSecret(env: Record<string, string | undefined>): string | null {
  for (const name of INTERNAL_SECRET_VARS) if (env[name]) return env[name]!;
  return null;
}
