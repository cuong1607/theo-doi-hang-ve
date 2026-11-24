// ============================================================
// Session persistence (ZP-03).
//
// File format (session.json, in the data dir — never in Git):
//   { "v": 1, "protection": "dpapi" | "aes-key", "connectionId": "...",
//     "savedAt": ISO, "status": "active" | "rejected", "payload": base64 }
// `payload` is the PROTECTED bytes of the JSON credentials
// { imei, cookie, userAgent, language }. Nothing readable is stored in clear
// text except the envelope metadata above.
//
// "rejected": Zalo refused the saved session once → the worker never retries
// it automatically (no login loop); a new QR login replaces it.
// ============================================================
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionProtector } from "./session-protector.ts";

export interface SessionCredentials {
  imei: string;
  /** Serialized cookies as returned by zca-js (opaque to this worker). */
  cookie: unknown[];
  userAgent: string;
  language?: string;
}

export type SessionStatus = "active" | "rejected";

interface Envelope {
  v: 1;
  protection: SessionProtector["name"];
  connectionId: string;
  savedAt: string;
  status: SessionStatus;
  payload: string;
}

export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionFormatError";
  }
}

export type LoadResult =
  | { status: "none" }
  | { status: "rejected"; savedAt: string }
  | { status: "active"; savedAt: string; credentials: SessionCredentials };

function validateCredentials(value: unknown): SessionCredentials {
  const v = value as Partial<SessionCredentials> | null;
  if (!v || typeof v !== "object") throw new SessionFormatError("Phiên không hợp lệ.");
  if (typeof v.imei !== "string" || !v.imei) throw new SessionFormatError("Phiên thiếu imei.");
  if (!Array.isArray(v.cookie) || v.cookie.length === 0) throw new SessionFormatError("Phiên thiếu cookie.");
  if (typeof v.userAgent !== "string" || !v.userAgent) throw new SessionFormatError("Phiên thiếu userAgent.");
  return { imei: v.imei, cookie: v.cookie, userAgent: v.userAgent, language: typeof v.language === "string" ? v.language : undefined };
}

export class SessionManager {
  private readonly file: string;
  private readonly protector: SessionProtector;
  private readonly connectionId: string;

  constructor(options: { file: string; protector: SessionProtector; connectionId: string }) {
    this.file = options.file;
    this.protector = options.protector;
    this.connectionId = options.connectionId;
  }

  async save(credentials: SessionCredentials, now: Date = new Date()): Promise<void> {
    const clean = validateCredentials(credentials);
    const protectedBytes = await this.protector.protect(Buffer.from(JSON.stringify(clean), "utf8"));
    const envelope: Envelope = {
      v: 1,
      protection: this.protector.name,
      connectionId: this.connectionId,
      savedAt: now.toISOString(),
      status: "active",
      payload: protectedBytes.toString("base64"),
    };
    await this.writeEnvelope(envelope);
  }

  async load(): Promise<LoadResult> {
    const envelope = await this.readEnvelope();
    if (!envelope) return { status: "none" };
    if (envelope.status === "rejected") return { status: "rejected", savedAt: envelope.savedAt };
    const plain = await this.protector.unprotect(Buffer.from(envelope.payload, "base64"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(plain.toString("utf8"));
    } catch {
      throw new SessionFormatError("Phiên đã giải mã nhưng không đọc được.");
    } finally {
      plain.fill(0);
    }
    return { status: "active", savedAt: envelope.savedAt, credentials: validateCredentials(parsed) };
  }

  /** Envelope metadata only — never decrypts (for `status`). */
  async peek(): Promise<{ status: "none" } | { status: SessionStatus; savedAt: string; protection: string }> {
    const envelope = await this.readEnvelope();
    if (!envelope) return { status: "none" };
    return { status: envelope.status, savedAt: envelope.savedAt, protection: envelope.protection };
  }

  /** Marks the stored session as refused by Zalo (keeps no usable credentials). */
  async markRejected(now: Date = new Date()): Promise<void> {
    const envelope = await this.readEnvelope().catch(() => null);
    if (!envelope) return;
    await this.writeEnvelope({ ...envelope, status: "rejected", savedAt: now.toISOString(), payload: "" });
  }

  async clear(): Promise<boolean> {
    try {
      await rm(this.file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  private async readEnvelope(): Promise<Envelope | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let env: Partial<Envelope>;
    try {
      env = JSON.parse(raw) as Partial<Envelope>;
    } catch {
      throw new SessionFormatError("File phiên bị hỏng.");
    }
    if (env.v !== 1) throw new SessionFormatError("Phiên bản file phiên không được hỗ trợ.");
    if (env.protection !== this.protector.name) throw new SessionFormatError(`Phiên được bảo vệ bằng "${String(env.protection)}", cấu hình hiện tại là "${this.protector.name}".`);
    if (env.connectionId !== this.connectionId) throw new SessionFormatError("Phiên thuộc connection khác.");
    if (env.status !== "active" && env.status !== "rejected") throw new SessionFormatError("Trạng thái phiên không hợp lệ.");
    if (typeof env.payload !== "string" || typeof env.savedAt !== "string") throw new SessionFormatError("File phiên thiếu trường.");
    return env as Envelope;
  }

  private async writeEnvelope(envelope: Envelope): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }
}
