// ============================================================
// ZALO PERSONAL Phase 02 — send SIGNED mock events to the ingestion API
// (no Zalo account involved). For local testing against `next dev`.
//
//   ZP_MOCK_URL=http://localhost:3000 ZP_WORKER_KEY=… ZP_INGEST_SECRET=zps_… \
//   ZP_CONNECTION_KEY=primary ZP_ACCOUNT_ID=<numeric> \
//   node scripts/zalo-personal/send-mock-event.ts <command> [--flags]
//
//   heartbeat
//   message  --group <id> [--text "…"] [--msg-id <id>] [--mention-self]
//   direct   --user <id>  [--text "…"]
//   replay                        same request twice (2nd must be 409 nonce_reused)
//   bad-signature                 must be 401
//   oversized                     must be 413
// Prints status + response body (the body never contains message text).
// ============================================================
import { createHash, randomBytes } from "node:crypto";

import { HEADER, newNonce, secretKeyBytes, sign } from "../../src/lib/zalo-personal/signing.ts";

const env = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Thiếu ${name}`);
  return v;
};

function flags(argv: string[]): Record<string, string | true> {
  const f: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) f[a.slice(2)] = true;
    else {
      f[a.slice(2)] = next;
      i++;
    }
  }
  return f;
}

async function send(path: string, rawBody: string, opts: { nonce?: string; secret?: string } = {}) {
  const base = env("ZP_MOCK_URL");
  const workerKey = env("ZP_WORKER_KEY");
  const timestamp = String(Date.now());
  const nonce = opts.nonce ?? newNonce();
  const signature = sign(secretKeyBytes(opts.secret ?? env("ZP_INGEST_SECRET")), { method: "POST", path, workerKey, timestamp, nonce, rawBody });
  const res = await fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json", [HEADER.worker]: workerKey, [HEADER.timestamp]: timestamp, [HEADER.nonce]: nonce, [HEADER.signature]: signature },
    body: rawBody,
  });
  const cors = res.headers.get("access-control-allow-origin");
  process.stdout.write(`${path} → ${res.status} ${await res.text()}${cors ? ` (CORS header present: ${cors})` : ""}\n`);
  return res.status;
}

const EVENTS = "/api/internal/zalo-personal/events";
const HEARTBEAT = "/api/internal/zalo-personal/heartbeat";

function messageEvent(conversationType: "group" | "user", conversationId: string, text: string, msgId: string, mentionsSelf: boolean) {
  const connectionKey = env("ZP_CONNECTION_KEY");
  return {
    eventKey: createHash("sha256").update(`mock|${connectionKey}|${conversationType}|${conversationId}|${msgId}`).digest("hex"),
    kind: "message",
    conversationType,
    conversationId,
    externalMessageId: msgId,
    senderId: "3000000000000000001",
    messageType: "text",
    text,
    textLength: text.length,
    mentions: [],
    mentionsSelf,
    isSelf: false,
    subtype: null,
    sentAt: new Date(Date.now() - 1000).toISOString(),
    receivedAt: new Date().toISOString(),
  };
}

const batch = (events: unknown[]) => JSON.stringify({ v: 1, connectionKey: env("ZP_CONNECTION_KEY"), accountId: env("ZP_ACCOUNT_ID"), events });

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const f = flags(rest);
  const msgId = typeof f["msg-id"] === "string" ? f["msg-id"] : `${Date.now()}`;
  const text = typeof f.text === "string" ? f.text : "tin thử nghiệm (mock)";
  switch (command) {
    case "heartbeat":
      await send(HEARTBEAT, JSON.stringify({ v: 1, connectionKey: env("ZP_CONNECTION_KEY"), accountId: env("ZP_ACCOUNT_ID"), workerVersion: "mock-0.2.0", workerStartedAt: new Date().toISOString(), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: null, lastDeliveryOkAt: null, outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null }));
      return;
    case "message":
      await send(EVENTS, batch([messageEvent("group", String(f.group), text, msgId, f["mention-self"] === true)]));
      return;
    case "direct":
      await send(EVENTS, batch([messageEvent("user", String(f.user), text, msgId, false)]));
      return;
    case "replay": {
      const body = batch([messageEvent("group", String(f.group ?? "2547837462290891500"), text, msgId, false)]);
      const nonce = newNonce();
      await send(EVENTS, body, { nonce });
      await send(EVENTS, body, { nonce });
      return;
    }
    case "bad-signature":
      await send(EVENTS, batch([messageEvent("group", "2547837462290891500", text, msgId, false)]), { secret: `zps_${randomBytes(32).toString("base64url")}` });
      return;
    case "oversized":
      await send(EVENTS, "x".repeat(600 * 1024));
      return;
    default:
      process.stdout.write("Lệnh: heartbeat | message | direct | replay | bad-signature | oversized\n");
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`Lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
