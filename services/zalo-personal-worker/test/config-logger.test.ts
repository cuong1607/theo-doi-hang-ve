import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import path from "node:path";

import { assertSafeDataDir, ConfigError, defaultDataDir, loadConfig } from "../src/config.ts";
import { createLogger, REDACTED, redact, safeError } from "../src/logger.ts";
import { classifyLoginError } from "../src/zalo-client.ts";
import { networkError, rejectedError } from "./helpers.ts";

const WORKER = path.resolve("C:/repo/services/zalo-personal-worker");
const inRepo = (p: string) => p === path.join(path.resolve("C:/repo"), ".git");
const base = { ZP_DATA_DIR: "D:/zp-data" };

describe("config", () => {
  it("defaults: disabled, metadata-only DMs, no groups, DPAPI on Windows", () => {
    const c = loadConfig(base, { platform: "win32", workerDir: WORKER, exists: () => false });
    assert.equal(c.enabled, false);
    assert.equal(c.directMessages, "metadata");
    assert.equal(c.allowedGroupIds.size, 0);
    assert.equal(c.discoveryToken, null);
    assert.equal(c.sessionProtection, "dpapi");
  });

  it("parses the allowlist and rejects non-numeric ids", () => {
    const c = loadConfig({ ...base, ZP_ALLOWED_GROUP_IDS: " 123, 456 ,," }, { platform: "win32", workerDir: WORKER, exists: () => false });
    assert.deepEqual([...c.allowedGroupIds], ["123", "456"]);
    assert.throws(() => loadConfig({ ...base, ZP_ALLOWED_GROUP_IDS: "123,abc" }, { platform: "win32", workerDir: WORKER, exists: () => false }), ConfigError);
  });

  it("discovery token must be long and without spaces", () => {
    for (const bad of ["short", "has space token here", "x".repeat(65)]) {
      assert.throws(() => loadConfig({ ...base, ZP_DISCOVERY_TOKEN: bad }, { platform: "win32", workerDir: WORKER, exists: () => false }), ConfigError, bad);
    }
  });

  it("Linux requires aes-key with a 32-byte key; DPAPI refused off Windows", () => {
    assert.throws(() => loadConfig(base, { platform: "linux", workerDir: WORKER, exists: () => false }), /ZP_SESSION_KEY/);
    assert.throws(() => loadConfig({ ...base, ZP_SESSION_KEY: randomBytes(16).toString("base64") }, { platform: "linux", workerDir: WORKER, exists: () => false }), /32 byte/);
    assert.throws(() => loadConfig({ ...base, ZP_SESSION_PROTECTION: "dpapi" }, { platform: "linux", workerDir: WORKER, exists: () => false }), /DPAPI/);
    const c = loadConfig({ ...base, ZP_SESSION_KEY: randomBytes(32).toString("base64") }, { platform: "linux", workerDir: WORKER, exists: () => false });
    assert.equal(c.sessionProtection, "aes-key");
  });

  it("invalid booleans / numbers are configuration errors, not silent defaults", () => {
    assert.throws(() => loadConfig({ ...base, ZP_ENABLED: "maybe" }, { platform: "win32", workerDir: WORKER, exists: () => false }), ConfigError);
    assert.throws(() => loadConfig({ ...base, ZP_RECONNECT_MAX_ATTEMPTS: "100" }, { platform: "win32", workerDir: WORKER, exists: () => false }), ConfigError);
  });

  it("default data dir is per-user and outside the repo", () => {
    assert.equal(defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }), "C:\\Users\\u\\AppData\\Local\\CongTrangBedding\\zalo-personal");
    assert.equal(defaultDataDir("linux", {}, "/home/u"), "/home/u/.local/state/congtrangbedding/zalo-personal");
  });

  it("refuses a data dir inside a git work tree, except the git-ignored worker .data", () => {
    assert.throws(() => assertSafeDataDir("C:/repo/sessions", WORKER, inRepo), ConfigError);
    assert.throws(() => assertSafeDataDir("C:/repo/services/zalo-personal-worker/src", WORKER, inRepo), ConfigError);
    assert.doesNotThrow(() => assertSafeDataDir("C:/repo/services/zalo-personal-worker/.data", WORKER, inRepo));
    assert.doesNotThrow(() => assertSafeDataDir("C:/repo/services/zalo-personal-worker/.data/x", WORKER, inRepo));
    assert.doesNotThrow(() => assertSafeDataDir("D:/elsewhere", WORKER, inRepo));
  });
});

