// ============================================================
// PHASE 05 — Business knowledge (SYS-05): curated definitions, NO live data.
//
// Kept apart from live business data (the other tools) and from conversation
// memory (Phase 04). Every definition below is copied from the system's own
// sources (SQL view comments, KPI hints, metric meta) — when those change,
// change them here. No source code, no secrets, no figures.
// ============================================================
import { z } from "zod";

import { STATUS_LABELS } from "../../outstanding/status.ts";
import { PAYMENT_STATUS_LABELS } from "../../debt/status.ts";
import { PRODUCT_METRIC_META } from "../../product-analytics/data-quality.ts";
import type { SystemToolDefinition } from "../types.ts";
import { done } from "./common.ts";

export const KNOWLEDGE: Record<string, { title: string; text: string; source: string }> = {
  doanh_so_shopee: {
    title: "Doanh số Shopee (GMV)",
    text: `${PRODUCT_METRIC_META.sales_gmv!.note} Số đơn: ${PRODUCT_METRIC_META.orders!.note} Shop chưa có dữ liệu không bị tính là 0; kỳ chưa đồng bộ đủ là "mức tối thiểu".`,
    source: "Phân tích sản phẩm Shopee (PRODUCT_METRIC_META)",
  },
  quang_cao_broad_direct: {
    title: "Quảng cáo: Broad và Direct",
    text: "Doanh số / đơn Broad và Direct là số Shopee Ads quy cho quảng cáo theo cửa sổ quy đổi của Shopee (Direct luôn ≤ Broad). Đó KHÔNG phải doanh thu của shop; lấy tổng trừ Ads cũng không ra doanh số tự nhiên.",
    source: "Quảng cáo Shopee (ADS_METRIC_DEFS)",
  },
  roas_acos_cpc: {
    title: "ROAS, ACOS, CTR, CPC",
    text: "ROAS = Doanh số Broad / Chi tiêu Ads; ACOS = Chi tiêu Ads / Doanh số Broad; CTR = Lượt nhấp / Lượt hiển thị; CPC = Chi tiêu Ads / Lượt nhấp. Tỷ lệ luôn tính trên TỔNG của kỳ, không lấy trung bình các ngày.",
    source: "Quảng cáo Shopee (deriveMetrics)",
  },
  phieu_nhan_hang: {
    title: "Phiếu nhận hàng (hàng về)",
    text: "Mỗi phiếu ghi hàng nhà cung cấp giao trong một ca (sáng / chiều): số lượng giao, số lượng thực nhận, chênh lệch = nhận − giao, giá trị = số nhận × đơn giá. Hàng chỉ được coi là đã về khi có phiếu; hệ thống không tự suy ra hàng đã về theo ngày.",
    source: "Bảng receipts / receipt_items",
  },
  hang_con_phai_ve: {
    title: "Hàng còn phải về",
    text: `Theo từng dòng hóa đơn: còn phải về = số lượng trên hóa đơn − số lượng đã nhận theo phiếu. Trạng thái: còn < 0 → "${STATUS_LABELS.need_makeup}", = 0 → "${STATUS_LABELS.complete}", dưới 15 → "${STATUS_LABELS.low}", từ 15 → "${STATUS_LABELS.normal}". Giá trị đã phân bổ VAT (công ty) / chiết khấu (hộ kinh doanh) theo hóa đơn.`,
    source: "View v_outstanding (migration 00034)",
  },
  cong_no_ncc: {
    title: "Công nợ nhà cung cấp",
    text: `Công nợ của một hóa đơn = tổng phải trả (sau chiết khấu / VAT) − tổng đã thanh toán cho hóa đơn đó. Trạng thái: "${PAYMENT_STATUS_LABELS.unpaid}", "${PAYMENT_STATUS_LABELS.partial}", "${PAYMENT_STATUS_LABELS.paid}". Công nợ NCC = tổng các hóa đơn của NCC. Mọi số tính trong SQL, trợ lý không tính lại.`,
    source: "View v_invoice_debt / v_supplier_debt_summary (migration 00017)",
  },
  du_lieu_chua_co: {
    title: "Những gì hệ thống chưa lưu",
    text: "Hệ thống chưa lưu: ngày dự kiến hàng về hay trạng thái vận chuyển (nên không biết lô nào sắp về / đang chậm), hạn thanh toán hóa đơn (nên không có công nợ quá hạn), danh sách đơn hàng Shopee chi tiết (module cũ đã ngừng đồng bộ). Trợ lý sẽ nói rõ khi câu hỏi cần những dữ liệu này.",
    source: "Kiểm tra schema Phase 05",
  },
  tro_ly_lam_duoc_gi: {
    title: "Trợ lý hệ thống làm được gì",
    text: "Chỉ ĐỌC dữ liệu theo quyền của bạn: hàng đã về, hàng còn phải về, công nợ / hóa đơn / thanh toán NCC, doanh số / sản phẩm bán chạy / quảng cáo Shopee (shop được cấp quyền). Không tạo, sửa, xóa hay thanh toán gì; không gửi tin nhắn; không trả lời số liệu nội bộ trong nhóm nhiều người.",
    source: "Phase 05",
  },
};

const TERMS = Object.keys(KNOWLEDGE) as [string, ...string[]];

const knowledgeArgs = z.object({ term: z.enum(TERMS).describe(`Một trong: ${TERMS.join(", ")}`) }).strict();

export const explainBusinessTerm: SystemToolDefinition<z.infer<typeof knowledgeArgs>> = {
  name: "explain_business_term",
  title: "Giải thích khái niệm",
  description: `Định nghĩa một khái niệm / chỉ số của hệ thống (không có số liệu): ${TERMS.map((t) => `${t} (${KNOWLEDGE[t]!.title})`).join("; ")}.`,
  module: "knowledge",
  sensitivity: "knowledge",
  requiredPermissions: [],
  input: knowledgeArgs,
  timeoutMs: 1_000,
  maxRows: 1,
  freshness: "Tài liệu nội bộ, không phải dữ liệu thời gian thực.",
  examples: ["ROAS là gì?", "Hàng còn phải về tính thế nào?"],
  async run(args, ctx) {
    const k = KNOWLEDGE[args.term]!;
    return done({
      data: { term: k.title, definition: k.text },
      lines: [`${k.title}: ${k.text}`],
      source: { label: `Kiến thức: ${k.title}`, origin: k.source, href: null, readAt: ctx.now.toISOString(), dataUpdatedAt: null, freshness: "unknown", coverage: "Định nghĩa, không phải số liệu" },
      rowCount: 1,
      scope: { term: args.term },
    });
  },
};

export const KNOWLEDGE_TOOLS = [explainBusinessTerm] as const;
