// ============================================================
// PHASE SHOPEE-6B: notification slot timing (pure).
//
//   generate   slot ≤ now < slot + GENERATE_GRACE_MINUTES (a missed tick —
//              e.g. a cron outage — still sends within the grace; older slots
//              are skipped, never back-filled hours later)
//   pre-sync   slot − presyncMinutes ≤ now < slot → enqueue the return /
//              return_logistics / failed_delivery jobs so the summary is fresh
// One run per (setting, business date, slot) is enforced by a DB unique key.
// ============================================================
import { toMinutes } from "./time.ts";

export const GENERATE_GRACE_MINUTES = 45;

export interface ScheduleSlot {
  id: string;
  timeOfDay: string;
  enabled: boolean;
}

/** Enabled slots whose generation window contains the local time "HH:MM[:SS]". */
export function dueSlots<T extends ScheduleSlot>(slots: readonly T[], localTime: string, graceMinutes = GENERATE_GRACE_MINUTES): T[] {
  const now = toMinutes(localTime.slice(0, 5));
  if (now === null) return [];
  return slots.filter((s) => {
    const m = toMinutes(s.timeOfDay);
    return s.enabled && m !== null && now >= m && now < m + graceMinutes;
  });
}

/** Enabled slots starting within the next presyncMinutes. */
export function presyncSlots<T extends ScheduleSlot>(slots: readonly T[], localTime: string, presyncMinutes: number): T[] {
  const now = toMinutes(localTime.slice(0, 5));
  if (now === null || presyncMinutes <= 0) return [];
  return slots.filter((s) => {
    const m = toMinutes(s.timeOfDay);
    return s.enabled && m !== null && now >= m - presyncMinutes && now < m;
  });
}

/** Normalizes "8:5" / "08:05:00" → "08:05"; null when invalid. */
export function normalizeSlot(input: string): string | null {
  const m = toMinutes(input);
  if (m === null) return null;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
