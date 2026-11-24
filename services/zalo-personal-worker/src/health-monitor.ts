// ============================================================
// Health snapshot (health.json in the data dir), read by `npm run status`.
// Aggregates only: state, timestamps and counters — no ids, names or text,
// so the file can be shown or shipped to monitoring without personal data.
// ============================================================
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectionState, ErrorReason } from "./connection-state.ts";

export interface HealthSnapshot {
  v: 1;
  pid: number;
  connectionId: string;
  state: ConnectionState;
  stateSince: string;
  startedAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  reconnectAttempt: number;
  errorReason: ErrorReason | null;
  /** Phase 02 delivery state (null when ingestion is off). Aggregates only. */
  ingest: null | { outboxDepth: number; deadLetters: number; outboxFullDrops: number; lastDeliveryOkAt: string | null; consecutiveFailures: number; authPaused: boolean; lastErrorCategory: string | null };
  counters: {
    received: number;
    processed: number;
    duplicates: number;
    discovered: number;
    dropped: Record<string, number>;
    rejected: Record<string, number>;
  };
}

export class HealthMonitor {
  private snapshot: HealthSnapshot;
  private readonly file: string;
  private readonly now: () => Date;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: { file: string; connectionId: string; pid?: number; now?: () => Date }) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date());
    const at = this.now().toISOString();
    this.snapshot = {
      v: 1,
      pid: options.pid ?? process.pid,
      connectionId: options.connectionId,
      state: "disconnected",
      stateSince: at,
      startedAt: at,
      updatedAt: at,
      lastConnectedAt: null,
      lastEventAt: null,
      reconnectAttempt: 0,
      errorReason: null,
      ingest: null,
      counters: { received: 0, processed: 0, duplicates: 0, discovered: 0, dropped: {}, rejected: {} },
    };
  }

  get current(): Readonly<HealthSnapshot> {
    return this.snapshot;
  }

  setState(state: ConnectionState, extra: { errorReason?: ErrorReason | null; reconnectAttempt?: number } = {}): void {
    const at = this.now().toISOString();
    if (state !== this.snapshot.state) this.snapshot.stateSince = at;
    this.snapshot.state = state;
    if (state === "connected") this.snapshot.lastConnectedAt = at;
    if (extra.errorReason !== undefined) this.snapshot.errorReason = extra.errorReason;
    else if (state !== "error") this.snapshot.errorReason = null;
    if (extra.reconnectAttempt !== undefined) this.snapshot.reconnectAttempt = extra.reconnectAttempt;
    void this.flush();
  }

  setIngest(ingest: HealthSnapshot["ingest"]): void {
    this.snapshot.ingest = ingest;
  }

  count(kind: "received" | "processed" | "duplicates" | "discovered"): void {
    this.snapshot.counters[kind]++;
    if (kind === "received") this.snapshot.lastEventAt = this.now().toISOString();
  }

  countReason(bucket: "dropped" | "rejected", reason: string): void {
    const map = this.snapshot.counters[bucket];
    map[reason] = (map[reason] ?? 0) + 1;
  }

  /** Serialized atomic write (tmp + rename); failures never crash the worker. */
  flush(): Promise<void> {
    this.snapshot.updatedAt = this.now().toISOString();
    const data = JSON.stringify(this.snapshot, null, 2);
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, this.file);
      } catch {
        // health is best effort
      }
    });
    return this.writing;
  }
}

export async function readHealth(file: string): Promise<HealthSnapshot | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as HealthSnapshot;
  } catch {
    return null;
  }
}
