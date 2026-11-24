// ============================================================
// ZALO PERSONAL — self-service setup: unit tests (no database).
// Run: node --test src/lib/zalo-personal/dashboard/self-service.test.ts
// ============================================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConnectionRef, GrantRef } from "./access.ts";
import { createConnectionBody, connectionStatusBody } from "./contracts.ts";
import { canConnect, createConnection, ingestUrlFrom, issueWorker, revokeWorker, setConnectionStatus, slugKey, type SelfServiceDeps, type SelfServiceStore } from "./self-service.ts";
import type { ConnectionRow, DashboardStore } from "./service.ts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const STAFF = "00000000-0000-4000-8000-000000000002";
const C1 = "10000000-0000-4000-8000-000000000001";

function setup(storeOver: Partial<SelfServiceStore> = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const store: SelfServiceStore = {
    async createConnection(...args) {
      calls.push({ op: "create", args });
      return { ok: true, id: C1, key: args[1] };
    },
    async issueWorker(...args) {
      calls.push({ op: "issue", args });
      return { ok: true, id: args[2], workerKey: args[3] };
    },
    async revokeWorker(...args) {
      calls.push({ op: "revoke", args });
      return { ok: true, changed: true };
    },
    async setConnectionStatus(...args) {
      calls.push({ op: "status", args });
      return { ok: true, changed: true };
    },
    ...storeOver,
  };
  const dashboard = {
    async loadAccess(userId: string): Promise<{ connections: ConnectionRef[]; grants: GrantRef[] }> {
      return { connections: [{ id: C1, ownerUserId: OWNER, status: "active" }], grants: userId === STAFF ? [{ id: "g", connectionId: C1, scope: "connection", conversationId: null, level: "manage" }] : [] };
    },
    async connections(ids: string[]): Promise<ConnectionRow[]> {
      return ids.map((id) => ({ id, connectionKey: "zalo-ban-hang-ab12", ownerUserId: OWNER, ownerName: null, zaloAccountId: null, status: "active", directMessageMode: "metadata", lastHeartbeatAt: null, lastConnectedAt: null, lastErrorCategory: null }));
    },
  } as unknown as DashboardStore;
  const encrypted: Array<{ secret: string; workerId: string }> = [];
  const deps: SelfServiceDeps = {
    dashboard,
    store,
    secrets: { generate: () => "zps_SECRET_VALUE_1234567890", encrypt: (secret, workerId) => (encrypted.push({ secret, workerId }), `v1.enc-${workerId}`), newId: () => "20000000-0000-4000-8000-000000000009" },
  };
  return { deps, calls, encrypted };
}

describe("self-service: who", () => {
  it("admin and staff may connect their own Zalo; viewer may not", async () => {
    assert.deepEqual([canConnect("admin"), canConnect("staff"), canConnect("viewer")], [true, true, false]);
    const { deps, calls } = setup();
    const r = await createConnection(deps, { userId: STAFF, role: "viewer" }, { directMode: "metadata" });
    assert.equal(r.ok ? "ok" : r.error, "forbidden");
    assert.equal(calls.length, 0);
  });
  it("the owner is always the caller (no owner field accepted from the client)", async () => {
    const { deps, calls } = setup();
    const r = await createConnection(deps, { userId: STAFF, role: "staff" }, { name: "Zalo bán hàng", directMode: "off" });
    assert.ok(r.ok);
    assert.equal(calls[0]!.args[0], STAFF);
    assert.equal(createConnectionBody.safeParse({ directMode: "metadata", ownerUserId: OWNER }).success, false);
    assert.equal(createConnectionBody.safeParse({ directMode: "content" }).success, false, "1-1 content is never self-service");
  });
});

