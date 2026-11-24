// ============================================================
// Worker configuration: one validated object, read once at start.
// Pure (takes the env record + platform) so it is unit-testable.
//
// Secrets never come from here except ZP_SESSION_KEY (Linux AES mode); the
// Zalo session itself lives in the protected session file (session-manager).
// ============================================================
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isLogLevel, type LogLevel } from "./logger.ts";

export type SessionProtection = "dpapi" | "aes-key";
export type DirectMessageMode = "off" | "metadata";

export interface WorkerConfig {
  enabled: boolean;
  connectionId: string;
  dataDir: string;
  sessionProtection: SessionProtection;
  /** base64, 32 bytes — only for sessionProtection = "aes-key". */
  sessionKey: string | null;
  allowedGroupIds: ReadonlySet<string>;
  /** Exact text that, sent BY THIS ACCOUNT in a group, reveals the group id. null = discovery off. */
  discoveryToken: string | null;
  directMessages: DirectMessageMode;
  logLevel: LogLevel;
  qrMaxAttempts: number;
  qrAutoOpen: boolean;
  reconnect: { baseMs: number; maxMs: number; maxAttempts: number };
  /** A connection attempt that does not reach "connected" within this window counts as failed. */
  connectTimeoutMs: number;
  healthIntervalMs: number;
  stopPollMs: number;
  metadataRetentionDays: number;
  dedupe: { maxEntries: number; ttlMs: number };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const ZALO_ID = /^[0-9]{1,32}$/;

function bool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return fallback;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new ConfigError(`Giá trị boolean không hợp lệ: "${raw}"`);
}

