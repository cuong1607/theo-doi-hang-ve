// ============================================================
// CLI entry of the Zalo Personal worker.
//
//   run            restore the saved session and listen (long-running)
//   login          QR login, save the protected session, exit (no listener)
//   logout         invalidate the session on Zalo + delete it locally
//   session-clear  delete the local session only (no network)
//   status         health + session state (no decryption, no network)
//   stop / resume  create / remove the STOP kill switch
//
// Exit codes: 0 ok · 1 unexpected error · 2 configuration · 3 needs an
// operator (no / rejected session, kicked, QR failed, reconnect exhausted —
// a supervisor must NOT restart on 3) · 4 disabled / STOP present / already running.
// ============================================================
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, dataPaths, loadConfig, type WorkerConfig } from "./config.ts";
import { ConnectionManager } from "./connection-manager.ts";
import { DedupeCache } from "./dedupe.ts";
import { HealthMonitor, readHealth } from "./health-monitor.ts";
import { acquireInstanceLock, AlreadyRunningError, type InstanceLock } from "./instance-lock.ts";
import { createLogger, safeError, type Logger } from "./logger.ts";
import { createEventPipeline } from "./message-listener.ts";
import { JsonlMetadataSink, loadOrCreateSalt, pruneMetadataLogs } from "./metadata-sink.ts";
import { QrLoginError, runQrLogin } from "./qr-login.ts";
import { SessionManager } from "./session-manager.ts";
import { createProtector } from "./session-protector.ts";
import { clearStop, requestStop, stopRequested, watchStopFile } from "./stop-signal.ts";
import { ZcaConnector, type ZaloSession } from "./zalo-client.ts";
import { CompositeSink } from "./ingest/outbox-sink.ts";
import { Outbox } from "./ingest/outbox.ts";
import { IngestSetupError, startIngestion, type IngestRuntime } from "./ingest/runtime.ts";
import { clearIngestSecret, isValidIngestSecret, loadIngestSecret, loadOrCreateOutboxKey, saveIngestSecret } from "./ingest/secret-store.ts";
import type { EventSink } from "./metadata-sink.ts";
import { SendJournal } from "./outbound/journal.ts";
import { OutboundService } from "./outbound/service.ts";

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXIT = { ok: 0, unexpected: 1, config: 2, operator: 3, refused: 4 } as const;

const print = (line: string) => process.stdout.write(`${line}\n`);

function sessionsFor(config: WorkerConfig): SessionManager {
  return new SessionManager({ file: dataPaths(config.dataDir).sessionFile, protector: createProtector(config), connectionId: config.connectionId });
}

/** Common guard for every command that talks to Zalo. */
async function guardNetworkCommand(config: WorkerConfig, logger: Logger): Promise<number | null> {
  if (!config.enabled) {
    print("Worker đang TẮT (ZP_ENABLED không phải true). Không kết nối Zalo.");
    return EXIT.refused;
  }
  if (await stopRequested(dataPaths(config.dataDir).stopFile)) {
    print("Đang có lệnh DỪNG KHẨN CẤP (file STOP). Chạy `npm run resume` khi muốn hoạt động lại.");
    logger.warn("refused_stop_file_present");
    return EXIT.refused;
  }
  return null;
}

