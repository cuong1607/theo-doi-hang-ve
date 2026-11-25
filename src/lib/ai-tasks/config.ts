// ============================================================
// PHASE 06 — the ONE place for the task / reminder engine's configuration.
// Pure (no I/O, no "@/" imports): unit-testable. Everything is OFF by default.
//
//   AI_TASKS_ENABLED                    master switch: engine tick + task dashboard (default off)
//   AI_TASKS_AI_EXTRACTION_ENABLED      send candidates to Gemini (default off). Also needs
//                                       AI_ENABLED + the Phase 04 data-sharing policy.
//   AI_TASKS_RULES_FALLBACK             deterministic extraction when the model may not / can
//                                       not be used (default on) — always pending_confirmation
//   AI_TASKS_MAX_CANDIDATES_PER_DAY     per connection, VN day (default 200)
//   AI_TASKS_MAX_EXTRACTIONS_PER_DAY    model calls for task extraction, all users (default 30)
//   AI_TASKS_BACKFILL_MINUTES           history scanned when a connection is first seen (default 0)
//   AI_TASKS_TICK_BUDGET_MS             time one tick may spend (default 45000)
//
// Reminder windows (minutes unless stated):
//   AI_REMINDER_DAY_LEAD_HOURS 24 · AI_REMINDER_HOUR_LEAD_MINUTES 60 · AI_REMINDER_OVERDUE_DELAY_MINUTES 5
//   AI_REMINDER_MORNING_HOUR 8 · AI_REMINDER_MORNING_CUTOFF_HOUR 10
//   AI_REMINDER_DAY_GRACE_MINUTES 60 · AI_REMINDER_HOUR_GRACE_MINUTES 15
//   AI_REMINDER_OVERDUE_ON_TIME_MINUTES 60 (later → one aggregated alert per user)
//   AI_REMINDER_MAX_ATTEMPTS 5 · AI_REMINDER_BACKOFF_BASE_SECONDS 60 · AI_REMINDER_LEASE_SECONDS 120
//
// External channels (adapter only — no real sender exists yet, see channels.ts):
//   ZALO_NOTIFY_PERSONAL_ENABLED / ZALO_NOTIFY_OA_ENABLED   per-channel flags (default off)
//   ZALO_NOTIFY_KILL_SWITCH                                 true = nothing external, ever (default ON)
//   ZALO_NOTIFY_MAX_PER_USER_PER_HOUR                       default 6
// ============================================================

type Env = Record<string, string | undefined>;

const on = (raw: string | undefined) => ["true", "1", "on", "yes"].includes((raw ?? "").trim().toLowerCase());
const offUnlessFalse = (raw: string | undefined) => !["false", "0", "off", "no"].includes((raw ?? "").trim().toLowerCase());
function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export interface ReminderWindows {
  dayLeadMs: number;
  hourLeadMs: number;
  overdueDelayMs: number;
  morningHour: number;
  morningCutoffHour: number;
  dayGraceMs: number;
  hourGraceMs: number;
  overdueOnTimeMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  leaseSeconds: number;
}

export interface ExternalChannelConfig {
  zaloPersonalEnabled: boolean;
  zaloOaEnabled: boolean;
  killSwitch: boolean;
  maxPerUserPerHour: number;
}

export interface TaskEngineConfig {
  enabled: boolean;
  aiExtractionEnabled: boolean;
  rulesFallback: boolean;
  maxCandidatesPerDay: number;
  maxExtractionsPerDay: number;
  backfillMinutes: number;
  tickBudgetMs: number;
  /** messages ingested in the last N ms are left for the next tick (settle lag vs concurrent ingestion) */
  scanSettleMs: number;
  scanBatch: number;
  extractBatch: number;
  contextMessages: number;
  reminders: ReminderWindows;
  external: ExternalChannelConfig;
}

const MIN = 60_000;

export function getTaskEngineConfig(env: Env = process.env): TaskEngineConfig {
  return {
    enabled: on(env.AI_TASKS_ENABLED),
    aiExtractionEnabled: on(env.AI_TASKS_AI_EXTRACTION_ENABLED),
    rulesFallback: offUnlessFalse(env.AI_TASKS_RULES_FALLBACK),
    maxCandidatesPerDay: int(env.AI_TASKS_MAX_CANDIDATES_PER_DAY, 200, 0, 10_000),
    maxExtractionsPerDay: int(env.AI_TASKS_MAX_EXTRACTIONS_PER_DAY, 30, 0, 5_000),
    backfillMinutes: int(env.AI_TASKS_BACKFILL_MINUTES, 0, 0, 10_080),
    tickBudgetMs: int(env.AI_TASKS_TICK_BUDGET_MS, 45_000, 5_000, 280_000),
    scanSettleMs: int(env.AI_TASKS_SCAN_SETTLE_SECONDS, 10, 0, 300) * 1000,
    scanBatch: int(env.AI_TASKS_SCAN_BATCH, 200, 10, 500),
    extractBatch: int(env.AI_TASKS_EXTRACT_BATCH, 5, 1, 10),
    contextMessages: int(env.AI_TASKS_CONTEXT_MESSAGES, 6, 0, 20),
    reminders: {
      dayLeadMs: int(env.AI_REMINDER_DAY_LEAD_HOURS, 24, 1, 168) * 60 * MIN,
      hourLeadMs: int(env.AI_REMINDER_HOUR_LEAD_MINUTES, 60, 5, 720) * MIN,
      overdueDelayMs: int(env.AI_REMINDER_OVERDUE_DELAY_MINUTES, 5, 0, 1_440) * MIN,
      morningHour: int(env.AI_REMINDER_MORNING_HOUR, 8, 0, 12),
      morningCutoffHour: int(env.AI_REMINDER_MORNING_CUTOFF_HOUR, 10, 1, 23),
      dayGraceMs: int(env.AI_REMINDER_DAY_GRACE_MINUTES, 60, 1, 1_440) * MIN,
      hourGraceMs: int(env.AI_REMINDER_HOUR_GRACE_MINUTES, 15, 1, 120) * MIN,
      overdueOnTimeMs: int(env.AI_REMINDER_OVERDUE_ON_TIME_MINUTES, 60, 5, 1_440) * MIN,
      maxAttempts: int(env.AI_REMINDER_MAX_ATTEMPTS, 5, 1, 20),
      backoffBaseMs: int(env.AI_REMINDER_BACKOFF_BASE_SECONDS, 60, 5, 3_600) * 1000,
      leaseSeconds: int(env.AI_REMINDER_LEASE_SECONDS, 120, 30, 900),
    },
    external: {
      zaloPersonalEnabled: on(env.ZALO_NOTIFY_PERSONAL_ENABLED),
      zaloOaEnabled: on(env.ZALO_NOTIFY_OA_ENABLED),
      killSwitch: offUnlessFalse(env.ZALO_NOTIFY_KILL_SWITCH),
      maxPerUserPerHour: int(env.ZALO_NOTIFY_MAX_PER_USER_PER_HOUR, 6, 0, 60),
    },
  };
}

/** Prompt / schema version of the extractor (stored with nothing; part of logs). */
export const TASK_EXTRACT_PROMPT_VERSION = "zp-task-1";
