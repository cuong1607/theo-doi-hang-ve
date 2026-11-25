// ============================================================
// PHASE 05 — Central AI System Assistant configuration. Pure.
//
//   AI_SYSTEM_ASSISTANT_ENABLED     web dashboard assistant (default OFF)
//   AI_SYSTEM_OA_ENABLED            Zalo OA adapter may answer (default OFF;
//                                   not wired into the OA webhook in Phase 05)
//   AI_SYSTEM_PERSONAL_DRAFTS_ENABLED  Zalo Personal adapter may build reply
//                                   DRAFTS (default OFF; never sends)
//   AI_SYSTEM_MAX_TOOL_CALLS        tool calls per question (default 3, 1–5)
//   AI_SYSTEM_TOOL_TIMEOUT_MS       per tool call (default 8000)
//   AI_SYSTEM_MAX_ROWS              rows a tool may return (default 20, 5–50)
//   AI_SYSTEM_REQUESTS_PER_MINUTE   questions per user per minute (default 6)
//
// The model, key, data-sharing policy and daily budget are the Phase 04 ones
// (src/lib/ai-assistant/config.ts): ONE Gemini provider, ONE budget.
// ============================================================
import type { AiConfig } from "../ai-assistant/config.ts";

type Env = Record<string, string | undefined>;

const on = (raw: string | undefined) => ["true", "1", "on", "yes"].includes((raw ?? "").trim().toLowerCase());
function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export interface SystemAssistantConfig {
  webEnabled: boolean;
  oaEnabled: boolean;
  personalDraftsEnabled: boolean;
  maxToolCalls: number;
  toolTimeoutMs: number;
  maxRows: number;
  requestsPerMinute: number;
}

export function getSystemAssistantConfig(env: Env = process.env): SystemAssistantConfig {
  return {
    webEnabled: on(env.AI_SYSTEM_ASSISTANT_ENABLED),
    oaEnabled: on(env.AI_SYSTEM_OA_ENABLED),
    personalDraftsEnabled: on(env.AI_SYSTEM_PERSONAL_DRAFTS_ENABLED),
    maxToolCalls: int(env.AI_SYSTEM_MAX_TOOL_CALLS, 3, 1, 5),
    toolTimeoutMs: int(env.AI_SYSTEM_TOOL_TIMEOUT_MS, 8_000, 1_000, 20_000),
    maxRows: int(env.AI_SYSTEM_MAX_ROWS, 20, 5, 50),
    requestsPerMinute: int(env.AI_SYSTEM_REQUESTS_PER_MINUTE, 6, 1, 60),
  };
}

export type ModelUnavailable = "ai_disabled" | "config_missing" | "model_invalid";

/**
 * May the assistant call the Phase 04 provider at all? (AI_ENABLED + key/model;
 * the Zalo Personal feature flag is irrelevant here.) Without it the assistant
 * still answers: rule-based tool choice + deterministic wording.
 */
export function modelReadiness(c: AiConfig): { ready: true } | { ready: false; reason: ModelUnavailable } {
  if (!c.enabled) return { ready: false, reason: "ai_disabled" };
  if (c.provider === "fake") return { ready: true };
  if (!c.apiKeyConfigured || c.model === null) return { ready: false, reason: "config_missing" };
  if (!c.modelValid) return { ready: false, reason: "model_invalid" };
  return { ready: true };
}

/** Prompt / schema version (logged with every provider call). */
export const SYSTEM_PROMPT_VERSION = "sys-ai-1";
