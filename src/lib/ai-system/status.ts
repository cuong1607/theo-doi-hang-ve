// ============================================================
// PHASE 05 — what the page / status API shows about the assistant for ONE
// user: model state, data policy, today's model usage vs. limits, and the
// tools this user may use (by role) — derived, never configurable here. Pure.
// ============================================================
import type { AiConfig } from "../ai-assistant/config.ts";
import { sharingDecision } from "../ai-assistant/policy.ts";
import { modelReadiness, type SystemAssistantConfig } from "./config.ts";
import { toolAccess } from "./policy.ts";
import type { SystemToolRegistry } from "./registry.ts";
import type { InternalActor } from "./types.ts";

export interface SystemAssistantStatus {
  model: { provider: AiConfig["provider"]; name: string | null; tier: AiConfig["tier"]; ready: boolean; unavailable: string | null };
  /** may business data be sent to the model (else answers are formatted without AI) */
  dataToModel: "allowed" | "policy_none" | "free_tier_not_approved" | "redacted_only";
  usage: { modelCallsToday: number; perUserPerDay: number };
  limits: { maxToolCalls: number; maxRows: number; requestsPerMinute: number };
  tools: Array<{ name: string; title: string; module: string; examples: readonly string[] }>;
}

export function buildStatus(a: { aiConfig: AiConfig; config: SystemAssistantConfig; registry: SystemToolRegistry; actor: InternalActor; modelCallsToday: number }): SystemAssistantStatus {
  const ready = modelReadiness(a.aiConfig);
  const sharing = sharingDecision(a.aiConfig);
  return {
    model: { provider: a.aiConfig.provider, name: a.aiConfig.model, tier: a.aiConfig.tier, ready: ready.ready, unavailable: ready.ready ? null : ready.reason },
    dataToModel: !sharing.allowed ? sharing.reason : sharing.redact ? "redacted_only" : "allowed",
    usage: { modelCallsToday: a.modelCallsToday, perUserPerDay: a.aiConfig.limits.maxRequestsPerUserPerDay },
    limits: { maxToolCalls: a.config.maxToolCalls, maxRows: a.config.maxRows, requestsPerMinute: a.config.requestsPerMinute },
    tools: a.registry
      .list()
      .filter((t) => toolAccess(t, a.actor, "private").allowed)
      .map((t) => ({ name: t.name, title: t.title, module: t.module, examples: t.examples })),
  };
}
