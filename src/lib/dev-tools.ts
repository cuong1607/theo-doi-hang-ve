// ============================================================
// PHASE LOCAL-LIVE-1 §9: gate for developer-only controls (run the
// scheduler / worker by hand, enqueue without kicking the worker).
//
// On: `next dev` (NODE_ENV !== "production"), or a local production build
// started with APP_ENV=local. Vercel builds run with NODE_ENV=production
// and must never set APP_ENV=local → the controls are not rendered and
// every dev action refuses.
// ============================================================
type Env = Record<string, string | undefined>;

export function devToolsEnabled(env: Env = process.env): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.NODE_ENV !== "production" || env.APP_ENV?.trim().toLowerCase() === "local";
}
