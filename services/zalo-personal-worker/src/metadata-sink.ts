// ============================================================
// Phase 01 sink: test METADATA only, as local JSONL (logs/events-YYYY-MM-DD.jsonl).
//
// Never written: message text, display names, raw payloads, attachments.
// Conversation / sender ids are replaced by a keyed hash (HMAC-SHA256 with a
// random per-installation salt in <dataDir>/log-salt), so the log can tell
// "same conversation as before" without exposing the Zalo UID. Exception: an
// ALLOWLISTED group id is written in clear (it is already in the operator's
// own config), which makes the manual test traceable.
//
// Phase 02 replaces this sink with the database adapter; the interface stays.
// ============================================================
import { createHmac, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NormalizedEvent } from "./types.ts";

export interface EventSink {
  record(event: NormalizedEvent, context: { ownId: string | null; allowlisted: boolean }): Promise<void>;
  discovered(groupId: string, at: Date): Promise<void>;
}

export async function loadOrCreateSalt(file: string): Promise<Buffer> {
  try {
    const raw = await readFile(file);
    if (raw.length >= 32) return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const salt = randomBytes(32);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, salt, { mode: 0o600 });
  return salt;
}

export function hashId(salt: Buffer, id: string): string {
  return createHmac("sha256", salt).update(id, "utf8").digest("hex").slice(0, 16);
}

/** The exact metadata record written for one event (exported for tests). */
export function metadataRecord(event: NormalizedEvent, ctx: { salt: Buffer; ownId: string | null; allowlisted: boolean }) {
  const base = {
    at: event.receivedAt.toISOString(),
    kind: event.kind,
    connectionId: event.connectionId,
    conversationType: event.conversationType,
    conversationRef: ctx.allowlisted && event.conversationType === "group" ? event.conversationId : `h:${hashId(ctx.salt, event.conversationId)}`,
    senderRef: event.senderExternalId ? `h:${hashId(ctx.salt, event.senderExternalId)}` : null,
    isSelf: event.isSelf,
  };
  if (event.kind !== "message") return { ...base, subtype: event.subtype, hasMessageRef: event.externalMessageId !== null };
  return {
    ...base,
    messageType: event.messageType,
    textLength: event.text?.length ?? 0,
    mentionCount: event.mentions.length,
    mentionsSelf: ctx.ownId !== null && event.mentions.some((m) => m.uid === ctx.ownId),
    sentAt: event.sentAt?.toISOString() ?? null,
    latencyMs: event.sentAt ? event.receivedAt.getTime() - event.sentAt.getTime() : null,
    issues: event.issues,
  };
}

export class JsonlMetadataSink implements EventSink {
  private readonly logsDir: string;
  private readonly discoveryFile: string;
  private readonly salt: Buffer;

  constructor(options: { logsDir: string; discoveryFile: string; salt: Buffer }) {
    this.logsDir = options.logsDir;
    this.discoveryFile = options.discoveryFile;
    this.salt = options.salt;
  }

  async record(event: NormalizedEvent, context: { ownId: string | null; allowlisted: boolean }): Promise<void> {
    const line = JSON.stringify(metadataRecord(event, { salt: this.salt, ...context }));
    await mkdir(this.logsDir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.logsDir, `events-${event.receivedAt.toISOString().slice(0, 10)}.jsonl`), `${line}\n`, { mode: 0o600 });
  }

  async discovered(groupId: string, at: Date): Promise<void> {
    await mkdir(path.dirname(this.discoveryFile), { recursive: true, mode: 0o700 });
    await appendFile(this.discoveryFile, `${JSON.stringify({ at: at.toISOString(), groupId })}\n`, { mode: 0o600 });
  }
}

/** Deletes metadata logs older than `days` (by the date in the file name). */
export async function pruneMetadataLogs(logsDir: string, days: number, now: Date = new Date()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const m = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (Date.parse(`${m[1]}T23:59:59Z`) < cutoff) {
      await rm(path.join(logsDir, name), { force: true });
      removed++;
    }
  }
  return removed;
}
