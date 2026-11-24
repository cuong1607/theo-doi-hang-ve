// ============================================================
// ZALO PERSONAL — self-service setup (00076) against the LOCAL Supabase:
// real SupabaseDashboardStore, real SQL functions, real Phase 02 heartbeat.
// Covers: owner = caller, limits, 1-1 content never self-service, viewer
// refused by the DB, worker secret encrypted with its id (decryptable, works
// with the real heartbeat RPC), revoke / pause take effect on the next
// request, other users can't act on a connection, audit rows, RLS.
// Run: node --env-file=<local env> --test src/lib/zalo-personal/dashboard/self-service.integration.test.ts
// ============================================================
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, encryptSecret, parseEncryptionKey } from "../../security/secrets.ts";
import { workerSecretContext } from "../config.ts";
import { generateWorkerSecret } from "../signing.ts";
import { createConnection, issueWorker, revokeWorker, setConnectionStatus, type SelfServiceDeps } from "./self-service.ts";
import { listConnections } from "./service.ts";
import { SupabaseDashboardStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db: SupabaseClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const key = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
const store = new SupabaseDashboardStore(db);
const deps: SelfServiceDeps = { dashboard: store, store, secrets: { generate: generateWorkerSecret, encrypt: (s, id) => encryptSecret(s, key, workerSecretContext(id)), newId: () => randomUUID() } };

const RUN = randomBytes(3).toString("hex");
const PASSWORD = `Pw-${randomBytes(8).toString("hex")}`;
const users = { staff: "", other: "", viewer: "" };
const created: string[] = [];
const ACCOUNT = `85${Date.now()}`.slice(0, 18);

async function mk(k: keyof typeof users, role: "staff" | "viewer") {
  const { data, error } = await db.auth.admin.createUser({ email: `zpss-${k}-${RUN}@example.test`, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message);
  created.push(data.user.id);
  await db.from("profiles").update({ is_active: true, role, full_name: `SS ${k}` }).eq("id", data.user.id);
  users[k] = data.user.id;
}
const staff = () => ({ userId: users.staff, role: "staff" as const });
const other = () => ({ userId: users.other, role: "staff" as const });
const heartbeat = (workerId: string) => db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: ACCOUNT, p_state: { sessionState: "authenticated", listenerState: "active", outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0 } });

before(async () => {
  await mk("staff", "staff");
  await mk("other", "staff");
  await mk("viewer", "viewer");
});