async function withLock<T>(config: WorkerConfig, fn: () => Promise<T>): Promise<T | number> {
  let lock: InstanceLock;
  try {
    lock = await acquireInstanceLock(dataPaths(config.dataDir).lockFile);
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      print(err.message);
      return EXIT.refused;
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ------------------------------------------------------------ run
async function cmdRun(config: WorkerConfig, logger: Logger): Promise<number> {
  const refused = await guardNetworkCommand(config, logger);
  if (refused !== null) return refused;

  const result = await withLock(config, async () => {
    const paths = dataPaths(config.dataDir);
    const health = new HealthMonitor({ file: paths.healthFile, connectionId: config.connectionId });
    const removed = await pruneMetadataLogs(paths.logsDir, config.metadataRetentionDays);
    if (removed) logger.info("metadata_logs_pruned", { removed });
    const salt = await loadOrCreateSalt(paths.saltFile);
    const metadataSink = new JsonlMetadataSink({ logsDir: paths.logsDir, discoveryFile: paths.discoveryFile, salt });
    let ownId: string | null = null;
    let manager: ConnectionManager | null = null;

    // Phase 02: durable outbox → backend (off unless ZP_INGEST_ENABLED=true)
    let ingest: IngestRuntime | null = null;
    if (config.ingest.enabled) {
      try {
        ingest = await startIngestion({ config, logger, health, protector: createProtector(config), connectionState: () => ({ state: manager?.state ?? "disconnected", errorReason: health.current.errorReason }) });
      } catch (err) {
        if (err instanceof IngestSetupError) {
          print(err.message);
          return EXIT.operator;
        }
        throw err;
      }
    }
    // Phase 04.5: approved replies (off unless ZP_SEND_ENABLED=true; the backend flags + gates still apply)
    let outbound: OutboundService | null = null;
    // realtime: a message from someone else → the outbound loop claims right away for a while
    const nudgeSink: EventSink = {
      async record(event) {
        if (event.kind === "message" && !event.isSelf) outbound?.nudge();
      },
      async discovered() {},
    };
    const sink: EventSink = ingest ? new CompositeSink([metadataSink, ingest.sink, nudgeSink]) : metadataSink;
    let currentSession: ZaloSession | null = null;
    if (config.send.enabled && ingest) {
      const journal = new SendJournal({ file: paths.sendJournalFile });
      const recovered = await journal.init();
      if (recovered) logger.warn("outbound_recovered_unknown", { count: recovered });
      const rt = ingest;
      outbound = new OutboundService({
        post: (p, payload, signal) => rt.post(p, payload, signal),
        journal,
        connectionKey: config.connectionId,
        accountId: () => rt.accountId(),
        session: () => (manager?.state === "connected" ? currentSession : null),
        logger,
        pollMs: config.send.pollMs,
        timeoutMs: config.send.timeoutMs,
        minIntervalMs: config.send.minIntervalMs,
        fastPollMs: config.send.fastPollMs,
        fastWindowMs: config.send.fastWindowMs,
      });
    }

    const pipeline = createEventPipeline({
      connectionId: config.connectionId,
      filter: { allowedGroupIds: config.allowedGroupIds, discoveryToken: config.discoveryToken, directMessages: config.directMessages },
      dedupe: new DedupeCache(config.dedupe),
      sink,
      health,
      logger,
      ownId: () => ownId,
      announce: print,
    });

    manager = new ConnectionManager({
      connector: new ZcaConnector(),
      sessions: sessionsFor(config),
      config,
      logger,
      health,
      onEvent: (name, raw) => void pipeline(name, raw),
      onSession: (session: ZaloSession | null) => {
        currentSession = session;
        try {
          ownId = session ? session.ownId() : null;
        } catch {
          ownId = null;
        }
        ingest?.onAccount(ownId);
      },
      onStateChange: (state) => ingest?.onStateChange(state),
    });
    const run = manager;

    let signals = 0;
    const onSignal = (sig: string) => {
      signals++;
      if (signals > 1) {
        print("Thoát ngay (nhận tín hiệu lần 2).");
        process.exit(EXIT.unexpected);
      }
      print("Đang dừng worker an toàn… (nhấn Ctrl+C lần nữa để thoát ngay)");
      run.stop(sig);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const disposeStopWatch = watchStopFile(paths.stopFile, config.stopPollMs, () => run.stop("stop_file"));
    const healthTimer = setInterval(() => void health.flush(), config.healthIntervalMs);

    print(`Worker Zalo Personal đang chạy (connection "${config.connectionId}"). Nhóm được phép: ${config.allowedGroupIds.size}. Ctrl+C hoặc \`npm run stop\` để dừng.`);
    logger.info("worker_started", { connectionId: config.connectionId, allowedGroups: config.allowedGroupIds.size, discovery: config.discoveryToken !== null, directMessages: config.directMessages, protection: config.sessionProtection, ingest: config.ingest.enabled });
    if (ingest) print(`Đồng bộ về backend: BẬT (${new URL(config.ingest.baseUrl!).host}, worker "${config.ingest.workerKey}"). Outbox đang chờ: ${ingest.outbox.stats().depth}.`);
    if (outbound) {
      print("GỬI TIN TRẢ LỜI: BẬT (ZP_SEND_ENABLED). Chỉ gửi tin hệ thống cho phép (đã duyệt, hoặc tự động khi kết nối ở chế độ Tự động); `npm run stop` để dừng ngay.");
      outbound.start();
    }

    try {
      const outcome = await run.run();
      if (outcome.state === "error") {
        print(explainError(outcome.reason));
        return EXIT.operator;
      }
      print("Worker đã dừng.");
      return EXIT.ok;
    } finally {
      disposeStopWatch();
      clearInterval(healthTimer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      // no new claim; the in-flight send (≤ its timeout) is journaled and reported first
      await outbound?.stop();
      // after the listener stopped: let delivery finish its in-flight request (outbox stays consistent)
      await ingest?.shutdown();
      await health.flush();
    }
  });
  return result;
}

function explainError(reason: string): string {
  switch (reason) {
    case "no_session":
      return "Chưa có phiên đăng nhập. Chạy `npm run login` để đăng nhập bằng QR.";
    case "session_rejected":
      return "Zalo đã từ chối phiên đã lưu (hết hạn hoặc bị đăng xuất). Worker KHÔNG tự thử lại. Chạy `npm run login` khi sẵn sàng.";
    case "session_unreadable":
      return "Không đọc/giải mã được phiên đã lưu (khác người dùng Windows, sai khóa hoặc file hỏng). Chạy `npm run session:clear` rồi `npm run login`.";
    case "kicked_duplicate_connection":
      return "Zalo đã ngắt kết nối vì tài khoản được mở trên Zalo Web/một listener khác. Worker KHÔNG tự kết nối lại để tránh tranh chấp. Đóng phiên kia rồi chạy lại.";
    case "kicked_by_server":
      return "Zalo đã đá phiên này. Worker dừng. Kiểm tra tài khoản trên điện thoại trước khi chạy lại.";
    case "reconnect_exhausted":
      return "Kết nối lại thất bại quá số lần cho phép. Kiểm tra mạng rồi chạy lại.";
    default:
      return `Worker dừng do lỗi: ${reason}.`;
  }
}

// ------------------------------------------------------------ login
async function cmdLogin(config: WorkerConfig, logger: Logger, force: boolean): Promise<number> {
  const refused = await guardNetworkCommand(config, logger);
  if (refused !== null) return refused;
  const sessions = sessionsFor(config);
  const existing = await sessions.peek().catch(() => ({ status: "none" as const }));
  if (existing.status === "active" && !force) {
    print("Đã có phiên đang hoạt động. Dùng `npm run logout` trước, hoặc `npm run login -- --force` để thay phiên mới.");
    return EXIT.refused;
  }
  return withLock(config, async () => {
    const paths = dataPaths(config.dataDir);
    const health = new HealthMonitor({ file: paths.healthFile, connectionId: config.connectionId });
    health.setState("connecting");
    print("Đăng nhập Zalo cá nhân bằng QR. Lưu ý: zca-js là API KHÔNG chính thức — tài khoản có thể bị Zalo hạn chế.");
    try {
      const { session, credentials } = await runQrLogin({
        connector: new ZcaConnector(),
        qrDir: paths.qrDir,
        maxAttempts: config.qrMaxAttempts,
        autoOpen: config.qrAutoOpen,
        logger,
        print,
        onPhase: (phase) => health.setState(phase === "qr_pending" ? "qr_pending" : "connecting"),
      });
      await sessions.save(credentials);
      health.setState("disconnected");
      try {
        session.listener.stop();
      } catch {
        /* the listener was never started */
      }
      logger.info("login_succeeded", { protection: config.sessionProtection });
      print(`Đăng nhập thành công. Phiên đã được mã hóa (${config.sessionProtection}) và lưu ngoài Git.`);
      print("Chạy `npm run dev` (hoặc `npm start` sau khi build) để bắt đầu lắng nghe.");
      return EXIT.ok;
    } catch (err) {
      const reason = err instanceof QrLoginError ? err.reason : "qr_failed";
      health.setState("error", { errorReason: reason });
      logger.error("login_failed", { reason, error: safeError(err) });
      print(reason === "qr_declined" ? "Đăng nhập bị từ chối trên điện thoại." : reason === "qr_expired" ? "QR hết hạn quá số lần cho phép. Chạy lại khi sẵn sàng." : "Đăng nhập thất bại.");
      return EXIT.operator;
    } finally {
      await health.flush();
    }
  });
}

// ------------------------------------------------------------ logout / session-clear
async function cmdLogout(config: WorkerConfig, logger: Logger): Promise<number> {
  const refused = await guardNetworkCommand(config, logger);
  if (refused !== null) return refused;
  return withLock(config, async () => {
    const sessions = sessionsFor(config);
    let remote = "skipped";
    try {
      const loaded = await sessions.load();
      if (loaded.status === "active") {
        const session = await new ZcaConnector().loginWithSession(loaded.credentials);
        await session.logout();
        remote = "ok";
      }
    } catch (err) {
      remote = "failed";
      logger.warn("remote_logout_failed", { error: safeError(err) });
    }
    const removed = await sessions.clear();
    print(`Đăng xuất phía Zalo: ${remote === "ok" ? "thành công" : remote === "skipped" ? "bỏ qua (không có phiên dùng được)" : "KHÔNG thành công"}. Phiên cục bộ: ${removed ? "đã xóa" : "không có"}.`);
    if (remote !== "ok") print("Nên kiểm tra trên điện thoại: Zalo > Cá nhân > Cài đặt > Tài khoản và bảo mật > thiết bị đăng nhập, và đăng xuất thiết bị lạ.");
    return EXIT.ok;
  });
}

async function cmdSessionClear(config: WorkerConfig): Promise<number> {
  return withLock(config, async () => {
    const removed = await sessionsFor(config).clear();
    print(removed ? "Đã xóa phiên cục bộ. (Phiên phía Zalo vẫn có thể còn hiệu lực — dùng `npm run logout` để đăng xuất cả hai.)" : "Không có phiên cục bộ.");
    return EXIT.ok;
  });
}

// ------------------------------------------------------------ ingest (Phase 02)
async function readSecretFromStdin(): Promise<string> {
  const { createInterface } = await import("node:readline");
  const { Writable } = await import("node:stream");
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
  return new Promise((resolve) => {
    rl.question("Dán worker secret (zps_…) rồi nhấn Enter (không hiển thị): ", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

async function cmdIngestSetSecret(config: WorkerConfig): Promise<number> {
  const secret = await readSecretFromStdin();
  if (!isValidIngestSecret(secret)) {
    print("Secret không đúng định dạng (zps_ + 43 ký tự). Không lưu gì.");
    return EXIT.config;
  }
  await saveIngestSecret(dataPaths(config.dataDir).ingestSecretFile, createProtector(config), secret);
  print(`Đã lưu ingest secret (bảo vệ bằng ${config.sessionProtection}) tại thư mục dữ liệu, ngoài Git.`);
  return EXIT.ok;
}

async function openOutbox(config: WorkerConfig): Promise<Outbox> {
  const paths = dataPaths(config.dataDir);
  const outbox = new Outbox({ dir: paths.outboxDir, key: await loadOrCreateOutboxKey(paths.outboxKeyFile, createProtector(config)), maxEvents: config.ingest.outboxMaxEvents, maxBytes: config.ingest.outboxMaxBytes });
  await outbox.init();
  return outbox;
}

async function cmdIngestStatus(config: WorkerConfig): Promise<number> {
  const paths = dataPaths(config.dataDir);
  const protector = createProtector(config);
  const secret = await loadIngestSecret(paths.ingestSecretFile, protector, config.ingest.secretFromEnv).then((v) => (v ? "present" : "missing")).catch(() => "unreadable");
  const outbox = await openOutbox(config);
  const health = await readHealth(paths.healthFile);
  print(JSON.stringify({ enabled: config.ingest.enabled, backend: config.ingest.baseUrl ? new URL(config.ingest.baseUrl).host : null, workerKey: config.ingest.workerKey, connectionKey: config.connectionId, secret, outbox: outbox.stats(), lastRun: health?.ingest ?? null }, null, 2));
  return EXIT.ok;
}

// ------------------------------------------------------------ status / stop / resume
async function cmdStatus(config: WorkerConfig): Promise<number> {
  const paths = dataPaths(config.dataDir);
  const session = await sessionsFor(config).peek().catch((err) => ({ status: "unreadable", error: safeError(err) }));
  const health = await readHealth(paths.healthFile);
  print(JSON.stringify({ enabled: config.enabled, stopFile: await stopRequested(paths.stopFile), dataDir: config.dataDir, session, health }, null, 2));
  return EXIT.ok;
}

async function main(argv: string[]): Promise<number> {
  const [command = "run", ...rest] = argv;
  let config: WorkerConfig;
  try {
    config = loadConfig(process.env, { workerDir: WORKER_DIR });
  } catch (err) {
    if (err instanceof ConfigError) {
      print(`Lỗi cấu hình: ${err.message}`);
      return EXIT.config;
    }
    throw err;
  }
  const logger = createLogger({ level: config.logLevel });
  switch (command) {
    case "run":
      return cmdRun(config, logger);
    case "login":
      return cmdLogin(config, logger, rest.includes("--force"));
    case "logout":
      return cmdLogout(config, logger);
    case "session-clear":
      return cmdSessionClear(config);
    case "status":
      return cmdStatus(config);
    case "stop":
      await requestStop(dataPaths(config.dataDir).stopFile);
      print("Đã tạo lệnh DỪNG KHẨN CẤP. Worker đang chạy sẽ dừng trong vài giây; mọi lệnh kết nối bị chặn cho tới `npm run resume`.");
      return EXIT.ok;
    case "ingest-set-secret":
      return cmdIngestSetSecret(config);
    case "ingest-clear-secret":
      await clearIngestSecret(dataPaths(config.dataDir).ingestSecretFile);
      print("Đã xóa ingest secret cục bộ.");
      return EXIT.ok;
    case "ingest-status":
      return cmdIngestStatus(config);
    case "outbox-retry-dead": {
      const moved = await withLock(config, async () => (await openOutbox(config)).retryDead(Date.now()));
      print(`Đã đưa ${moved} mục dead-letter về hàng chờ.`);
      return EXIT.ok;
    }
    case "outbox-clear": {
      if (!rest.includes("--yes")) {
        print("Xóa toàn bộ outbox (cả mục CHƯA gửi). Chạy lại với: npm run outbox:clear -- --yes");
        return EXIT.refused;
      }
      await withLock(config, async () => (await openOutbox(config)).clear("all"));
      print("Đã xóa outbox.");
      return EXIT.ok;
    }
    case "resume":
      print((await clearStop(dataPaths(config.dataDir).stopFile)) ? "Đã gỡ lệnh dừng khẩn cấp." : "Không có lệnh dừng nào.");
      return EXIT.ok;
    default:
      print(`Lệnh không hỗ trợ: ${command}`);
      return EXIT.config;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // zca-js may keep sockets / timers alive after a command finished: exit once idle work is flushed
    setTimeout(() => process.exit(code), 500).unref();
  },
  (err) => {
    process.stderr.write(`${JSON.stringify({ level: "error", source: "zalo-personal-worker", event: "unexpected_error", error: safeError(err) })}\n`);
    process.exitCode = EXIT.unexpected;
  },
);
