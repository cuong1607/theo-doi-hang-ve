// ============================================================
// ZP-04: listener wiring + the event pipeline.
//
//   raw zca-js event ─► normalize ─► group/direct filter ─► dedupe ─► sink
//
// Order matters: the FILTER runs before dedupe and before anything is kept,
// so an event from a non-allowlisted group leaves no trace except an
// aggregate counter. A failing handler never crashes the process.
//
// Subscribed: message, undo, reaction, group_event (content events) and
// connected / closed / error (lifecycle). Deliberately NOT subscribed:
// typing, seen/delivered receipts, old_messages (no history backfill),
// friend_event, sync_event, cipher_key.
// ============================================================
import type { DedupeCache } from "./dedupe.ts";
import { dedupeKey, normalizeEvent, type RawEventName } from "./event-normalizer.ts";
import { decide, type FilterConfig } from "./group-filter.ts";
import type { HealthMonitor } from "./health-monitor.ts";
import { safeError, type Logger } from "./logger.ts";
import type { EventSink } from "./metadata-sink.ts";
import type { ListenerLike } from "./zalo-client.ts";

export const CONTENT_EVENTS: readonly RawEventName[] = ["message", "undo", "reaction", "group_event"];

export interface PipelineDeps {
  connectionId: string;
  filter: FilterConfig;
  dedupe: DedupeCache;
  sink: EventSink;
  health: HealthMonitor;
  logger: Logger;
  ownId: () => string | null;
  now?: () => Date;
  /** Console line for discovery results (the operator needs to see the id). */
  announce?: (line: string) => void;
}

export type PipelineOutcome = "processed" | "duplicate" | "dropped" | "rejected" | "discovered" | "failed";

export function createEventPipeline(deps: PipelineDeps): (name: RawEventName, raw: unknown) => Promise<PipelineOutcome> {
  const now = deps.now ?? (() => new Date());
  return async (name, raw) => {
    deps.health.count("received");
    try {
      const at = now();
      const normalized = normalizeEvent(name, raw, { connectionId: deps.connectionId, now: at });
      if (!normalized.ok) {
        deps.health.countReason("rejected", normalized.reason);
        deps.logger.debug("event_rejected", { eventName: name, reason: normalized.reason });
        return "rejected";
      }
      const event = normalized.event;
      const decision = decide(event, deps.filter);
      if (decision.action === "drop") {
        deps.health.countReason("dropped", decision.reason);
        return "dropped";
      }
      if (decision.action === "discover") {
        deps.health.count("discovered");
        await deps.sink.discovered(decision.groupId, at);
        deps.logger.info("group_discovered", { groupId: decision.groupId });
        deps.announce?.(`>>> Đã phát hiện nhóm. ID nhóm: ${decision.groupId} — thêm vào ZP_ALLOWED_GROUP_IDS nếu muốn theo dõi.`);
        return "discovered";
      }
      const key = dedupeKey(event);
      if (key && !deps.dedupe.firstSeen(key, at.getTime())) {
        deps.health.count("duplicates");
        return "duplicate";
      }
      await deps.sink.record(event, { ownId: deps.ownId(), allowlisted: decision.reason === "allowed_group" });
      deps.health.count("processed");
      deps.logger.debug("event_processed", { kind: event.kind, conversationType: event.conversationType, isSelf: event.isSelf });
      return "processed";
    } catch (err) {
      deps.health.countReason("rejected", "handler_error");
      deps.logger.error("event_handler_failed", { eventName: name, error: safeError(err) });
      return "failed";
    }
  };
}

export interface LifecycleHandlers {
  onConnected(): void;
  onClosed(code: number): void;
  onError(error: unknown): void;
  onEvent(name: RawEventName, raw: unknown): void;
}

/** Subscribes exactly once per listener instance; the caller detaches with removeAllListeners(). */
export function attachListener(listener: ListenerLike, handlers: LifecycleHandlers): void {
  const guard = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    try {
      fn(...args);
    } catch {
      // never let a handler bug take the listener down
    }
  };
  listener.on("connected", guard(() => handlers.onConnected()));
  listener.on("closed", guard((code: number) => handlers.onClosed(code)));
  listener.on("error", guard((error: unknown) => handlers.onError(error)));
  for (const name of CONTENT_EVENTS) listener.on(name, guard((raw: unknown) => handlers.onEvent(name, raw)));
}
