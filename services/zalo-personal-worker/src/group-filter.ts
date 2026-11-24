// ============================================================
// ZP-06: which events may be processed at all. Pure.
//
//   * Groups are NOT monitored unless their id is in the approved allowlist
//     (ZP_ALLOWED_GROUP_IDS). A new / unknown group is dropped before anything
//     about it is kept — only an aggregate counter is incremented.
//   * Discovery: a group message whose text is EXACTLY the configured token
//     AND that was sent BY THIS ACCOUNT reveals that group's id (so the owner
//     can add it to the allowlist). Nothing else from the message is kept,
//     and a token typed by another member never triggers it.
//   * Direct (1-1) messages: "metadata" (default) or "off".
// ============================================================
import type { NormalizedEvent } from "./types.ts";

export type FilterDecision =
  | { action: "process"; reason: "allowed_group" | "direct_metadata" }
  | { action: "discover"; groupId: string }
  | { action: "drop"; reason: "group_not_allowed" | "direct_disabled" | "discovery_not_self" };

export interface FilterConfig {
  allowedGroupIds: ReadonlySet<string>;
  discoveryToken: string | null;
  directMessages: "off" | "metadata";
}

export function decide(event: NormalizedEvent, config: FilterConfig): FilterDecision {
  if (event.conversationType === "direct") {
    return config.directMessages === "metadata" ? { action: "process", reason: "direct_metadata" } : { action: "drop", reason: "direct_disabled" };
  }

  if (event.kind === "message" && config.discoveryToken !== null && event.text !== null && event.text.trim() === config.discoveryToken) {
    // even for an allowlisted group, the token itself is never processed as content
    return event.isSelf ? { action: "discover", groupId: event.conversationId } : { action: "drop", reason: "discovery_not_self" };
  }

  if (config.allowedGroupIds.has(event.conversationId)) return { action: "process", reason: "allowed_group" };
  return { action: "drop", reason: "group_not_allowed" };
}