after(async () => {
  for (const u of created) {
    const conns = ((await db.from("zalo_personal_connections").select("id").eq("owner_user_id", u)).data ?? []).map((c) => c.id);
    for (const id of conns) {
      for (const t of ["zalo_personal_audit_log", "zalo_personal_status_events", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", id);
      await db.from("zalo_personal_connections").delete().eq("id", id);
    }
    await db.auth.admin.deleteUser(u);
  }
});

let connId = "";
let workerId = "";

describe("create a connection (owner = caller)", () => {
  it("staff creates their own connection; it is audited and visible to them only", async () => {
    const r = await createConnection(deps, staff(), { name: "Zalo bán hàng", directMode: "metadata" });
    assert.ok(r.ok, JSON.stringify(r));
    connId = r.data.id;
    const row = (await db.from("zalo_personal_connections").select("owner_user_id, direct_message_mode, status").eq("id", connId).single()).data!;
    assert.deepEqual(row, { owner_user_id: users.staff, direct_message_mode: "metadata", status: "active" });
    const audit = (await db.from("zalo_personal_audit_log").select("action, actor_user_id").eq("connection_id", connId)).data!;
    assert.deepEqual(audit, [{ action: "connection.created", actor_user_id: users.staff }]);
    const mine = await listConnections({ store }, staff());
    assert.ok(mine.ok && mine.data.some((c) => c.id === connId && c.isOwner));
    const theirs = await listConnections({ store }, other());
    assert.equal(theirs.ok ? "ok" : theirs.error, "forbidden", "another user sees nothing");
  });
  it("database rules: 1-1 content never self-service, viewer refused, ≤ 3 per owner, unique key", async () => {
    assert.equal((await db.rpc("zp_create_connection", { p_actor: users.staff, p_key: `c-${RUN}`, p_direct_mode: "content" })).data.error, "invalid_direct_mode");
    assert.equal((await db.rpc("zp_create_connection", { p_actor: users.viewer, p_key: `v-${RUN}`, p_direct_mode: "off" })).data.error, "actor_invalid");
    assert.equal((await db.rpc("zp_create_connection", { p_actor: users.staff, p_key: "Bad Key!", p_direct_mode: "off" })).data.error, "invalid_key");
    const taken = (await db.from("zalo_personal_connections").select("connection_key").eq("id", connId).single()).data!.connection_key;
    assert.equal((await db.rpc("zp_create_connection", { p_actor: users.other, p_key: taken, p_direct_mode: "off" })).data.error, "key_taken");
    assert.ok((await createConnection(deps, staff(), { directMode: "off" })).ok);
    assert.ok((await createConnection(deps, staff(), { directMode: "off" })).ok);
    const fourth = await createConnection(deps, staff(), { directMode: "off" });
    assert.deepEqual(fourth.ok ? null : [fourth.error, fourth.code], ["conflict", "limit_reached"]);
  });
});

describe("worker credential", () => {
  it("only the owner can issue; the secret is encrypted with the worker id and works with the real heartbeat", async () => {
    const denied = await issueWorker(deps, other(), connId, "https://app.example");
    assert.equal(denied.ok ? "ok" : denied.error, "not_found");
    const direct = await db.rpc("zp_issue_worker", { p_actor: users.other, p_connection_id: connId, p_worker_id: randomUUID(), p_worker_key: `x-${RUN}`, p_secret_ciphertext: "v1.x" });
    assert.equal(direct.data.error, "not_found", "the database re-checks ownership too");

    const r = await issueWorker(deps, staff(), connId, "https://app.example");
    assert.ok(r.ok, JSON.stringify(r));
    const w = (await db.from("zalo_personal_workers").select("id, secret_encrypted, status, created_by").eq("worker_key", r.data.workerKey).single()).data!;
    workerId = w.id;
    assert.equal(w.secret_encrypted.includes(r.data.secret), false, "never stored in clear");
    assert.equal(decryptSecret(w.secret_encrypted, key, workerSecretContext(w.id)), r.data.secret);
    assert.throws(() => decryptSecret(w.secret_encrypted, key, workerSecretContext(randomUUID())), "bound to its own id");
    assert.equal(w.created_by, users.staff);
    const hb = await heartbeat(w.id);
    assert.equal(hb.data?.ok, true, JSON.stringify(hb.data));
    const audit = (await db.from("zalo_personal_audit_log").select("action, details").eq("connection_id", connId).eq("action", "worker.issued")).data!;
    assert.equal(audit.length, 1);
    assert.equal(JSON.stringify(audit[0]!.details).includes(r.data.secret), false, "the secret is never audited");
  });
  it("≤ 2 active workers per connection", async () => {
    assert.ok((await issueWorker(deps, staff(), connId, "https://app.example")).ok);
    const third = await issueWorker(deps, staff(), connId, "https://app.example");
    assert.deepEqual(third.ok ? null : third.code, "limit_reached");
  });
  it("revoke: refused for others; for the owner it takes effect on the very next request", async () => {
    const no = await revokeWorker(deps, other(), connId, workerId);
    assert.equal(no.ok ? "ok" : no.error, "not_found");
    const yes = await revokeWorker(deps, staff(), connId, workerId);
    assert.ok(yes.ok && yes.data.changed);
    assert.equal((await heartbeat(workerId)).data?.error, "worker_revoked");
    assert.ok((await revokeWorker(deps, staff(), connId, workerId)).ok, "idempotent");
  });
});

describe("pause / resume", () => {
  it("pausing rejects the connection's traffic; resuming accepts it again; others can't", async () => {
    const w2 = (await db.from("zalo_personal_workers").select("id").eq("connection_id", connId).eq("status", "active").limit(1).single()).data!.id;
    assert.equal((await setConnectionStatus(deps, other(), connId, "disabled")).ok, false);
    assert.ok((await setConnectionStatus(deps, staff(), connId, "disabled")).ok);
    assert.equal((await heartbeat(w2)).data?.error, "connection_disabled");
    const paused = await issueWorker(deps, staff(), connId, "https://app.example");
    assert.deepEqual(paused.ok ? null : paused.code, "connection_paused");
    assert.ok((await setConnectionStatus(deps, staff(), connId, "active")).ok);
    assert.equal((await heartbeat(w2)).data?.ok, true);
    const actions = ((await db.from("zalo_personal_audit_log").select("action").eq("connection_id", connId).order("id")).data ?? []).map((a) => a.action);
    assert.deepEqual(actions.filter((a) => a.startsWith("connection.")), ["connection.created", "connection.paused", "connection.resumed"]);
  });
});

describe("RLS", () => {
  it("browser roles cannot call the self-service functions", async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const authed = createClient(url!, anonKey!, { auth: { persistSession: false } });
    assert.equal((await authed.auth.signInWithPassword({ email: `zpss-staff-${RUN}@example.test`, password: PASSWORD })).error, null);
    for (const c of [anon, authed]) {
      assert.ok((await c.rpc("zp_create_connection", { p_actor: users.staff, p_key: `rls-${RUN}`, p_direct_mode: "off" })).error);
      assert.ok((await c.rpc("zp_issue_worker", { p_actor: users.staff, p_connection_id: connId, p_worker_id: randomUUID(), p_worker_key: `rls-${RUN}`, p_secret_ciphertext: "v1.x" })).error);
      assert.ok((await c.rpc("zp_set_connection_status", { p_actor: users.staff, p_connection_id: connId, p_status: "disabled" })).error);
    }
  });
});