function int(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} phải là số nguyên trong [${min}, ${max}].`);
  return n;
}

/** Default data dir: per-user, outside any repository. */
export function defaultDataDir(platform: NodeJS.Platform, env: Env, home: string = homedir()): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return path.win32.join(base, "CongTrangBedding", "zalo-personal");
  }
  const base = env.XDG_STATE_HOME || path.posix.join(home, ".local", "state");
  return path.posix.join(base, "congtrangbedding", "zalo-personal");
}

/** Nearest ancestor that contains a `.git` entry (the git work tree root), or null. */
export function findRepoRoot(start: string, exists: (p: string) => boolean = existsSync): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Session data must never be able to land in Git. A data dir inside a work tree
 * is refused unless it is the worker's own git-ignored `.data` folder.
 */
export function assertSafeDataDir(dataDir: string, workerDir: string, exists: (p: string) => boolean = existsSync): void {
  const resolved = path.resolve(dataDir);
  const repoRoot = findRepoRoot(resolved, exists);
  if (!repoRoot) return;
  const allowed = path.resolve(workerDir, ".data");
  const rel = path.relative(allowed, resolved);
  const insideAllowed = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!insideAllowed) {
    throw new ConfigError(`ZP_DATA_DIR nằm trong repository Git (${repoRoot}). Hãy dùng thư mục ngoài repo hoặc "${allowed}" (đã được .gitignore).`);
  }
}

export function loadConfig(env: Env, opts: { platform?: NodeJS.Platform; workerDir: string; exists?: (p: string) => boolean; home?: string }): WorkerConfig {
  const platform = opts.platform ?? process.platform;

  const connectionId = env.ZP_CONNECTION_ID?.trim() || "primary";
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(connectionId)) throw new ConfigError("ZP_CONNECTION_ID chỉ gồm a-z, 0-9, _ và -, tối đa 32 ký tự.");

  const dataDir = path.resolve(env.ZP_DATA_DIR?.trim() || defaultDataDir(platform, env, opts.home));
  assertSafeDataDir(dataDir, opts.workerDir, opts.exists);

  const rawProtection = env.ZP_SESSION_PROTECTION?.trim().toLowerCase() || (platform === "win32" ? "dpapi" : "aes-key");
  if (rawProtection !== "dpapi" && rawProtection !== "aes-key") throw new ConfigError('ZP_SESSION_PROTECTION phải là "dpapi" hoặc "aes-key".');
  if (rawProtection === "dpapi" && platform !== "win32") throw new ConfigError("DPAPI chỉ có trên Windows. Trên Linux dùng ZP_SESSION_PROTECTION=aes-key.");
  const sessionKey = env.ZP_SESSION_KEY?.trim() || null;
  if (rawProtection === "aes-key") {
    if (!sessionKey) throw new ConfigError("ZP_SESSION_PROTECTION=aes-key cần ZP_SESSION_KEY (32 byte ngẫu nhiên dạng base64).");
    if (Buffer.from(sessionKey, "base64").length !== 32) throw new ConfigError("ZP_SESSION_KEY phải là đúng 32 byte dạng base64 (openssl rand -base64 32).");
  }

  const allowedGroupIds = new Set<string>();
  for (const part of (env.ZP_ALLOWED_GROUP_IDS ?? "").split(",")) {
    const id = part.trim();
    if (!id) continue;
    if (!ZALO_ID.test(id)) throw new ConfigError(`ZP_ALLOWED_GROUP_IDS có ID không hợp lệ: "${id}" (chỉ chữ số).`);
    allowedGroupIds.add(id);
  }

  const discoveryToken = env.ZP_DISCOVERY_TOKEN?.trim() || null;
  if (discoveryToken !== null && (discoveryToken.length < 12 || discoveryToken.length > 64 || /\s/.test(discoveryToken))) {
    throw new ConfigError("ZP_DISCOVERY_TOKEN phải dài 12–64 ký tự, không có khoảng trắng (khó đoán, ví dụ ctb-discover-7f3a9c).");
  }

  const directRaw = env.ZP_DIRECT_MESSAGES?.trim().toLowerCase() || "metadata";
  if (directRaw !== "off" && directRaw !== "metadata") throw new ConfigError('ZP_DIRECT_MESSAGES phải là "off" hoặc "metadata".');

  const logLevel = env.ZP_LOG_LEVEL?.trim().toLowerCase() || "info";
  if (!isLogLevel(logLevel)) throw new ConfigError('ZP_LOG_LEVEL phải là "debug", "info", "warn" hoặc "error".');

  const baseMs = int("ZP_RECONNECT_BASE_MS", env.ZP_RECONNECT_BASE_MS, 2_000, 500, 60_000);
  const maxMs = int("ZP_RECONNECT_MAX_MS", env.ZP_RECONNECT_MAX_MS, 120_000, baseMs, 30 * 60_000);

  return {
    enabled: bool(env.ZP_ENABLED, false),
    connectionId,
    dataDir,
    sessionProtection: rawProtection,
    sessionKey: rawProtection === "aes-key" ? sessionKey : null,
    allowedGroupIds,
    discoveryToken,
    directMessages: directRaw,
    logLevel,
    qrMaxAttempts: int("ZP_QR_MAX_ATTEMPTS", env.ZP_QR_MAX_ATTEMPTS, 3, 1, 5),
    qrAutoOpen: bool(env.ZP_QR_AUTO_OPEN, platform === "win32"),
    reconnect: { baseMs, maxMs, maxAttempts: int("ZP_RECONNECT_MAX_ATTEMPTS", env.ZP_RECONNECT_MAX_ATTEMPTS, 6, 0, 20) },
    connectTimeoutMs: int("ZP_CONNECT_TIMEOUT_MS", env.ZP_CONNECT_TIMEOUT_MS, 45_000, 5_000, 300_000),
    healthIntervalMs: int("ZP_HEALTH_INTERVAL_MS", env.ZP_HEALTH_INTERVAL_MS, 15_000, 1_000, 300_000),
    stopPollMs: int("ZP_STOP_POLL_MS", env.ZP_STOP_POLL_MS, 2_000, 200, 60_000),
    metadataRetentionDays: int("ZP_METADATA_RETENTION_DAYS", env.ZP_METADATA_RETENTION_DAYS, 7, 1, 90),
    dedupe: { maxEntries: 5_000, ttlMs: 6 * 60 * 60 * 1000 },
  };
}

/** Well-known file locations inside the data dir. */
export function dataPaths(dataDir: string) {
  return {
    sessionFile: path.join(dataDir, "session.json"),
    lockFile: path.join(dataDir, "worker.lock"),
    stopFile: path.join(dataDir, "STOP"),
    healthFile: path.join(dataDir, "health.json"),
    saltFile: path.join(dataDir, "log-salt"),
    qrDir: path.join(dataDir, "qr"),
    logsDir: path.join(dataDir, "logs"),
    discoveryFile: path.join(dataDir, "discovered-groups.jsonl"),
  };
}
