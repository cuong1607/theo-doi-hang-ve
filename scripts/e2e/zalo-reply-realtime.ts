// ============================================================
// PHASE 04.5.1 — realtime check against a LOCAL dev server (no Zalo, no cron):
// a signed worker POST of one 1-1 message → the events endpoint's after()
// fast tick → draft auto-queued → the signed claim hands the job out.
// Measures each latency. Local Supabase only; every row it creates is removed.
//
//   dev server:  $env:PERSONAL_AUTO_REPLY_ENABLED="true"; npm run dev
//   run:         node --env-file=.env.local --experimental-strip-types scripts/e2e/zalo-reply-realtime.ts [http://localhost:3000]
// ============================================================
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { encryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { workerSecretContext } from "../../src/lib/zalo-personal/config.ts";
import { generateWorkerSecret, HEADER, newNonce, secretKeyBytes, sign } from "../../src/lib/zalo-personal/signing.ts";

const BASE = process.argv[2] ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) || !/localhost|127\.0\.0\.1/.test(BASE)) throw new Error("local only");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const encKey = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);

const RUN = randomBytes(3).toString("hex");
const T0 = Date.now();
const ACC = `95${T0}`.slice(0, 17);
const ASKER = `75${T0}1`.slice(0, 18);
const KEY = `rt-${RUN}`;
const WORKER_KEY = `rtw-${RUN}`;
const created = { user: "", conn: "" };

async function signedPost(path: string, secret: string, payload: unknown) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = newNonce();
  const signature = sign(secretKeyBytes(secret), { method: "POST", path, workerKey: WORKER_KEY, timestamp, nonce, rawBody });
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", [HEADER.worker]: WORKER_KEY, [HEADER.timestamp]: timestamp, [HEADER.nonce]: nonce, [HEADER.signature]: signature }, body: rawBody });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function main() {
  // ---- fixture: owner, connection (content), worker, bound account, linked asker, auto settings, verified path
  const u = await db.auth.admin.createUser({ email: `rt-${RUN}@example.test`, password: `Pw-${randomBytes(8).toString("hex")}`, email_confirm: true });
  if (u.error || !u.data.user) throw new Error(`createUser ${u.error?.message}`);
  created.user = u.data.user.id;
  await db.from("profiles").update({ is_active: true, role: "admin", full_name: "RT owner" }).eq("id", created.user);
  const c = await db.from("zalo_personal_connections").insert({ connection_key: KEY, owner_user_id: created.user, direct_message_mode: "content" }).select("id").single();
  if (c.error) throw new Error(c.error.message);
  created.conn = c.data.id;
  const workerId = randomUUID();
  const secret = generateWorkerSecret();
  await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: WORKER_KEY, connection_id: created.conn, secret_encrypted: encryptSecret(secret, encKey, workerSecretContext(workerId)) });
  const hb = await db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: ACC, p_state: { workerVersion: "rt", workerStartedAt: new Date().toISOString(), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: null, lastDeliveryOkAt: null, outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null } });
  assert.equal(hb.data?.ok, true, "heartbeat");
  await db.from("ai_channel_identities").insert({ channel: "zalo_personal", connection_id: created.conn, external_user_id: ASKER, internal_user_id: created.user, verified_via: "link_code" });
  await db.from("zalo_personal_reply_settings").upsert({ connection_id: created.conn, reply_mode: "auto", cooldown_seconds: 5 });
  // verified sending path = one manually approved reply already delivered by this connection
  const seedAt = new Date(Date.now() - 3_600_000).toISOString();
  const seed = await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: ACC, p_events: [ev("seed", "câu hỏi cũ", seedAt)] });
  assert.equal(seed.data?.ok, true, JSON.stringify(seed.data ?? seed.error));
  const seedMsg = (await db.from("zalo_personal_messages").select("id, conversation_id").eq("connection_id", created.conn).single()).data!;
  const inb = (await db.from("zalo_personal_reply_inbound").insert({ connection_id: created.conn, conversation_id: seedMsg.conversation_id, message_id: seedMsg.id, sender_external_id: ASKER, trigger: "direct", status: "done" }).select("id").single()).data!;
  await db.from("zalo_personal_reply_drafts").insert({ connection_id: created.conn, conversation_id: seedMsg.conversation_id, conversation_type: "user", inbound_id: inb.id, source_message_id: seedMsg.id, asker_external_id: ASKER, asker_user_id: created.user, audience: "private", kind: "ai_answer", pipeline: "system", status: "sent", approval: "manual", approved_by: created.user, approved_at: seedAt, original_text: "cũ", text: "cũ", sent_at: seedAt, sending_started_at: seedAt, expires_at: new Date(Date.now() + 3_600_000).toISOString() });

  // ---- the realtime path
  const t0 = Date.now();
  const post = await signedPost("/api/internal/zalo-personal/events", secret, { v: 1, connectionKey: KEY, accountId: ACC, events: [ev("q1", "công nợ là gì?")] });
  const tIngest = Date.now() - t0;
  assert.equal(post.status, 200, JSON.stringify(post.body));
  const msgId = (await db.from("zalo_personal_messages").select("id").eq("connection_id", created.conn).eq("external_message_id", `rt${RUN}q1`).single()).data!.id;

  let draft: Record<string, unknown> | null = null;
  while (Date.now() - t0 < 30_000) {
    draft = (await db.from("zalo_personal_reply_drafts").select("id, kind, status, approval, response_status, created_at").eq("source_message_id", msgId).maybeSingle()).data;
    if (draft) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const tDraft = Date.now() - t0;
  assert.ok(draft, "no draft within 30 s: the fast path did not run (is PERSONAL_REPLY_ENABLED on the dev server?)");
  assert.deepEqual([draft.kind, draft.status, draft.approval], ["ai_answer", "queued", "auto"], `auto needs PERSONAL_AUTO_REPLY_ENABLED=true on the dev server — got ${JSON.stringify(draft)}`);

  const claim = await signedPost("/api/internal/zalo-personal/outbound/claim", secret, { v: 1, connectionKey: KEY, accountId: ACC, listenerState: "active" });
  const tClaim = Date.now() - t0;
  const job = claim.body?.job as Record<string, unknown> | null;
  assert.ok(job, `claim gave no job: ${JSON.stringify(claim.body)}`);
  assert.equal(job.draftId, draft.id);
  assert.equal(job.threadType, "user");
  assert.equal(job.threadId, ASKER);
  console.log(JSON.stringify({ ok: true, ingestMs: tIngest, draftQueuedMs: tDraft, claimMs: tClaim, responseStatus: draft.response_status, text: String(job.text).slice(0, 80) }));
}

