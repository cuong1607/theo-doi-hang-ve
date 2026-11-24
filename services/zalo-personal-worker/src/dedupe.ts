// Bounded, TTL-based "seen" set for duplicate events (the listener can replay
// events after a reconnect). In memory only: Phase 02 adds the durable unique
// index in PostgreSQL, which stays the real guarantee.

export class DedupeCache {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: { maxEntries: number; ttlMs: number }) {
    this.maxEntries = options.maxEntries;
    this.ttlMs = options.ttlMs;
  }

  /** true the first time a key is seen (within the TTL), false for a duplicate. */
  firstSeen(key: string, nowMs: number): boolean {
    const at = this.seen.get(key);
    if (at !== undefined && nowMs - at < this.ttlMs) return false;
    this.seen.delete(key);
    this.seen.set(key, nowMs);
    this.evict(nowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private evict(nowMs: number): void {
    // Map keeps insertion order: the oldest entries are first
    for (const [key, at] of this.seen) {
      if (this.seen.size <= this.maxEntries && nowMs - at < this.ttlMs) break;
      this.seen.delete(key);
    }
  }
}
