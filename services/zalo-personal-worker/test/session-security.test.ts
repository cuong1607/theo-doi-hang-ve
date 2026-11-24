import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";

import { SessionFormatError, SessionManager } from "../src/session-manager.ts";
import { AesKeyProtector, DpapiProtector, SessionDecryptError, type ProcessRunner, type SessionProtector } from "../src/session-protector.ts";
import { FAKE_CREDENTIALS, tempDir } from "./helpers.ts";

const key = () => randomBytes(32).toString("base64");

async function manager(protector: SessionProtector = new AesKeyProtector(key()), connectionId = "primary") {
  const { dir, cleanup } = await tempDir();
  const file = path.join(dir, "session.json");
  return { file, sessions: new SessionManager({ file, protector, connectionId }), protector, cleanup };
}

describe("session: AES-256-GCM protection", () => {
  it("round-trips credentials", async () => {
    const t = await manager();
    await t.sessions.save(FAKE_CREDENTIALS);
    const loaded = await t.sessions.load();
    assert.equal(loaded.status, "active");
    assert.ok(loaded.status === "active");
    assert.deepEqual(loaded.credentials, FAKE_CREDENTIALS);
    await t.cleanup();
  });

  it("the file on disk never contains the cookie, imei or user agent in clear", async () => {
    const t = await manager();
    await t.sessions.save(FAKE_CREDENTIALS);
    const raw = await readFile(t.file, "utf8");
    for (const secret of ["FAKE_COOKIE_VALUE_SHOULD_NEVER_APPEAR_IN_FILES", "zpw_sek", FAKE_CREDENTIALS.imei, "fake test agent"]) {
      assert.ok(!raw.includes(secret), secret);
      assert.ok(!Buffer.from(raw).includes(Buffer.from(secret).toString("base64")), `${secret} (base64)`);
    }
    await t.cleanup();
  });

  it("a different key cannot decrypt", async () => {
    const t = await manager();
    await t.sessions.save(FAKE_CREDENTIALS);
    const other = new SessionManager({ file: t.file, protector: new AesKeyProtector(key()), connectionId: "primary" });
    await assert.rejects(() => other.load(), SessionDecryptError);
    await t.cleanup();
  });

  it("tampered ciphertext is rejected (authenticated encryption)", async () => {
    const t = await manager();
    await t.sessions.save(FAKE_CREDENTIALS);
    const env = JSON.parse(await readFile(t.file, "utf8"));
    const bytes = Buffer.from(env.payload, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    env.payload = bytes.toString("base64");
    await writeFile(t.file, JSON.stringify(env));
    await assert.rejects(() => t.sessions.load(), SessionDecryptError);
    await t.cleanup();
  });

  it("protection mode / connection / version mismatches are refused", async () => {
    const t = await manager();
    await t.sessions.save(FAKE_CREDENTIALS);
    const env = JSON.parse(await readFile(t.file, "utf8"));
    await writeFile(t.file, JSON.stringify({ ...env, protection: "dpapi" }));
    await assert.rejects(() => t.sessions.load(), SessionFormatError);
    await writeFile(t.file, JSON.stringify({ ...env, v: 2 }));
    await assert.rejects(() => t.sessions.load(), SessionFormatError);
    await writeFile(t.file, JSON.stringify(env));
    const otherConn = new SessionManager({ file: t.file, protector: t.protector, connectionId: "secondary" });
    await assert.rejects(() => otherConn.load(), SessionFormatError);
    await writeFile(t.file, "not json");
    await assert.rejects(() => t.sessions.load(), SessionFormatError);
    await t.cleanup();
  });

  it("refuses to save incomplete credentials", async () => {
    const t = await manager();
    await assert.rejects(() => t.sessions.save({ ...FAKE_CREDENTIALS, cookie: [] }), SessionFormatError);
    await assert.rejects(() => t.sessions.save({ ...FAKE_CREDENTIALS, imei: "" }), SessionFormatError);
    await t.cleanup();
  });

  it("markRejected removes the usable payload; load() then reports rejected", async () => {
    const t = await manager();
    await t.sessions.save(FAKE_CREDENTIALS);
    await t.sessions.markRejected();
    assert.equal((await t.sessions.load()).status, "rejected");
    assert.equal(JSON.parse(await readFile(t.file, "utf8")).payload, "");
    await t.cleanup();
  });

  it("peek() reports status without decrypting", async () => {
    const t = await manager();
    assert.deepEqual(await t.sessions.peek(), { status: "none" });
    await t.sessions.save(FAKE_CREDENTIALS);
    const broken = new SessionManager({ file: t.file, protector: { name: "aes-key", protect: async () => Buffer.alloc(0), unprotect: async () => { throw new Error("must not decrypt"); } }, connectionId: "primary" });
    assert.equal((await broken.peek()).status, "active");
    await t.cleanup();
  });

  it("clear() deletes the file", async () => {
    const t = await manager();
    await t.sessions.save(FAKE_CREDENTIALS);
    assert.equal(await t.sessions.clear(), true);
    assert.equal(await t.sessions.clear(), false);
    assert.deepEqual(await t.sessions.load(), { status: "none" });
    await t.cleanup();
  });

  it("rejects a short key", () => {
    assert.throws(() => new AesKeyProtector(randomBytes(16).toString("base64")));
  });
});

describe("session: DPAPI protector", () => {
  it("passes data through stdin, never on the command line", async () => {
    const calls: Array<{ args: string[]; stdin: string }> = [];
    const run: ProcessRunner = async (_cmd, args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: Buffer.from("cipher").toString("base64") };
    };
    const p = new DpapiProtector({ run });
    await p.protect(Buffer.from("SECRET_PAYLOAD"));
    const call = calls[0]!;
    assert.ok(!call.args.join(" ").includes("SECRET_PAYLOAD"));
    assert.ok(!call.args.join(" ").includes(Buffer.from("SECRET_PAYLOAD").toString("base64")));
    assert.equal(call.stdin, Buffer.from("SECRET_PAYLOAD").toString("base64"));
    assert.ok(call.args.join(" ").includes("CurrentUser"));
  });

  it("a failed Unprotect becomes SessionDecryptError (no stderr surfaced)", async () => {
    const p = new DpapiProtector({ run: async () => ({ code: 1, stdout: "" }) });
    await assert.rejects(() => p.unprotect(Buffer.from("x")), SessionDecryptError);
  });

  it("real DPAPI round trip on Windows (CurrentUser scope)", { skip: process.platform !== "win32" && "Windows only" }, async () => {
    const t = await manager(new DpapiProtector());
    await t.sessions.save(FAKE_CREDENTIALS);
    const loaded = await t.sessions.load();
    assert.ok(loaded.status === "active");
    assert.deepEqual(loaded.credentials, FAKE_CREDENTIALS);
    assert.ok(!(await readFile(t.file, "utf8")).includes("FAKE_COOKIE_VALUE"));
    // a different application entropy cannot decrypt the same blob
    const env = JSON.parse(await readFile(t.file, "utf8"));
    await assert.rejects(() => new DpapiProtector({ entropy: "other-app" }).unprotect(Buffer.from(env.payload, "base64")), SessionDecryptError);
    await t.cleanup();
  });
});
