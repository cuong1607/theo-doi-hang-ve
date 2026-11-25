// ============================================================
// PHASE 06 — ReminderPlanner (TASK-07) + missed-reminder recovery policy
// (TASK-08). Pure; thresholds come from config.ts (ReminderWindows).
//
// Planner — only for a CONFIRMED open task (accepted / in_progress) with a deadline:
//   DAY      deadline − 24 h      HOUR   deadline − 1 h      OVERDUE  deadline + 5 min
//   one occurrence per (kind, recipient); never in the past; respects each
//   recipient's preferences. MORNING (08:00 VN, one digest per user per day) is
//   created by the engine for every user who has open tasks (ai_reminder_ensure_morning).
//   A changed deadline / assignee / status bumps the task version: SQL cancels
//   the old pending occurrences (superseded) and inserts the new plan.
//
// Recovery — decided when an occurrence is CLAIMED, i.e. also after the worker
// was down (lateness = now − scheduled_for):
//   1 recipient locked / lost the module                → skipped access_revoked
//   2 MORNING outside its VN day or at / after 10:00    → skipped_expired morning_window_closed
//   3 task gone / closed / not confirmed                → cancelled task_closed
//   4 occurrence of an older task version               → cancelled superseded
//   5 recipient can no longer read the source chat      → skipped access_revoked
//   6 recipient turned this kind off                    → skipped preference_off
//   7 DAY / HOUR at or after the deadline               → skipped_expired past_deadline
//   8 DAY late ≥ 60 min, HOUR late ≥ 15 min             → skipped_expired too_late
//   9 otherwise send (sent_late when late > 2 min). OVERDUE late ≥ 60 min is
//     sent as ONE aggregated alert per user (never a burst after a long outage).
// Boundaries: "dưới 1 giờ" = lateness < 60:00 exactly; 60:00 is skipped.
// ============================================================
import type { ReminderWindows } from "./config.ts";
import type { TaskStatus } from "./lifecycle.ts";
import { vnDateKey, vnParts, vnTime } from "./time.ts";

export type ReminderKind = "DAY" | "HOUR" | "OVERDUE" | "MORNING";

export interface ReminderPrefs {
  day_enabled: boolean;
  hour_enabled: boolean;
  overdue_enabled: boolean;
  morning_enabled: boolean;
  mention_enabled: boolean;
  confirmation_enabled: boolean;
  zalo_personal_enabled: boolean;
  zalo_oa_enabled: boolean;
}

export const DEFAULT_PREFS: ReminderPrefs = {
  day_enabled: true,
  hour_enabled: true,
  overdue_enabled: true,
  morning_enabled: true,
  mention_enabled: true,
  confirmation_enabled: true,
  zalo_personal_enabled: false,
  zalo_oa_enabled: false,
};

export const prefsOf = (raw: Partial<ReminderPrefs> | null | undefined): ReminderPrefs => ({ ...DEFAULT_PREFS, ...(raw ?? {}) });

const KIND_PREF: Record<ReminderKind, keyof ReminderPrefs> = { DAY: "day_enabled", HOUR: "hour_enabled", OVERDUE: "overdue_enabled", MORNING: "morning_enabled" };

export interface PlannedOccurrence {
  kind: Exclude<ReminderKind, "MORNING">;
  userId: string;
  scheduledFor: Date;
  localDate: string;
}

export function planReminders(task: { status: TaskStatus; deadlineAt: Date | null }, recipients: ReadonlyArray<{ userId: string; prefs: ReminderPrefs }>, now: Date, w: ReminderWindows): PlannedOccurrence[] {
  if (!task.deadlineAt || (task.status !== "accepted" && task.status !== "in_progress")) return [];
  const d = task.deadlineAt.getTime();
  const slots: Array<[PlannedOccurrence["kind"], number]> = [
    ["DAY", d - w.dayLeadMs],
    ["HOUR", d - w.hourLeadMs],
    ["OVERDUE", d + w.overdueDelayMs],
  ];
  const out: PlannedOccurrence[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    for (const [kind, at] of slots) {
      if (at <= now.getTime()) continue; // never in the past
      if (!r.prefs[KIND_PREF[kind]]) continue;
      // DAY that would fire after HOUR (deadline < 24 h + 1 h away) is still useful; HOUR before DAY never happens
      const scheduledFor = new Date(at);
      out.push({ kind, userId: r.userId, scheduledFor, localDate: vnDateKey(scheduledFor) });
    }
  }
  return out;
}

