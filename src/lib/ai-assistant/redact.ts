// ============================================================
// AI ASSISTANT — masks sensitive values BEFORE anything is sent to a provider
// (AI_DATA_SHARING_POLICY=redacted). Pure and conservative: when in doubt, mask.
//
//   email            → [email]
//   URL              → [liên kết: domain]
//   phone (VN)       → [SĐT]
//   long digit runs  → [số dài]     (bank / ID / card numbers ≥ 9 digits)
//   link / OTP codes → [mã]         ("mã xác nhận 123456", "OTP 1234", "LINK ABCD1234");
//                                   a bare "mã SP001" (product / order code) is KEPT
//   secrets          → [bí mật]     ("password: …", "mật khẩu …", "token …")
//
// Amounts of money are KEPT (they are what business questions are about); the
// owner can choose "none" to send nothing at all. Counts are returned for audit
// (never the values).
// ============================================================

export interface RedactionStats {
  email: number;
  url: number;
  phone: number;
  number: number;
  code: number;
  secret: number;
}

const RULES: Array<{ key: keyof RedactionStats; re: RegExp; to: (m: string, ...g: string[]) => string }> = [
  { key: "secret", re: /(?<![\p{L}\d])(mat khau|mật khẩu|password|passwd|pass|token|api[ _-]?key|secret)(?![\p{L}\d])\s*[:=]?\s*\S+/giu, to: (_m, k) => `${k} [bí mật]` },
  { key: "code", re: /(?<![\p{L}\d])(LINK|link|OTP|otp|[Mm]ã xác (?:nhận|thực)|[Mm]ã OTP|[Cc]ode)\s*[:#]?\s*([A-Za-z0-9]{4,10})(?![\p{L}\d])/gu, to: (_m, k) => `${k} [mã]` },
  { key: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, to: () => "[email]" },
  {
    key: "url",
    re: /\bhttps?:\/\/([^\s/?#]+)[^\s]*/giu,
    to: (_m, host) => `[liên kết: ${host.replace(/^www\./, "")}]`,
  },
  { key: "phone", re: /(?<![\d])(?:\+?84|0)(?:[\s.-]?\d){8,10}(?![\d])/gu, to: () => "[SĐT]" },
  { key: "number", re: /(?<![\d.,])\d(?:[\s-]?\d){8,}(?![\d])/gu, to: () => "[số dài]" },
];

export function redact(text: string): { text: string; stats: RedactionStats } {
  const stats: RedactionStats = { email: 0, url: 0, phone: 0, number: 0, code: 0, secret: 0 };
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...args: string[]) => {
      stats[r.key]++;
      return r.to(...(args as [string, ...string[]]));
    });
  }
  return { text: out, stats };
}

export const emptyStats = (): RedactionStats => ({ email: 0, url: 0, phone: 0, number: 0, code: 0, secret: 0 });

export function addStats(a: RedactionStats, b: RedactionStats): RedactionStats {
  return { email: a.email + b.email, url: a.url + b.url, phone: a.phone + b.phone, number: a.number + b.number, code: a.code + b.code, secret: a.secret + b.secret };
}
