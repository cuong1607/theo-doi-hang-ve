// Phase 02 sinks: the allowed events go to the durable outbox (minimized by
// the serializer); the Phase 01 local metadata JSONL keeps working beside it.
import type { DirectMessageMode } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { EventSink } from "../metadata-sink.ts";
import type { NormalizedEvent } from "../types.ts";
import type { Outbox } from "./outbox.ts";
import { discoveryWireEvent, toWireEvent } from "./serializer.ts";

export class OutboxSink implements EventSink {
  private readonly o: { outbox: Outbox; connectionId: string; directMessages: DirectMessageMode; logger: Logger; now?: () => number };

  constructor(options: OutboxSink["o"]) {
    this.o = options;
  }

  private async put(wire: ReturnType<typeof toWireEvent>): Promise<void> {
    const r = await this.o.outbox.enqueue(wire, (this.o.now ?? Date.now)());
    if (r === "full") this.o.logger.warn("outbox_full_event_dropped", { kind: wire.kind, depth: this.o.outbox.stats().depth });
  }

  async record(event: NormalizedEvent, context: { ownId: string | null }): Promise<void> {
    await this.put(toWireEvent(event, { ownId: context.ownId, directMessages: this.o.directMessages }));
  }

  async discovered(groupId: string, at: Date): Promise<void> {
    await this.put(discoveryWireEvent(this.o.connectionId, groupId, at));
  }
}

/** Fans one event out to several sinks; every sink is attempted. */
export class CompositeSink implements EventSink {
  private readonly sinks: EventSink[];

  constructor(sinks: EventSink[]) {
    this.sinks = sinks;
  }

  async record(event: NormalizedEvent, context: { ownId: string | null; allowlisted: boolean }): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((s) => s.record(event, context)));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  async discovered(groupId: string, at: Date): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((s) => s.discovered(groupId, at)));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }
}