/** 08:00 VN of the VN day containing `now` (+ its "YYYY-MM-DD"). */
export function morningSlot(now: Date, w: ReminderWindows): { localDate: string; scheduledFor: Date } {
  const p = vnParts(now);
  return { localDate: vnDateKey(now), scheduledFor: vnTime(p.year, p.month, p.day, w.morningHour, 0) };
}

// ------------------------------------------------------------------ recovery

export interface ClaimedOccurrence {
  id: string;
  kind: ReminderKind;
  taskId: string | null;
  userId: string;
  taskVersion: number | null;
  scheduledFor: Date;
  localDate: string;
  attempts: number;
  maxAttempts: number;
  task: { status: TaskStatus; version: number; deadlineAt: Date | null; title: string; connectionId: string; conversationId: string; conversationType: "user" | "group" } | null;
  userActive: boolean;
  userMayUseModule: boolean;
  prefs: ReminderPrefs;
}

export type Decision =
  | { action: "send"; late: boolean; aggregate: boolean }
  | { action: "resolve"; status: "skipped_expired" | "skipped" | "cancelled"; reason: string };

export const ON_TIME_MS = 2 * 60_000;

export function decideDelivery(o: ClaimedOccurrence, now: Date, w: ReminderWindows, canRead: boolean): Decision {
  const lateness = now.getTime() - o.scheduledFor.getTime();
  const late = lateness > ON_TIME_MS;
  if (!o.userActive || !o.userMayUseModule) return { action: "resolve", status: "skipped", reason: "access_revoked" };

  if (o.kind === "MORNING") {
    if (vnDateKey(now) !== o.localDate || vnParts(now).hour >= w.morningCutoffHour) return { action: "resolve", status: "skipped_expired", reason: "morning_window_closed" };
    if (!o.prefs.morning_enabled) return { action: "resolve", status: "skipped", reason: "preference_off" };
    return { action: "send", late, aggregate: true };
  }

  const t = o.task;
  if (!t || (t.status !== "accepted" && t.status !== "in_progress" && t.status !== "overdue")) return { action: "resolve", status: "cancelled", reason: "task_closed" };
  if (o.taskVersion !== t.version) return { action: "resolve", status: "cancelled", reason: "superseded" };
  if (!canRead) return { action: "resolve", status: "skipped", reason: "access_revoked" };
  if (!o.prefs[KIND_PREF[o.kind]]) return { action: "resolve", status: "skipped", reason: "preference_off" };
  if (!t.deadlineAt) return { action: "resolve", status: "cancelled", reason: "superseded" };

  if (o.kind === "DAY" || o.kind === "HOUR") {
    if (now.getTime() >= t.deadlineAt.getTime()) return { action: "resolve", status: "skipped_expired", reason: "past_deadline" };
    const grace = o.kind === "DAY" ? w.dayGraceMs : w.hourGraceMs;
    if (lateness >= grace) return { action: "resolve", status: "skipped_expired", reason: "too_late" };
    return { action: "send", late, aggregate: false };
  }
  // OVERDUE: the deadline must really be past (a moved deadline bumps the version anyway)
  if (now.getTime() < t.deadlineAt.getTime()) return { action: "resolve", status: "cancelled", reason: "superseded" };
  return { action: "send", late, aggregate: lateness >= w.overdueOnTimeMs };
}

/** Exponential backoff for a retryable failure: base · 2^(attempt−1), capped at 1 h. */
export function backoffMs(attempt: number, w: ReminderWindows): number {
  return Math.min(3_600_000, w.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
}
