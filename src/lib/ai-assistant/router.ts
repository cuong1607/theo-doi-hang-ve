// ============================================================
// AI ASSISTANT — AIRequestRouter: decides HOW to retrieve for a question,
// deterministically (no model call: saves budget, can't be prompt-injected).
//
//   keyword  full-text search on the question's keywords + neighbours
//   recent   the latest messages of the period (chronological sample)
//   both     keyword hits first, then recent messages to fill the budget
// ============================================================
import { foldVi, keywords } from "./text.ts";

export type Intent = "summary" | "decisions" | "assignment" | "when" | "open_questions" | "search" | "general";

export interface Route {
  intent: Intent;
  keywords: string[];
  strategy: "keyword" | "recent" | "both";
}

const RULES: Array<[Intent, RegExp]> = [
  ["open_questions", /\b(chua (duoc )?(xac nhan|tra loi|chot|ro|phan hoi)|con treo|dang cho|chua giai quyet)\b/],
  ["decisions", /\b(quyet dinh|chot|thong nhat|dong y|phe duyet|duyet)\b/],
  ["assignment", /\b(ai (dang )?(phu trach|lo|nhan|lam|giu|cam)|giao cho|phan cong|dau moi)\b/],
  ["when", /\b(khi nao|bao gio|luc nao|ngay nao|lich|thoi gian|gan nhat)\b/],
  ["summary", /\b(tom tat|trao doi gi|noi gi|ban gi|co gi moi|dien ra|tong hop|diem lai)\b/],
  ["search", /\b(tim|lien quan|nhac (den|toi)|ve viec)\b/],
];

export function route(question: string): Route {
  const q = foldVi(question);
  const intent = RULES.find(([, re]) => re.test(q))?.[0] ?? "general";
  const kw = keywords(question);
  const broad = intent === "summary" || intent === "decisions" || intent === "open_questions";
  const strategy: Route["strategy"] = kw.length === 0 ? "recent" : broad ? "both" : "keyword";
  return { intent, keywords: kw, strategy };
}
