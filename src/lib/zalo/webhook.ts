// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part B): Zalo OA webhook — authenticity check
// and event parsing. Pure (no I/O, no "server-only") so `node --test` can
// import it; the route lives in src/app/api/zalo/webhook/route.ts.
//
// Signature (X-ZEvent-Signature): "mac=" + sha256_hex(app_id + raw body +
// timestamp + OA secret key), timestamp = the body's "timestamp" field.
// Source: Zalo developer community threads + third-party write-ups (no
// official spec page could be fetched) → VERIFY against the first real event
// before enabling (docs/zalo-ai-agent-architecture.md §4). Fails CLOSED:
// missing secret / header / timestamp, wrong app, stale timestamp → reject.
//
// Never logged: the secret, the signature, the raw body.
// ============================================================
import { createHash, timingSafeEqual } from "node:crypto";

/** Accept events whose timestamp is within this window (replay protection; idempotency covers redelivery). */
export const ZALO_WEBHOOK_MAX_SKEW_MS = 15 * 60 * 1000;

export type ZaloWebhookVerifyResult = { ok: true } | { ok: false; reason: "not_configured" | "missing_signature" | "malformed_body" | "app_mismatch" | "stale_timestamp" | "bad_signature" };

export function zaloWebhookMac(appId: string, rawBody: string, timestamp: string, oaSecretKey: string): string {
  return createHash("sha256").update(`${appId}${rawBody}${timestamp}${oaSecretKey}`, "utf8").digest("hex");
}

export function verifyZaloWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  appId: string | undefined;
  oaSecretKey: string | undefined;
  now: Date;
  maxSkewMs?: number;
}): ZaloWebhookVerifyResult {
  if (!input.appId || !input.oaSecretKey) return { ok: false, reason: "not_configured" };
  const header = input.signatureHeader?.trim() ?? "";
  const m = /^mac=([0-9a-f]{64})$/i.exec(header);
  if (!m) return { ok: false, reason: "missing_signature" };
  let body: { app_id?: unknown; timestamp?: unknown };
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, reason: "malformed_body" };
  }
  if (!body || typeof body !== "object") return { ok: false, reason: "malformed_body" };
  if (String(body.app_id ?? "") !== input.appId) return { ok: false, reason: "app_mismatch" };
  const ts = String(body.timestamp ?? "");
  if (!/^\d{10,16}$/.test(ts)) return { ok: false, reason: "malformed_body" };
  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(input.now.getTime() - tsMs) > (input.maxSkewMs ?? ZALO_WEBHOOK_MAX_SKEW_MS)) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(zaloWebhookMac(input.appId, input.rawBody, ts, input.oaSecretKey), "hex");
  const given = Buffer.from(m[1].toLowerCase(), "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

export type ZaloWebhookEvent =
  | { kind: "text"; eventName: "user_send_text"; senderId: string; recipientId: string; messageId: string; text: string; timestamp: string }
  | { kind: "unsupported"; eventName: string };

/** Only user_send_text is handled; everything else (images, follow, seen …) is acknowledged and ignored. */
export function parseZaloWebhookEvent(rawBody: string): ZaloWebhookEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { kind: "unsupported", eventName: "malformed" };
  }
  const eventName = typeof body.event_name === "string" ? body.event_name : "unknown";
  if (eventName !== "user_send_text") return { kind: "unsupported", eventName: eventName.slice(0, 64) };
  const sender = (body.sender ?? {}) as { id?: unknown };
  const recipient = (body.recipient ?? {}) as { id?: unknown };
  const message = (body.message ?? {}) as { text?: unknown; msg_id?: unknown };
  const senderId = String(sender.id ?? "");
  const messageId = String(message.msg_id ?? "");
  const text = typeof message.text === "string" ? message.text : "";
  if (!/^[0-9]{1,32}$/.test(senderId) || !messageId || messageId.length > 128 || !text.trim()) return { kind: "unsupported", eventName: "user_send_text_invalid" };
  return { kind: "text", eventName, senderId, recipientId: String(recipient.id ?? ""), messageId, text: text.slice(0, 2000), timestamp: String(body.timestamp ?? "") };
}
