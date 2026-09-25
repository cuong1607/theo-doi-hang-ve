// ============================================================
// PHASE ZL1: Minimal rate limit for POST /api/zalo/test-message.
//
// Process-local, in-memory sliding window — NOT distributed. This project
// has no Redis/Upstash infra, and building one just for a low-traffic
// admin-only test endpoint would be over-engineering for this phase's
// scope. Good enough to stop an accidental double-click or a runaway
// script from hammering Zalo's API; resets on every redeploy/cold start,
// and does not coordinate across multiple server instances. If this
// endpoint ever sees real concurrent traffic, replace with a real
// distributed limiter — see docs/zalo-integration.md's Troubleshooting.
// ============================================================

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 3;

const hits = new Map<string, number[]>();

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((recent[0] + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  recent.push(now);
  hits.set(key, recent);
  return { allowed: true };
}
