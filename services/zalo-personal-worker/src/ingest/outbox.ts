// ============================================================
// Local durable outbox (Phase 02).
//
//   <dataDir>/outbox/pending/<createdAtMs>-<eventKey16>.json   waiting / retrying
//   <dataDir>/outbox/dead/…                                     dead letters (kept for the operator)
//
// One file per event, written atomically (tmp + rename), so a crash or a
// shutdown mid-write never leaves a half-written entry; a stray *.tmp is
// discarded at start. The event (which may contain message text) is
// encrypted with AES-256-GCM using the outbox key (itself protected by
// DPAPI / ZP_SESSION_KEY, see secret-store.ts), AAD = eventKey. Only
// delivery metadata (eventKey hash, times, attempt count, error code) is in
// clear text.
//
// Bounded by event count and bytes: when full, NEW events are refused and
// counted (outboxFullDrops) — the listener is never blocked and older
// events keep their order.
// ============================================================
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WireEvent } from "./serializer.ts";

interface EntryFile {
  v: 1;
  eventKey: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  iv: string;
  tag: string;
  data: string;
}

export interface OutboxEntry {
  name: string;
  eventKey: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  bytes: number;
}

export interface OutboxStats {
  depth: number;
  bytes: number;
  dead: number;
  fullDrops: number;
}

export class OutboxCorruptError extends Error {
  constructor() {
    super("Không đọc được một mục outbox (sai khóa hoặc file hỏng).");
    this.name = "OutboxCorruptError";
  }
}

export class Outbox {
  private readonly pendingDir: string;
  private readonly deadDir: string;
  private readonly key: Buffer;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly index = new Map<string, OutboxEntry>();
  private deadCount = 0;
  private fullDrops = 0;
  private totalBytes = 0;

  constructor(options: { dir: string; key: Buffer; maxEvents: number; maxBytes: number }) {
    if (options.key.length !== 32) throw new Error("outbox key must be 32 bytes");
    this.pendingDir = path.join(options.dir, "pending");
    this.deadDir = path.join(options.dir, "dead");
    this.key = options.key;
    this.maxEvents = options.maxEvents;
    this.maxBytes = options.maxBytes;
  }

  /** Rebuilds the index from disk (survives restarts). */
  async init(): Promise<void> {
    await mkdir(this.pendingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.deadDir, { recursive: true, mode: 0o700 });
    this.index.clear();
    this.totalBytes = 0;
    for (const name of await readdir(this.pendingDir)) {
      const file = path.join(this.pendingDir, name);
      if (name.endsWith(".tmp")) {
        await rm(file, { force: true }); // interrupted write: the event was never acknowledged as queued
        continue;
      }
      if (!name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(await readFile(file, "utf8")) as EntryFile;
        if (meta.v !== 1 || !/^[0-9a-f]{64}$/.test(meta.eventKey)) throw new Error("bad entry");
        const bytes = (await stat(file)).size;
        this.index.set(meta.eventKey, { name, eventKey: meta.eventKey, createdAt: meta.createdAt, attempts: meta.attempts, nextAttemptAt: meta.nextAttemptAt, bytes });
        this.totalBytes += bytes;
      } catch {
        await rename(file, path.join(this.deadDir, name)).catch(() => {});
      }
    }
    this.deadCount = (await readdir(this.deadDir)).filter((n) => n.endsWith(".json")).length;
  }

  stats(): OutboxStats {
    return { depth: this.index.size, bytes: this.totalBytes, dead: this.deadCount, fullDrops: this.fullDrops };
  }

  has(eventKey: string): boolean {
    return this.index.has(eventKey);
  }

  async enqueue(event: WireEvent, now: number): Promise<"queued" | "already_queued" | "full"> {
    if (this.index.has(event.eventKey)) return "already_queued";
    const content = this.encode(event, { createdAt: now, attempts: 0, nextAttemptAt: now, lastError: null });
    const bytes = Buffer.byteLength(content, "utf8");
    if (this.index.size >= this.maxEvents || this.totalBytes + bytes > this.maxBytes) {
      this.fullDrops++;
      return "full";
    }
    const name = `${String(now).padStart(13, "0")}-${event.eventKey.slice(0, 16)}.json`;
    await this.atomicWrite(path.join(this.pendingDir, name), content);
    this.index.set(event.eventKey, { name, eventKey: event.eventKey, createdAt: now, attempts: 0, nextAttemptAt: now, bytes });
    this.totalBytes += bytes;
    return "queued";
  }

