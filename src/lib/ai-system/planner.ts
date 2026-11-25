// ============================================================
// PHASE 05 — deterministic planner (no model): used when the model may not be
// called (AI off, data policy, budget) and as the fallback when the model's
// plan is unusable. Also the first guard for EVERY question: change requests
// and topics the data can't answer are recognised here before any model call.
// Pure.
// ============================================================
import { periodFromQuestion } from "../ai-assistant/time-range.ts";
import { foldVi } from "../ai-assistant/text.ts";
import type { PeriodArg } from "./tools/common.ts";

export interface PlannedCall {
  tool: string;
  args: Record<string, unknown>;
}

export type UnsupportedTopic = "expected_arrival" | "overdue_payables" | "order_list" | "inventory";

export type Plan =
  | { kind: "call"; calls: PlannedCall[] }
  | { kind: "refuse_change" }
  | { kind: "unsupported"; topic: UnsupportedTopic | null; message: string }
  | { kind: "clarify"; message: string };

/**
 * A request to CHANGE something (Phase 05 is read only). Folded text loses the
 * accents, so short verbs (tắt / tất, bật / bất) only count right before an
 * Ads object; the other verbs need a business object within a few words.
 */
export const CHANGE_REQUEST = new RegExp(
  [
    String.raw`\b(tao|them|sua|xoa|huy|cap nhat|duyet|phe duyet|chuyen tien|gui tin|nhan tin cho|dat hang|ghi nhan|lap)\b.{0,30}\b(hoa don|phieu|cong no|khoan thanh toan|don hang|chien dich|ngan sach|gia ban|gia thau|ton kho|tin nhan|quyen|tai khoan|san pham)\b`,
    String.raw`\b(tat|bat|dung|tam dung|tang|giam|chinh|doi|sua)\s+(chien dich|quang cao|ngan sach|gia thau|bid|budget|ads|gia ban)\b`,
    String.raw`\b(thanh toan|tra tien|tra no)\s+(ngay\s+)?(cho\s+)?(hoa don|ncc|nha cung cap)\b`,
  ].join("|"),
);

/** "Hiện còn nợ…", "đã thanh toán bao nhiêu" must NOT look like change requests. */
const QUESTION_CUE = /\b(bao nhieu|the nao|ra sao|nhung gi|nao|chua|khong|gi|may|la gi|tinh)\b|\?/;

export const UNSUPPORTED_TEXT: Record<UnsupportedTopic, string> = {
  expected_arrival: "Hệ thống chưa lưu ngày dự kiến hàng về hay trạng thái vận chuyển, nên mình không xác định được lô nào sắp về hoặc đang chậm. Mình có thể cho bạn xem hàng đã nhận và hàng còn phải về theo hóa đơn.",
  overdue_payables: "Hệ thống chưa lưu hạn thanh toán, nên mình không xác định được công nợ quá hạn. Mình có thể liệt kê hóa đơn chưa trả xong, cũ nhất trước, kèm số ngày từ ngày hóa đơn.",
  order_list: "Danh sách đơn hàng Shopee chi tiết không còn được đồng bộ (module cũ đã ngừng). Mình có thể cho bạn số đơn, doanh số và sản phẩm bán chạy theo kỳ.",
  inventory: "Số tồn kho trong sổ giá vốn chưa được xác minh là chính xác (sổ không còn được trừ theo đơn bán), nên trợ lý chưa trả lời tồn kho.",
};

export const HELP_TEXT =
  "Mình trả lời được (chỉ đọc, theo quyền của bạn): hàng đã về, hàng còn phải về theo hóa đơn / NCC, công nợ NCC, hóa đơn chưa trả, thanh toán đã chi, doanh số / sản phẩm bán chạy / quảng cáo Shopee. Ví dụ: “Hôm nay hàng về những gì?”, “Còn nợ NCC bao nhiêu?”, “Hôm nay doanh thu Shopee thế nào?”.";

/** The question's period as a tool argument (server clock, VN time), or undefined = the tool's default. */
export function periodArgFromQuestion(question: string, now: Date): PeriodArg | undefined {
  const p = periodFromQuestion(question, now);
  if (!p) return undefined;
  if (p.preset === "custom") return { preset: "custom", from: p.fromDate, to: p.toDate };
  return { preset: p.preset };
}

function unsupportedTopic(q: string): UnsupportedTopic | null {
  if (/\b(sap ve|sap toi|du kien|bao gio (hang )?ve|khi nao (hang )?ve|bao gio giao|dang cham|bi cham|giao cham|ve cham|tre hen|dang van chuyen|dang tren duong)\b/.test(q)) return "expected_arrival";
  if (/\b(qua han|den han|tre han|han thanh toan|han tra)\b/.test(q)) return "overdue_payables";
  if (/\b(danh sach don|ma don|don nao|chi tiet don|tung don)\b/.test(q)) return "order_list";
  if (/\b(ton kho|con trong kho|hang ton|so luong ton)\b/.test(q)) return "inventory";
  return null;
}

