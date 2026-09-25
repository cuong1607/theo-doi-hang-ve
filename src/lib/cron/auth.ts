// PHASE ZL6: shared auth check for /api/cron/* routes — completely separate
// from the app's role system (canManageNotificationRecipients/getCurrentRole).
// A cron invocation isn't a logged-in user, so it's never gated by
// NEXT_PUBLIC_MOCK_ROLE; it's gated by a secret only Vercel (and whoever
// configures the Vercel project's env vars) knows.
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
