// ============================================================
// Redacting structured logger.
//
// Rules (ZP-08):
//   * never log cookies, tokens, QR data, session data, imei, user agent;
//   * never log message text / content;
//   * never log a raw error message from zca-js: the library embeds
//     JSON.stringify(<server response>) in some of its error messages, so
//     only the error NAME and numeric CODE are ever written (safeError).
// Redaction is by key name AND by value shape (long base64 / hex blobs), so a
// secret that slips in under an unexpected key is still masked.
// ============================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never written (case-insensitive substring match). */
const SENSITIVE_KEY = /cookie|token|secret|session|imei|user[-_]?agent|password|passwd|qr|image|avatar|credential|authorization|zpw|enk|key|text|content|message[-_]?body|display[-_]?name|dname|phone/i;

/** Keys that look sensitive by the regex above but are safe, explicit metadata. */
const SAFE_KEYS = new Set(["textLength", "messageType", "keyCount", "event", "reason", "state", "previousState"]);

/** Long opaque blobs (base64 / hex / JWT-like) are masked wherever they appear. */
const OPAQUE_BLOB = /^[A-Za-z0-9+/_=.-]{40,}$/;

export const REDACTED = "[redacted]";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return OPAQUE_BLOB.test(value) ? REDACTED : value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return safeError(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = !SAFE_KEYS.has(k) && SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

export interface SafeError {
  name: string;
  code?: number | string;
}

/** The only representation of an error that may be logged: name + code, never the message. */
export function safeError(err: unknown): SafeError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const out: SafeError = { name: err.name || "Error" };
    if (typeof code === "number" || (typeof code === "string" && /^[A-Z0-9_-]{1,40}$/i.test(code))) out.code = code;
    return out;
  }
  return { name: typeof err };
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type LogWriter = (line: string, level: LogLevel) => void;

const defaultWriter: LogWriter = (line, level) => {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export function createLogger(options: { level?: LogLevel; writer?: LogWriter; now?: () => Date } = {}): Logger {
  const min = LEVEL_ORDER[options.level ?? "info"];
  const writer = options.writer ?? defaultWriter;
  const now = options.now ?? (() => new Date());
  const log = (level: LogLevel) => (event: string, fields: Record<string, unknown> = {}) => {
    if (LEVEL_ORDER[level] < min) return;
    const record = { at: now().toISOString(), level, source: "zalo-personal-worker", event, ...(redact(fields) as Record<string, unknown>) };
    writer(JSON.stringify(record), level);
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVEL_ORDER;
}