const KNOWLEDGE_RULES: Array<[RegExp, string]> = [
  [/\b(roas|acos|cpc|ctr)\b/, "roas_acos_cpc"],
  [/\b(broad|direct)\b/, "quang_cao_broad_direct"],
  [/\b(doanh so|doanh thu|gmv)\b/, "doanh_so_shopee"],
  [/\b(con phai ve|con thieu|xuat bu|sap het)\b/, "hang_con_phai_ve"],
  [/\b(cong no|thanh toan mot phan)\b/, "cong_no_ncc"],
  [/\b(phieu nhan|phieu nhap|chenh lech)\b/, "phieu_nhan_hang"],
];

export function rulesPlan(question: string, now: Date): Plan {
  const q = foldVi(question).replace(/\s+/g, " ").trim();
  if (!q) return { kind: "clarify", message: HELP_TEXT };
  if (CHANGE_REQUEST.test(q) && !QUESTION_CUE.test(q.replace(/\b(cho toi|giup toi|giup minh)\b/g, ""))) return { kind: "refuse_change" };
  if (/\b(huong dan|giup gi|lam duoc gi|hoi gi|tro giup|help)\b/.test(q)) return { kind: "call", calls: [{ tool: "explain_business_term", args: { term: "tro_ly_lam_duoc_gi" } }] };
  if (/\b(la gi|nghia la|dinh nghia|tinh the nao|tinh nhu the nao|cach tinh|khac gi)\b/.test(q)) {
    const term = KNOWLEDGE_RULES.find(([re]) => re.test(q))?.[1];
    if (term) return { kind: "call", calls: [{ tool: "explain_business_term", args: { term } }] };
  }
  const topic = unsupportedTopic(q);
  if (topic) return { kind: "unsupported", topic, message: UNSUPPORTED_TEXT[topic] };

  const period = periodArgFromQuestion(question, now);
  const withPeriod = (args: Record<string, unknown> = {}) => (period ? { ...args, period } : args);
  const calls: PlannedCall[] = [];
  const add = (tool: string, args: Record<string, unknown>) => {
    if (!calls.some((c) => c.tool === tool)) calls.push({ tool, args });
  };
  if (/\b(cong no|no ncc|con no|dang no|phai tra|no nha cung cap|no bao nhieu)\b/.test(q)) add("get_supplier_payables", {});
  if (/\bhoa don\b/.test(q) && !/\b(con phai ve|nhan du|da nhan|giao du)\b/.test(q)) add("get_invoices", withPeriod({}));
  if (/\b(da thanh toan|da tra|chi tra|thanh toan cho|lan thanh toan|tra ncc|tra cho ncc)\b/.test(q)) add("get_payment_summary", withPeriod({}));
  if (/\b(con phai ve|con thieu|chua ve|chua giao|chua nhan|chua giao du|nhan du|da du chua|giao du chua|xuat bu|nhan thua|giao thua)\b/.test(q)) add("get_outstanding_goods", /\b(xuat bu|nhan thua|giao thua)\b/.test(q) ? { view: "over_received" } : {}); // "nhận dư" folds like "nhận đủ": only unambiguous words
  if (/\b(hang ve|nhap hang|nhan hang|phieu nhan|phieu nhap|giao hang|da giao|ve nhung gi)\b/.test(q) && !calls.some((c) => c.tool === "get_outstanding_goods")) add("get_receiving_status", withPeriod({}));
  if (/\b(quang cao|ads|roas|acos|cpc|ctr|chien dich)\b/.test(q)) add("get_shopee_ads_performance", withPeriod({}));
  if (/\b(ban chay|chay nhat|top|nhieu don nhat|ban nhieu nhat|san pham nao ban)\b/.test(q)) add("get_top_selling_products", withPeriod({}));
  if (/\b(doanh thu|doanh so|gmv|ban duoc|bao nhieu don)\b/.test(q) && !calls.some((c) => c.tool === "get_top_selling_products")) add("get_shopee_revenue", withPeriod({}));
  if (!calls.length && /\b(shopee|shop|san|tinh hinh ban)\b/.test(q)) add("get_shopee_overview", withPeriod({}));
  if (!calls.length) return { kind: "clarify", message: `Mình chưa hiểu bạn muốn xem dữ liệu nào. ${HELP_TEXT}` };
  return { kind: "call", calls: calls.slice(0, 3) };
}
