// ============================================================
// Local secrets of the ingestion client, protected like the Zalo session
// (DPAPI on Windows, AES key from ZP_SESSION_KEY on Linux):
//   ingest-secret.json   the worker's HMAC secret (unless ZP_INGEST_SECRET is
//                        injected by the service manager on a VPS)
//   outbox.key           random 32-byte data key encrypting outbox entries
// The worker never holds a Supabase key of any kind.
// ============================================================
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionProtector } from "../session-protector.ts";

interface Envelope {
  v: 1;
  purpose: "ingest-secret" | "outbox-key";
  protection: SessionProtector["name"];
  payload: string;
}

async function readEnvelope(file: string, purpose: Envelope["purpose"], protector: SessionProtector): Promise<Buffer | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const env = JSON.parse(raw) as Partial<Envelope>;
  if (env.v !== 1 || env.purpose !== purpose || env.protection !== protector.name || typeof env.payload !== "string") throw new Error(`File ${path.basename(file)} không hợp lệ hoặc khác chế độ bảo vệ.`);
  return protector.unprotect(Buffer.from(env.payload, "base64"));
}

async function writeEnvelope(file: string, purpose: Envelope["purpose"], protector: SessionProtector, plain: Buffer): Promise<void> {
  const payload = (await protector.protect(plain)).toString("base64");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ v: 1, purpose, protection: protector.name, payload } satisfies Envelope), { mode: 0o600 });
  await rename(tmp, file);
}

const SECRET_FORMAT = /^zps_[A-Za-z0-9_-]{43}$/;

export function isValidIngestSecret(secret: string): boolean {
  return SECRET_FORMAT.test(secret);
}

export async function saveIngestSecret(file: string, protector: SessionProtector, secret: string): Promise<void> {
  if (!isValidIngestSecret(secret)) throw new Error("Secret không đúng định dạng (zps_…).");
  await writeEnvelope(file, "ingest-secret", protector, Buffer.from(secret, "utf8"));
}

export async function loadIngestSecret(file: string, protector: SessionProtector, fromEnv: string | null): Promise<string | null> {
  if (fromEnv) {
    if (!isValidIngestSecret(fromEnv)) throw new Error("ZP_INGEST_SECRET không đúng định dạng (zps_…).");
    return fromEnv;
  }
  const plain = await readEnvelope(file, "ingest-secret", protector);
  if (!plain) return null;
  const secret = plain.toString("utf8");
  plain.fill(0);
  if (!isValidIngestSecret(secret)) throw new Error("Secret đã lưu bị hỏng.");
  return secret;
}

export async function clearIngestSecret(file: string): Promise<void> {
  await rm(file, { force: true });
}

export async function loadOrCreateOutboxKey(file: string, protector: SessionProtector): Promise<Buffer> {
  const existing = await readEnvelope(file, "outbox-key", protector);
  if (existing) {
    if (existing.length !== 32) throw new Error("outbox.key bị hỏng.");
    return existing;
  }
  const key = randomBytes(32);
  await writeEnvelope(file, "outbox-key", protector, key);
  return key;
}
