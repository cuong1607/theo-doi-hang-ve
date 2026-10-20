// ============================================================
// PHASE SHOPEE-6B: delivery windows ("ca giao") — configurable, never
// hard-coded morning/afternoon. Source of truth = start_time / end_time.
//
// Which window SET applies to (shop, carrier) — most specific wins:
//   1. shop + carrier      2. any shop + carrier
//   3. shop default        4. global default (no shop, no carrier)
// Only enabled windows count; a scope with no enabled window is skipped.
//
// Membership: the LOCAL minute of delivered_to_seller_at (business tz) is in
// [start_time, end_time], both inclusive at minute precision
// ("08:00–11:59" = 08:00:00 … 11:59:59). Overlapping windows are rejected on
// save; should they exist anyway the first by sort_order wins — an operation
// is never counted twice. No match → "Khác / Ngoài ca" (never dropped).
//
// SQL mirror: public.return_assign_window() (00060) — parity test.
// Pure: no I/O.
// ============================================================
import { toMinutes } from "./time.ts";

export interface DeliveryWindow {
  id: string;
  shopId: string | null;
  carrier: string | null;
  name: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  sortOrder: number;
  enabled: boolean;
}

export const OUTSIDE_WINDOW_ID = "outside";
export const OUTSIDE_WINDOW_LABEL = "Khác / Ngoài ca";

export const normalizeCarrier = (c: string | null | undefined) => (c ?? "").trim().toLowerCase();

function scopeRank(w: DeliveryWindow, shopId: string | null, carrier: string | null): number {
  const shopMatch = w.shopId === null || w.shopId === shopId;
  const carrierMatch = w.carrier === null || (carrier !== null && normalizeCarrier(w.carrier) === normalizeCarrier(carrier));
  if (!shopMatch || !carrierMatch) return 0;
  if (w.shopId !== null && w.carrier !== null) return 4;
  if (w.carrier !== null) return 3;
  if (w.shopId !== null) return 2;
  return 1;
}

/** The enabled windows that apply to (shop, carrier), ordered by sort_order then start. */
export function resolveWindowSet(all: readonly DeliveryWindow[], shopId: string | null, carrier: string | null): DeliveryWindow[] {
  let best = 0;
  for (const w of all) if (w.enabled) best = Math.max(best, scopeRank(w, shopId, carrier));
  if (best === 0) return [];
  // the winning scope = the (shop, carrier) pair of the best-ranked windows
  const winner = all.find((w) => w.enabled && scopeRank(w, shopId, carrier) === best)!;
  return all
    .filter((w) => w.enabled && w.shopId === winner.shopId && normalizeCarrier(w.carrier) === normalizeCarrier(winner.carrier) && (w.carrier === null) === (winner.carrier === null))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.startTime.localeCompare(b.startTime));
}

/** Window of a local time ("HH:MM[:SS]") inside a resolved set, or null (= outside). */
export function assignWindow(set: readonly DeliveryWindow[], localTime: string): DeliveryWindow | null {
  const minute = toMinutes(localTime.slice(0, 5));
  if (minute === null) return null;
  for (const w of set) {
    const s = toMinutes(w.startTime);
    const e = toMinutes(w.endTime);
    if (s !== null && e !== null && minute >= s && minute <= e) return w;
  }
  return null;
}

export interface WindowInput {
  name: string;
  startTime: string;
  endTime: string;
  enabled: boolean;
}

/** Validation of one scope's windows before saving. Returns Vietnamese error messages (empty = valid). */
export function validateWindowSet(windows: readonly WindowInput[]): string[] {
  const errors: string[] = [];
  const parsed: Array<{ name: string; s: number; e: number }> = [];
  for (const w of windows) {
    const name = w.name.trim();
    if (!name) errors.push("Tên ca không được để trống.");
    const s = toMinutes(w.startTime);
    const e = toMinutes(w.endTime);
    if (s === null || e === null) {
      errors.push(`Ca "${name || "?"}": giờ không hợp lệ (HH:MM).`);
      continue;
    }
    if (e < s) errors.push(`Ca "${name}": giờ kết thúc phải sau giờ bắt đầu (ca qua nửa đêm chưa hỗ trợ).`);
    if (w.enabled) parsed.push({ name, s, e });
  }
  parsed.sort((a, b) => a.s - b.s);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].s <= parsed[i - 1].e) errors.push(`Ca "${parsed[i - 1].name}" và "${parsed[i].name}" bị chồng giờ.`);
  }
  return errors;
}
