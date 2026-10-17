// ============================================================
// PHASE SHOPEE-7: the ONE mapping of release / payout statuses to labels and
// badge tones. Wording is deliberate: "giải ngân" = Shopee released the
// order's money (to the Shopee wallet / payout), "payout" = Shopee's
// disbursement batch. Nothing here claims money reached the bank — no API
// confirms a bank deposit.
// Pure: no I/O.
// ============================================================
import type { IncomeStatus, PayoutReconciliationStatus, PayoutResolutionStatus } from "./payouts.ts";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";
interface Info {
  label: string;
  tone: Tone;
  description: string;
}

export const INCOME_STATUS_INFO: Record<IncomeStatus, Info> = {
  not_available: { label: "Chưa đến hạn", tone: "neutral", description: "Đơn chưa hoàn thành — Shopee chưa giải ngân." },
  pending: { label: "Chờ giải ngân", tone: "warning", description: "Đơn đã hoàn thành, Shopee chưa báo giải ngân." },
  released: { label: "Đã giải ngân", tone: "info", description: "Shopee đã giải ngân; chưa so được với thu nhập thực tế (chưa có quyết toán / khác tiền tệ)." },
  reconciled: { label: "Đã giải ngân · khớp", tone: "success", description: "Số Shopee giải ngân (cộng điều chỉnh về sau) khớp thu nhập thực tế của đơn." },
  mismatch: { label: "Lệch đối soát", tone: "danger", description: "Số Shopee giải ngân khác thu nhập thực tế của đơn." },
};

export const PAYOUT_RECON_INFO: Record<PayoutReconciliationStatus, Info> = {
  pending: { label: "Chờ hoàn tất", tone: "neutral", description: "Payout chưa hoàn tất (đang xử lý / đã huỷ) — chưa đối soát." },
  incomplete: { label: "Thiếu dữ liệu", tone: "warning", description: "Thiếu dữ liệu để kết luận (đơn chưa có trong hệ thống, số dư ví chưa rõ, khác tiền tệ) — không phải lệch." },
  matched: { label: "Khớp", tone: "success", description: "Số payout = tổng giải ngân + điều chỉnh (± số dư ví)." },
  mismatch: { label: "Lệch", tone: "danger", description: "Số payout khác số kỳ vọng — cần kiểm tra." },
};

export const PAYOUT_STATUS_LABEL: Record<"pending" | "completed" | "cancelled", string> = {
  pending: "Đang xử lý",
  completed: "Hoàn tất",
  cancelled: "Đã huỷ",
};

export const RESOLUTION_INFO: Record<PayoutResolutionStatus, Info> = {
  open: { label: "Chưa xử lý", tone: "neutral", description: "Chưa có ai xem chênh lệch." },
  investigating: { label: "Đang kiểm tra", tone: "info", description: "Đang tìm nguyên nhân." },
  resolved: { label: "Đã giải quyết", tone: "success", description: "Đã tìm ra và xử lý nguyên nhân (số liệu gốc giữ nguyên)." },
  accepted: { label: "Chấp nhận chênh lệch", tone: "warning", description: "Chênh lệch có giải thích và được chấp nhận (số liệu gốc giữ nguyên)." },
};

export const INCOMPLETE_REASON_LABEL: Record<string, string> = {
  orders_missing: "có đơn chưa có trong hệ thống (thường là đơn trước mốc đồng bộ)",
  balance_unknown: "không rõ số dư ví trước / sau lần rút",
  currency_mismatch: "đơn / điều chỉnh khác tiền tệ với payout",
  pending: "payout chưa hoàn tất",
  cancelled: "payout đã huỷ",
};

export const PAYOUT_SOURCE_LABEL: Record<string, string> = {
  wallet: "Rút tiền từ Ví Shopee",
  payout_detail: "Payout Shopee",
  fixture: "Fixture",
};
