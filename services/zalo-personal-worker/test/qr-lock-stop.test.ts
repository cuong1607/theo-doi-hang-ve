import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";

import { acquireInstanceLock, AlreadyRunningError } from "../src/instance-lock.ts";
import { QR_FILE_NAME, QrLoginError, runQrLogin } from "../src/qr-login.ts";
import { clearStop, requestStop, stopRequested, watchStopFile } from "../src/stop-signal.ts";
import type { QrEvent } from "../src/zalo-client.ts";
import { captureLogger, FAKE_CREDENTIALS, MockConnector, mockSession, tempDir } from "./helpers.ts";

const PNG = Buffer.from("fake-png-bytes").toString("base64");

function qrHarness(script: (emit: (e: QrEvent) => void, ctl: { aborted: boolean }) => Promise<void>) {
  const connector = new MockConnector();
  const ctl = { aborted: false };
  connector.qrScript = async (emit) => {
    await script(emit, ctl);
    if (ctl.aborted) throw Object.assign(new Error("aborted {secret response}"), { name: "ZaloApiLoginQRAborted" });
    return mockSession();
  };
  return { connector, ctl };
}

const actions = (ctl: { aborted: boolean }, onRetry: () => void = () => {}) => ({ retry: onRetry, abort: () => (ctl.aborted = true) });

describe("qr-login", () => {
  it("success: QR written for scanning, deleted afterwards, credentials returned", async () => {
    const { dir, cleanup } = await tempDir();
    const { logger, lines } = captureLogger();
    const printed: string[] = [];
    let fileExistedDuringScan = false;
    const { connector } = qrHarness(async (emit, ctl) => {
      emit({ type: "generated", imageBase64: PNG, ...actions(ctl) });
      await new Promise((r) => setTimeout(r, 10));
      fileExistedDuringScan = (await readdir(path.join(dir, "qr"))).includes(QR_FILE_NAME);
      emit({ type: "scanned", ...actions(ctl) });
      emit({ type: "credentials", credentials: FAKE_CREDENTIALS });
    });
    const result = await runQrLogin({ connector, qrDir: path.join(dir, "qr"), maxAttempts: 3, autoOpen: false, logger, print: (l) => printed.push(l) });
    assert.deepEqual(result.credentials, FAKE_CREDENTIALS);
    assert.equal(fileExistedDuringScan, true);
    assert.deepEqual(await readdir(path.join(dir, "qr")), [], "QR image removed");
    const all = lines.join("\n") + printed.join("\n");
    assert.ok(!all.includes(PNG), "QR data never logged or printed");
    assert.ok(!all.includes("FAKE_COOKIE_VALUE"), "cookie never logged");
    await cleanup();
  });

  it("expired QR is regenerated at most maxAttempts times, then aborted", async () => {
    const { dir, cleanup } = await tempDir();
    const { logger } = captureLogger();
    let retries = 0;
    const { connector } = qrHarness(async (emit, ctl) => {
      for (let i = 0; i < 5 && !ctl.aborted; i++) {
        emit({ type: "generated", imageBase64: PNG, ...actions(ctl) });
        emit({ type: "expired", ...actions(ctl, () => retries++) });
      }
    });
    await assert.rejects(() => runQrLogin({ connector, qrDir: path.join(dir, "qr"), maxAttempts: 2, autoOpen: false, logger, print: () => {} }), (e: unknown) => e instanceof QrLoginError && e.reason === "qr_expired");
    assert.equal(retries, 1);
    await cleanup();
  });

  it("declined on the phone → qr_declined, QR removed", async () => {
    const { dir, cleanup } = await tempDir();
    const { logger, lines } = captureLogger();
    const { connector } = qrHarness(async (emit, ctl) => {
      emit({ type: "generated", imageBase64: PNG, ...actions(ctl) });
      await new Promise((r) => setTimeout(r, 5));
      emit({ type: "declined", ...actions(ctl) });
    });
    await assert.rejects(() => runQrLogin({ connector, qrDir: path.join(dir, "qr"), maxAttempts: 3, autoOpen: false, logger, print: () => {} }), (e: unknown) => e instanceof QrLoginError && e.reason === "qr_declined");
    assert.deepEqual(await readdir(path.join(dir, "qr")), []);
    assert.ok(!lines.join("\n").includes("secret response"), "library error message not logged");
    await cleanup();
  });

  it("auto-open is only called when enabled", async () => {
    const { dir, cleanup } = await tempDir();
    const { logger } = captureLogger();
    const opened: string[] = [];
    const { connector } = qrHarness(async (emit, ctl) => {
      emit({ type: "generated", imageBase64: PNG, ...actions(ctl) });
      await new Promise((r) => setTimeout(r, 5));
      emit({ type: "credentials", credentials: FAKE_CREDENTIALS });
    });
    await runQrLogin({ connector, qrDir: path.join(dir, "qr"), maxAttempts: 3, autoOpen: true, logger, print: () => {}, openFile: (f) => opened.push(f) });
    assert.deepEqual(opened, [path.join(dir, "qr", QR_FILE_NAME)]);
    await cleanup();
  });
});

describe("instance lock", () => {
  it("a second live worker is refused", async () => {
    const { dir, cleanup } = await tempDir();
    const file = path.join(dir, "worker.lock");
    const a = await acquireInstanceLock(file, { pid: 111, isAlive: () => true });
    await assert.rejects(() => acquireInstanceLock(file, { pid: 222, isAlive: () => true }), AlreadyRunningError);
    await a.release();
    const b = await acquireInstanceLock(file, { pid: 222, isAlive: () => true });
    await b.release();
    await cleanup();
  });

  it("a stale lock (dead PID) is taken over", async () => {
    const { dir, cleanup } = await tempDir();
    const file = path.join(dir, "worker.lock");
    await writeFile(file, "99999");
    const lock = await acquireInstanceLock(file, { pid: 333, isAlive: () => false });
    await lock.release();
    await cleanup();
  });
});

describe("emergency stop file", () => {
  it("request / detect / clear", async () => {
    const { dir, cleanup } = await tempDir();
    const file = path.join(dir, "STOP");
    assert.equal(await stopRequested(file), false);
    await requestStop(file);
    assert.equal(await stopRequested(file), true);
    assert.equal(await clearStop(file), true);
    assert.equal(await stopRequested(file), false);
    await cleanup();
  });

  it("watcher fires once when the file appears", async () => {
    const { dir, cleanup } = await tempDir();
    const file = path.join(dir, "STOP");
    let fired = 0;
    const dispose = watchStopFile(file, 10, () => fired++);
    await requestStop(file);
    await new Promise((r) => setTimeout(r, 80));
    dispose();
    assert.equal(fired, 1);
    await cleanup();
  });
});
