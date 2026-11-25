// ============================================================
// PHASE 06 — DeadlineResolver: Vietnamese deadline phrases → a UTC instant.
// Pure and deterministic. The anchor is ALWAYS the source message's own time
// (never "now"), in Asia/Ho_Chi_Minh.
//
//   "17h hôm nay", "trước 17h", "5 giờ chiều mai"   → exact
//   "chiều mai", "sáng thứ Hai"                     → day_part (hour ASSUMED: sáng 11:00,
//                                                     trưa 12:00, chiều 17:00, tối 21:00, đêm 23:00)
//   "mai", "thứ Sáu", "ngày 28", "28/11"             → date (23:59 ASSUMED)
//   "trước thứ Sáu", "trước ngày 28"                 → the previous day 23:59 (ASSUMED reading)
//   "trong tuần này", "cuối tuần", "cuối tháng",
//   "tuần sau"                                       → range (end of the range, ASSUMED)
//   "2 tiếng nữa", "30 phút nữa"                     → exact
//
// Anything assumed (an hour, a day, a reading of "trước") is flagged and must be
// confirmed by a person: the resolver never silently invents a precise time.
// Ambiguous words ("này" = this, "tới" = next, "sang" = over) only count as time
// words next to an unambiguous one.
// ============================================================
import { foldVi } from "../ai-assistant/text.ts";
import { DAY_MS, daysInMonth, vnParts, vnTime } from "./time.ts";

export type DeadlinePrecision = "exact" | "day_part" | "date" | "range";

export interface DeadlineResolution {
  at: Date;
  precision: DeadlinePrecision;
  /** an hour / a day / a reading was picked by the resolver */
  assumed: boolean;
  needsConfirmation: boolean;
  /** verbatim excerpt of the source text */
  phrase: string;
  /** Vietnamese explanation of the assumption (null when nothing was assumed) */
  assumption: string | null;
}

type DayPart = "sang" | "trua" | "chieu" | "toi" | "dem";
const DAY_PART_HOUR: Record<DayPart, number> = { sang: 11, trua: 12, chieu: 17, toi: 21, dem: 23 };
const DAY_PART_LABEL: Record<DayPart, string> = { sang: "sáng", trua: "trưa", chieu: "chiều", toi: "tối", dem: "đêm" };

const WEEKDAY: Record<string, number> = { "2": 1, hai: 1, "3": 2, ba: 2, "4": 3, tu: 3, "5": 4, nam: 4, "6": 5, sau: 5, "7": 6, bay: 6 };

