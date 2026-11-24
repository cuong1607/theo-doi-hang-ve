// ============================================================
// AI ASSISTANT — Vietnamese text helpers (pure).
//
// foldVi() MUST give the same result as the SQL function public.zp_fold()
// (migration 00075) — both lower-case, drop combining marks (NFD input) and
// map precomposed Vietnamese letters to ASCII, đ → d. A unit test pins the
// mapping; the integration test checks TS and SQL agree.
// ============================================================

const FROM = "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ";
const TO = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd";
const MAP = new Map([...FROM].map((c, i) => [c, TO[i]!]));

/** The exact character tables used by public.zp_fold() — exported for the SQL / TS parity test. */
export const FOLD_TABLE = { from: FROM, to: TO };

export function foldVi(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase().replace(/[̀-ͯ]/g, "")) out += MAP.get(ch) ?? ch;
  return out;
}

/**
 * Words that carry no search meaning in questions (folded). Includes time words:
 * the period is resolved separately (time-range.ts) and must not become a keyword.
 */
const STOP = new Set(
  (
    "a ai anh ban bao bay be cac cach cai cam can cho chi chua chung co con cua cung da dang day de den deu di do doan dong du duoc gi gio gium giup ha hay he het hoi hom khi khong la lai lam lan len luc ma may minh moi mot muon nao nay neu ngay nghe nguoi nhe nhieu nhom nho nhung noi nua o oi ong qua ra rang rat roi sao se sau si so ta tai tam tat theo thi thoi tim toi tom trong tren truoc tu tuan va vao ve vi voi vua xem xin yeu " +
    "nao chua trao doi noi dung tin nhan cuoc hoi thoai tom tat liet ke cho biet the nhu nao gan nhat hom qua hom nay tuan nay tuan truoc thang nay thang truoc nam nay quyet dinh xac nhan phu trach lich giao hang"
  ).split(/\s+/),
);

/** Tokens a question is searched with: folded, alnum, ≥ 2 chars, no stop words, ≤ 8 tokens. */
export function keywords(question: string): string[] {
  const out: string[] = [];
  for (const raw of foldVi(question).split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d{1,2}$/.test(raw) || out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= 8) break;
  }
  return out;
}

/** Same rules, but for a topic the user typed on purpose (no stop-word removal except fillers). */
export function topicKeywords(topic: string): string[] {
  return [...new Set(foldVi(topic).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 8);
}