describe("self-service: connection key", () => {
  it("readable slug from the name + random suffix, always a valid key", async () => {
    assert.equal(slugKey("Zalo Bán Hàng — Chính!"), "zalo-ban-hang-chinh");
    assert.equal(slugKey(""), "zalo");
    assert.equal(slugKey("???"), "zalo");
    assert.ok(slugKey("x".repeat(80)).length <= 24);
    const { deps, calls } = setup();
    await createConnection(deps, { userId: OWNER, role: "staff" }, { name: "Đơn hàng", directMode: "metadata" });
    assert.match(String(calls[0]!.args[1]), /^don-hang-[0-9a-f]{4}$/);
    assert.match(String(calls[0]!.args[1]), /^[a-z0-9][a-z0-9_-]{0,31}$/);
  });
  it("a taken key is retried with a new suffix; other refusals map to friendly errors", async () => {
    let n = 0;
    const { deps } = setup({ createConnection: async (_a, key) => (++n < 2 ? { ok: false, error: "key_taken" } : { ok: true, id: C1, key }) });
    assert.ok((await createConnection(deps, { userId: OWNER, role: "staff" }, { directMode: "metadata" })).ok);
    assert.equal(n, 2);
    const limited = setup({ createConnection: async () => ({ ok: false, error: "limit_reached" }) });
    const r = await createConnection(limited.deps, { userId: OWNER, role: "staff" }, { directMode: "metadata" });
    assert.deepEqual(r.ok ? null : [r.error, r.code], ["conflict", "limit_reached"]);
  });
});

describe("self-service: worker credential", () => {
  it("only the OWNER can issue; a manage grant is not enough", async () => {
    const { deps, calls } = setup();
    const r = await issueWorker(deps, { userId: STAFF, role: "staff" }, C1, "https://app.example");
    assert.equal(r.ok ? "ok" : r.error, "not_found");
    assert.equal(calls.length, 0);
  });
  it("secret generated + encrypted with the worker id, returned once with the setup lines", async () => {
    const { deps, calls, encrypted } = setup();
    const r = await issueWorker(deps, { userId: OWNER, role: "staff" }, C1, "https://app.example");
    assert.ok(r.ok);
    assert.equal(r.data.secret, "zps_SECRET_VALUE_1234567890");
    const [actorId, connId, workerId, workerKey, enc] = calls[0]!.args as string[];
    assert.deepEqual([actorId, connId], [OWNER, C1]);
    assert.deepEqual(encrypted, [{ secret: r.data.secret, workerId }], "AAD = the id stored with it");
    assert.equal(String(enc).includes(r.data.secret), false, "only ciphertext reaches the database");
    assert.match(workerKey!, /^[a-z0-9][a-z0-9_-]{2,47}$/);
    assert.deepEqual(r.data.envLines, ["ZP_CONNECTION_ID=zalo-ban-hang-ab12", `ZP_WORKER_KEY=${workerKey}`, "ZP_INGEST_URL=https://app.example", "ZP_INGEST_ENABLED=true"]);
    assert.equal(r.data.envLines.some((l) => l.includes(r.data.secret)), false, "the secret is not put in .env (DPAPI on Windows)");
  });
  it("revoke / pause pass the caller as actor (the database re-checks ownership)", async () => {
    const { deps, calls } = setup();
    await revokeWorker(deps, { userId: OWNER, role: "staff" }, C1, "w");
    await setConnectionStatus(deps, { userId: OWNER, role: "staff" }, C1, "disabled");
    assert.deepEqual(calls.map((c) => [c.op, c.args[0]]), [["revoke", OWNER], ["status", OWNER]]);
    const nf = setup({ revokeWorker: async () => ({ ok: false, error: "not_found" }) });
    const r = await revokeWorker(nf.deps, { userId: STAFF, role: "staff" }, C1, "w");
    assert.equal(r.ok ? "ok" : r.error, "not_found");
    assert.equal(connectionStatusBody.safeParse({ status: "deleted" }).success, false);
  });
  it("ingest URL: https, or http only on localhost", () => {
    assert.equal(ingestUrlFrom("https://app.example/x?y"), "https://app.example");
    assert.equal(ingestUrlFrom("http://localhost:3125"), "http://localhost:3125");
    assert.equal(ingestUrlFrom("http://app.example"), null);
    assert.equal(ingestUrlFrom("not a url"), null);
  });
});