interface Span {
  start: number;
  end: number;
}
interface DayRef extends Span {
  /** VN calendar date */
  y: number;
  m: number;
  d: number;
  range?: boolean;
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function findDay(f: string, anchor: Date): DayRef | null {
  const a = vnParts(anchor);
  const today = { y: a.year, m: a.month, d: a.day };
  const candidates: DayRef[] = [];
  const push = (m: RegExpExecArray, day: { y: number; m: number; d: number }, label: string, range = false) =>
    candidates.push({ start: m.index, end: m.index + m[0].length, ...day, label, range });

  let m: RegExpExecArray | null;
  // explicit dates first: 28/11, 28-11-2026
  const reDate = /(?<![\d/])(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{4}|\d{2}))?(?![\d/])/g;
  while ((m = reDate.exec(f))) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : a.year;
    if (mo < 1 || mo > 12 || d < 1) continue;
    if (!m[3] && (mo < a.month || (mo === a.month && d < a.day))) y += 1; // "28/1" said in November = next January
    if (d > daysInMonth(y, mo)) continue;
    push(m, { y, m: mo, d }, `${pad(d)}/${pad(mo)}/${y}`);
  }
  // "ngày 28", "ngày 28 tháng 11"
  const reNgay = /\bngay\s+(\d{1,2})(?:\s+thang\s+(\d{1,2}))?\b/g;
  while ((m = reNgay.exec(f))) {
    const d = Number(m[1]);
    let mo = m[2] ? Number(m[2]) : a.month;
    let y = a.year;
    if (mo < 1 || mo > 12 || d < 1) continue;
    if (!m[2] && d < a.day) mo += 1; // the 28th already passed this month → next month
    if (mo > 12) {
      mo = 1;
      y += 1;
    } else if (m[2] && (mo < a.month || (mo === a.month && d < a.day))) y += 1;
    if (d > daysInMonth(y, mo)) continue;
    push(m, { y, m: mo, d }, `ngày ${pad(d)}/${pad(mo)}/${y}`);
  }
  // weekdays, optionally "tuần sau / tuần tới"
  const reWeek = /\b(?:(tuan sau|tuan toi)\s+)?(?:thu\s*(2|3|4|5|6|7|hai|ba|tu|nam|sau|bay)\b|(chu nhat|cn)\b)(?:\s+(tuan sau|tuan toi)\b)?/g;
  while ((m = reWeek.exec(f))) {
    const target = m[3] ? 0 : WEEKDAY[m[2]!]!;
    const nextWeek = Boolean(m[1] || m[4]);
    let delta: number;
    if (nextWeek) {
      const toMonday = (1 - a.weekday + 7) % 7 || 7;
      delta = toMonday + ((target + 6) % 7);
    } else delta = (target - a.weekday + 7) % 7;
    const label = m[3] ? "Chủ nhật" : `thứ ${["", "Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy"][target]}`;
    push(m, addDays(today.y, today.m, today.d, delta), nextWeek ? `${label} tuần sau` : label);
  }
  // today / tomorrow / the day after
  const reRel = /\b(hom nay|ngay mai|ngay kia|ngay mot|(?<!\b(?:chi|co|ba|be|ten) )mai)\b/g;
  while ((m = reRel.exec(f))) {
    const w = m[1]!;
    const n = w === "hom nay" ? 0 : w === "ngay kia" || w === "ngay mot" ? 2 : 1;
    push(m, addDays(today.y, today.m, today.d, n), n === 0 ? "hôm nay" : n === 1 ? "ngày mai" : "ngày kia");
  }
  // "<part> nay" = today ("chiều nay", "tối nay")
  const rePartToday = /\b(?:sang|trua|chieu|toi|dem)\s+nay\b/g;
  while ((m = rePartToday.exec(f))) push(m, today, "hôm nay");
  // ranges
  const reRange = /\b(?:(trong\s+)?tuan nay|cuoi tuan( nay)?|cuoi thang( nay)?|(?<!thu \S{1,3} )(?:tuan sau|tuan toi))\b/g;
  while ((m = reRange.exec(f))) {
    const w = m[0];
    if (w.includes("thang")) {
      push(m, { y: today.y, m: today.m, d: daysInMonth(today.y, today.m) }, "cuối tháng", true);
    } else if (w.includes("sau") || w.includes("toi")) {
      const toSunday = (7 - a.weekday) % 7;
      push(m, addDays(today.y, today.m, today.d, toSunday + 7), "hết tuần sau", true);
    } else {
      push(m, addDays(today.y, today.m, today.d, (7 - a.weekday) % 7), w.includes("cuoi") ? "cuối tuần" : "hết tuần này", true);
    }
  }
  if (!candidates.length) return null;
  // the earliest mention wins; at equal position the longer (more specific) one
  candidates.sort((x, y) => x.start - y.start || y.end - y.start - (x.end - x.start));
  return candidates[0]!;
}

interface TimeRef extends Span {
  hour: number;
  minute: number;
  part: DayPart | null;
}

function findTime(f: string): TimeRef | null {
  const re = /\b(?:luc\s+)?(\d{1,2})\s?(?:h|g|gio|:)(?:\s?(\d{2})(?:\s?(?:phut|p)\b)?)?(?:\s+(sang|trua|chieu|toi|dem)\b)?(?![\d:])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(f))) {
    // "2 giờ nữa" is a duration, handled elsewhere
    if (/^\s*(nua|toi)\b/.test(f.slice(m.index + m[0].length)) && !m[3]) continue;
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const part = (m[3] as DayPart | undefined) ?? null;
    if (hour > 23 || minute > 59) continue;
    if (part && (part === "chieu" || part === "toi" || part === "dem") && hour < 12) hour += 12;
    if (part === "trua" && hour <= 2) hour += 12;
    if (hour === 24) hour = 23;
    return { start: m.index, end: m.index + m[0].length, hour, minute, part };
  }
  return null;
}

function findDayPart(f: string): (Span & { part: DayPart }) | null {
  // "sang", "toi" are ambiguous alone ("chuyển sang", "tôi", "tới"): only next to a day word
  const re = /\b(sang|trua|chieu|toi|dem)\s+(?=(?:nay|mai|ngay|hom|thu|chu nhat|cn)\b)|\b(chieu|trua)\b/g;
  const m = re.exec(f);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].trimEnd().length, part: (m[1] ?? m[2]) as DayPart };
}

function findRelative(f: string, anchor: Date): (Span & { at: Date; label: string }) | null {
  // "tới" and "tối" fold to the same "toi": "8h tối" is 20:00, never "in 8 hours" — only
  // "phút / tiếng … nữa|tới" and "giờ … nữa" are durations
  const m = /\b(\d{1,3})\s*(?:(phut|tieng)\s*(?:nua|toi)|(gio|h)\s*nua)\b/.exec(f);
  if (!m) return null;
  const n = Number(m[1]);
  const unitMs = m[2] === "phut" ? 60_000 : 3_600_000; // tieng / gio / h
  if (n < 1 || n * unitMs > 30 * DAY_MS) return null;
  return { start: m.index, end: m.index + m[0].length, at: new Date(anchor.getTime() + n * unitMs), label: m[0] };
}