let seq = 0;
function ev(key: string, text: string, at = new Date().toISOString()) {
  seq++;
  return { eventKey: createHash("sha256").update(`rt|${RUN}|${seq}`).digest("hex"), kind: "message", conversationType: "user", conversationId: ASKER, externalMessageId: `rt${RUN}${key}`, senderId: ASKER, messageType: "text", text, textLength: text.length, mentions: [], mentionsSelf: false, isSelf: false, subtype: null, sentAt: at, receivedAt: at };
}

async function cleanup() {
  if (created.conn) {
    for (const t of ["zalo_personal_reply_audit", "zalo_personal_reply_drafts", "zalo_personal_reply_inbound", "zalo_personal_reply_scan_state", "zalo_personal_reply_settings", "ai_channel_identities", "zalo_personal_audit_log", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_sync_state", "zalo_personal_request_nonces"]) {
      const r = t === "zalo_personal_request_nonces" ? await db.from(t).delete().in("worker_id", (await db.from("zalo_personal_workers").select("id").eq("connection_id", created.conn)).data?.map((w) => w.id) ?? []) : await db.from(t).delete().eq("connection_id", created.conn);
      if (r.error && !/does not exist|column/.test(r.error.message)) console.error(t, r.error.message);
    }
    await db.from("zalo_personal_workers").delete().eq("connection_id", created.conn);
    await db.from("zalo_personal_connections").delete().eq("id", created.conn);
  }
  if (created.user) {
    for (const t of ["ai_system_requests", "ai_request_usage"]) await db.from(t).delete().eq("user_id", created.user);
    await db.auth.admin.deleteUser(created.user);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(cleanup);
