// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part B): Zalo webhook request handling,
// transport side only. Pure + injected (no "server-only") so the whole
// verify → parse → dedupe/store path is unit-testable; the route answers
// with the result and runs processing in after().
//
// Order: feature flag → signature (fail closed) → event type → own OA →
// per-sender rate limit → accept (store + dedupe). Nothing analytical here.
// ============================================================
import type { AcceptedMessage, IncomingMessage } from "../conversation/service.ts";
import { parseZaloWebhookEvent, verifyZaloWebhookSignature } from "./webhook.ts";

export interface ZaloWebhookConfig {
  enabled: boolean;
  appId: string | undefined;
  oaSecretKey: string | undefined;
  oaId: string | undefined;
}

export function getZaloWebhookConfig(env: Record<string, string | undefined> = process.env): ZaloWebhookConfig {
  return {
    enabled: ["true", "1", "on", "yes"].includes((env.ZALO_CONVERSATION_ENABLED ?? "").trim().toLowerCase()),
    appId: env.ZALO_APP_ID?.trim() || undefined,
    oaSecretKey: env.ZALO_OA_SECRET_KEY?.trim() || undefined,
    oaId: env.ZALO_OA_ID?.trim() || undefined,
  };
}

export type ZaloWebhookOutcome =
  | { status: 200; body: { ok: true; ignored: "disabled" | "unsupported_event" | "other_oa" | "rate_limited" | "duplicate" } }
  | { status: 200; body: { ok: true; accepted: true }; accepted: AcceptedMessage }
  | { status: 401 | 503; body: { ok: false; error: string } };

/** Per-sender sliding window (process-local; Zalo traffic of an allowlisted rollout is tiny). */
export class SenderRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max = 20, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear(); // bounded memory
    return true;
  }
}

export async function handleZaloWebhookRequest(
  input: { rawBody: string; signatureHeader: string | null; config: ZaloWebhookConfig; now: Date },
  deps: { accept: (message: IncomingMessage) => Promise<AcceptedMessage | null>; limiter: SenderRateLimiter },
): Promise<ZaloWebhookOutcome> {
  const { config } = input;
  if (!config.enabled) return { status: 200, body: { ok: true, ignored: "disabled" } };
  const verified = verifyZaloWebhookSignature({ rawBody: input.rawBody, signatureHeader: input.signatureHeader, appId: config.appId, oaSecretKey: config.oaSecretKey, now: input.now });
  if (!verified.ok) {
    // metadata only: never the header, the body or the secret
    console.warn(JSON.stringify({ source: "zalo-webhook", event: "rejected", reason: verified.reason }));
    return verified.reason === "not_configured" ? { status: 503, body: { ok: false, error: "not_configured" } } : { status: 401, body: { ok: false, error: "invalid_signature" } };
  }
  const event = parseZaloWebhookEvent(input.rawBody);
  if (event.kind !== "text") return { status: 200, body: { ok: true, ignored: "unsupported_event" } };
  if (config.oaId && event.recipientId && event.recipientId !== config.oaId) return { status: 200, body: { ok: true, ignored: "other_oa" } };
  if (!deps.limiter.allow(event.senderId, input.now.getTime())) return { status: 200, body: { ok: true, ignored: "rate_limited" } };
  const accepted = await deps.accept({ channel: "zalo", externalUserId: event.senderId, providerMessageId: event.messageId, text: event.text, receivedAt: input.now });
  if (!accepted) return { status: 200, body: { ok: true, ignored: "duplicate" } };
  return { status: 200, body: { ok: true, accepted: true }, accepted };
}