  /** Oldest due entries first. */
  due(now: number, limit: number): OutboxEntry[] {
    return [...this.index.values()].filter((e) => e.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)).slice(0, limit);
  }

  nextDueAt(): number | null {
    let min: number | null = null;
    for (const e of this.index.values()) if (min === null || e.nextAttemptAt < min) min = e.nextAttemptAt;
    return min;
  }

  async read(entry: OutboxEntry): Promise<WireEvent> {
    const meta = JSON.parse(await readFile(path.join(this.pendingDir, entry.name), "utf8")) as EntryFile;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(meta.iv, "base64"));
      decipher.setAAD(Buffer.from(meta.eventKey, "utf8"));
      decipher.setAuthTag(Buffer.from(meta.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(meta.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as WireEvent;
    } catch {
      throw new OutboxCorruptError();
    }
  }

  /** Delivered (or definitively answered by the server): remove. */
  async ack(entry: OutboxEntry): Promise<void> {
    await rm(path.join(this.pendingDir, entry.name), { force: true });
    if (this.index.delete(entry.eventKey)) this.totalBytes -= entry.bytes;
  }

  async reschedule(entry: OutboxEntry, nextAttemptAt: number, error: string): Promise<void> {
    const file = path.join(this.pendingDir, entry.name);
    const meta = JSON.parse(await readFile(file, "utf8")) as EntryFile;
    meta.attempts = entry.attempts + 1;
    meta.nextAttemptAt = nextAttemptAt;
    meta.lastError = error.slice(0, 64);
    await this.atomicWrite(file, JSON.stringify(meta));
    entry.attempts = meta.attempts;
    entry.nextAttemptAt = nextAttemptAt;
  }

  async deadLetter(entry: OutboxEntry, reason: string): Promise<void> {
    const src = path.join(this.pendingDir, entry.name);
    try {
      const meta = JSON.parse(await readFile(src, "utf8")) as EntryFile;
      meta.lastError = reason.slice(0, 64);
      await this.atomicWrite(src, JSON.stringify(meta));
    } catch {
      /* unreadable: move as is */
    }
    await rename(src, path.join(this.deadDir, entry.name));
    if (this.index.delete(entry.eventKey)) this.totalBytes -= entry.bytes;
    this.deadCount++;
  }

  /** Operator action: move every dead letter back to pending (attempts reset). */
  async retryDead(now: number): Promise<number> {
    let moved = 0;
    for (const name of await readdir(this.deadDir)) {
      if (!name.endsWith(".json")) continue;
      const src = path.join(this.deadDir, name);
      try {
        const meta = JSON.parse(await readFile(src, "utf8")) as EntryFile;
        Object.assign(meta, { attempts: 0, nextAttemptAt: now, lastError: null });
        await this.atomicWrite(path.join(this.pendingDir, name), JSON.stringify(meta));
        await rm(src, { force: true });
        moved++;
      } catch {
        /* leave unreadable dead letters in place */
      }
    }
    await this.init();
    return moved;
  }

  async clear(which: "pending" | "dead" | "all"): Promise<void> {
    if (which !== "dead") await rm(this.pendingDir, { recursive: true, force: true });
    if (which !== "pending") await rm(this.deadDir, { recursive: true, force: true });
    await this.init();
  }

  private encode(event: WireEvent, meta: Pick<EntryFile, "createdAt" | "attempts" | "nextAttemptAt" | "lastError">): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(event.eventKey, "utf8"));
    const data = Buffer.concat([cipher.update(JSON.stringify(event), "utf8"), cipher.final()]);
    const file: EntryFile = { v: 1, eventKey: event.eventKey, ...meta, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    return JSON.stringify(file);
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  }
}