const before = (f: string, start: number) => /\btruoc\s*$/.test(f.slice(Math.max(0, start - 8), start));

function excerpt(text: string, spans: Span[], withBefore: boolean, f: string): string {
  let start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  if (withBefore) {
    const i = f.lastIndexOf("truoc", start);
    if (i >= 0 && start - i <= 8) start = i;
  }
  return text.slice(start, end).trim().slice(0, 120);
}

/**
 * Resolves the first deadline expression of `text`, relative to `anchor` (the
 * message time). null = no deadline found (never a guess).
 */
export function resolveDeadline(rawText: string, anchor: Date): DeadlineResolution | null {
  const text = rawText.normalize("NFC");
  const f = foldVi(text);
  if (f.length !== text.length) return null; // could not align the excerpt safely

  const rel = findRelative(f, anchor);
  if (rel) return { at: rel.at, precision: "exact", assumed: false, needsConfirmation: false, phrase: excerpt(text, [rel], false, f), assumption: null };

  const day = findDay(f, anchor);
  const time = findTime(f);
  const part = time?.part ? null : findDayPart(f);
  // a time far away from the day reference belongs to something else
  const near = (a: Span | null, b: Span | null) => !a || !b || Math.abs(a.start - b.start) <= 30;
  const t = time && near(time, day) ? time : null;
  const p = part && near(part, day) ? part : null;
  if (!day && !t && !p) return null;

  if (day?.range) {
    const at = vnTime(day.y, day.m, day.d, 23, 59);
    return { at, precision: "range", assumed: true, needsConfirmation: true, phrase: excerpt(text, [day], false, f), assumption: `Hạn mơ hồ: hiểu là ${day.label} (23:59 ${pad(day.d)}/${pad(day.m)}). Cần xác nhận.` };
  }

  const spans = [day, t, p].filter(Boolean) as Span[];
  const first = spans.reduce((x, y) => (y.start < x.start ? y : x));
  const isBefore = before(f, first.start);
  const phrase = excerpt(text, spans, isBefore, f);

  if (t) {
    const hourPart = t.part ?? p?.part ?? null;
    let hour = t.hour;
    if (!t.part && hourPart && (hourPart === "chieu" || hourPart === "toi" || hourPart === "dem") && hour < 12) hour += 12;
    if (day) {
      return { at: vnTime(day.y, day.m, day.d, hour, t.minute), precision: "exact", assumed: false, needsConfirmation: false, phrase, assumption: null };
    }
    const a = vnParts(anchor);
    let at = vnTime(a.year, a.month, a.day, hour, t.minute);
    if (at.getTime() <= anchor.getTime()) {
      at = new Date(at.getTime() + DAY_MS);
      return { at, precision: "exact", assumed: true, needsConfirmation: true, phrase, assumption: `Giờ ${pad(hour)}:${pad(t.minute)} hôm nay đã qua lúc nhắn: giả định là ngày hôm sau. Cần xác nhận.` };
    }
    return { at, precision: "exact", assumed: false, needsConfirmation: false, phrase, assumption: null };
  }

  const a = vnParts(anchor);
  const d = day ?? { y: a.year, m: a.month, d: a.day, label: "hôm nay", start: 0, end: 0 };
  if (p) {
    const hour = DAY_PART_HOUR[p.part];
    let at = vnTime(d.y, d.m, d.d, hour, 0);
    if (isBefore) at = vnTime(d.y, d.m, d.d, hour - (p.part === "chieu" ? 4 : 1), 0);
    return {
      at,
      precision: "day_part",
      assumed: true,
      needsConfirmation: true,
      phrase,
      assumption: `Không có giờ cụ thể: giả định ${isBefore ? "trước " : ""}${DAY_PART_LABEL[p.part]} ${d.label} = ${pad(vnParts(at).hour)}:00. Cần xác nhận.`,
    };
  }
  if (isBefore) {
    const prev = addDays(d.y, d.m, d.d, -1);
    return { at: vnTime(prev.y, prev.m, prev.d, 23, 59), precision: "date", assumed: true, needsConfirmation: true, phrase, assumption: `"Trước ${d.label}": hiểu là hết ngày ${pad(prev.d)}/${pad(prev.m)} (23:59). Cần xác nhận.` };
  }
  return { at: vnTime(d.y, d.m, d.d, 23, 59), precision: "date", assumed: true, needsConfirmation: true, phrase, assumption: `Chỉ có ngày (${d.label}): giả định hết ngày ${pad(d.d)}/${pad(d.m)} (23:59). Cần xác nhận.` };
}
