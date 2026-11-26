// ============================================================
// Phase 04.5 — durable send journal (data dir, outside Git, atomic writes).
//
// Written BEFORE a send ("attempting") and right after it ("done" + outcome),
// so a crash / restart in the middle of a send is never mistaken for "not
// sent": on start, an "attempting" entry becomes outcome "unknown" and is
// reported as such — the reply is NEVER sent a second time. A job id already
// in the journal is never sent again either, whatever the server says.
// Outcomes whose report did not reach the backend stay here until it does.
// Holds no message text, no thread id: draft id, claim token, outcome only.
// ============================================================
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SendOutcome } from "./sender.ts";

export interface JournalEntry {
  claimToken: string;
  state: "attempting" | "done";
  outcome: SendOutcome["outcome"] | null;
  zaloMsgId: string | null;
  category: string | null;
  reported: boolean;
  at: number;
}

const KEEP_MS = 7 * 24 * 3_600_000;

export class SendJournal {
  private readonly file: string;
  private entries = new Map<string, JournalEntry>();
  private readonly now: () => number;

  constructor(opts: { file: string; now?: () => number }) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
  }

  /** Loads the journal; interrupted sends become "unknown" (never resent). Returns how many were recovered. */
  async init(): Promise<number> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as { v?: number; entries?: Record<string, JournalEntry> };
      for (const [id, e] of Object.entries(raw.entries ?? {})) if (e && typeof e.claimToken === "string") this.entries.set(id, e);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let recovered = 0;
    for (const e of this.entries.values()) {
      if (e.state === "attempting") {
        e.state = "done";
        e.outcome = "unknown";
        e.category = "worker_restarted";
        e.reported = false;
        recovered++;
      }
    }
    const cutoff = this.now() - KEEP_MS;
    for (const [id, e] of this.entries) if (e.reported && e.at < cutoff) this.entries.delete(id);
    await this.flush();
    return recovered;
  }

  has(draftId: string): boolean {
    return this.entries.has(draftId);
  }

  get(draftId: string): JournalEntry | null {
    return this.entries.get(draftId) ?? null;
  }

  async begin(draftId: string, claimToken: string): Promise<void> {
    this.entries.set(draftId, { claimToken, state: "attempting", outcome: null, zaloMsgId: null, category: null, reported: false, at: this.now() });
    await this.flush();
  }

  async finish(draftId: string, r: SendOutcome): Promise<void> {
    const e = this.entries.get(draftId);
    if (!e) return;
    // a late "sent" may upgrade an "unknown"; nothing else changes a recorded outcome
    if (e.state === "done" && !(e.outcome === "unknown" && r.outcome === "sent")) return;
    e.state = "done";
    e.outcome = r.outcome;
    e.zaloMsgId = r.zaloMsgId;
    e.category = r.category;
    e.reported = false;
    e.at = this.now();
    await this.flush();
  }

  async markReported(draftId: string): Promise<void> {
    const e = this.entries.get(draftId);
    if (!e || e.reported) return;
    e.reported = true;
    await this.flush();
  }

  unreported(): Array<{ draftId: string } & JournalEntry> {
    return [...this.entries].filter(([, e]) => e.state === "done" && !e.reported).map(([draftId, e]) => ({ draftId, ...e }));
  }

  private async flush(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(this.entries) }), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }
}