describe("logger redaction", () => {
  it("masks sensitive keys at any depth", () => {
    const out = redact({ cookie: "a", nested: { access_token: "b", imei: "c", userAgent: "d", qrImage: "e", text: "f", content: "g", dName: "h" }, list: [{ session: "x" }], ok: 1 }) as Record<string, unknown>;
    assert.equal(out.cookie, REDACTED);
    assert.deepEqual(out.nested, { access_token: REDACTED, imei: REDACTED, userAgent: REDACTED, qrImage: REDACTED, text: REDACTED, content: REDACTED, dName: REDACTED });
    assert.deepEqual(out.list, [{ session: REDACTED }]);
    assert.equal(out.ok, 1);
  });

  it("masks long opaque blobs under innocent keys", () => {
    const blob = randomBytes(48).toString("base64");
    assert.equal((redact({ note: blob }) as { note: string }).note, REDACTED);
  });

  it("keeps explicit safe metadata (textLength, messageType, state)", () => {
    assert.deepEqual(redact({ textLength: 5, messageType: "text", state: "connected" }), { textLength: 5, messageType: "text", state: "connected" });
  });

  it("errors are logged as name + code only, never the message", () => {
    const err = rejectedError();
    assert.deepEqual(safeError(err), { name: "ZaloApiError" });
    const lines: string[] = [];
    createLogger({ writer: (l) => lines.push(l) }).error("x", { error: err, raw: err });
    assert.ok(!lines[0]!.includes("SERVER_SECRET_ECHO"));
  });
});

describe("login error classification", () => {
  it("network failures are retryable, anything else is a rejection", () => {
    assert.equal(classifyLoginError(networkError()), "network");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(classifyLoginError(abort), "network");
    assert.equal(classifyLoginError(rejectedError()), "rejected");
    assert.equal(classifyLoginError("weird"), "rejected");
  });
});

describe("config: Phase 02 ingestion", () => {
  const opts = { platform: "win32" as const, workerDir: WORKER, exists: () => false };
  it("off by default; when on it needs an https URL and a worker key", () => {
    assert.equal(loadConfig(base, opts).ingest.enabled, false);
    assert.throws(() => loadConfig({ ...base, ZP_INGEST_ENABLED: "true" }, opts), /ZP_INGEST_URL/);
    assert.throws(() => loadConfig({ ...base, ZP_INGEST_ENABLED: "true", ZP_INGEST_URL: "http://example.com", ZP_WORKER_KEY: "win-01" }, opts), /HTTPS/);
    assert.throws(() => loadConfig({ ...base, ZP_INGEST_ENABLED: "true", ZP_INGEST_URL: "https://example.com" }, opts), /ZP_WORKER_KEY/);
    const c = loadConfig({ ...base, ZP_INGEST_ENABLED: "true", ZP_INGEST_URL: "https://example.com", ZP_WORKER_KEY: "win-01" }, opts);
    assert.deepEqual([c.ingest.enabled, c.ingest.batchSize, c.ingest.maxAttempts], [true, 25, 12]);
    assert.doesNotThrow(() => loadConfig({ ...base, ZP_INGEST_ENABLED: "true", ZP_INGEST_URL: "http://localhost:3000", ZP_WORKER_KEY: "win-01" }, opts));
  });
  it("direct messages accept off | metadata | content", () => {
    assert.equal(loadConfig({ ...base, ZP_DIRECT_MESSAGES: "content" }, opts).directMessages, "content");
    assert.throws(() => loadConfig({ ...base, ZP_DIRECT_MESSAGES: "all" }, opts), ConfigError);
  });
});
