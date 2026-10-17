// ============================================================
// PHASE SHOPEE-6: the ONE mapping of Shopee return statuses and of return
// dispositions (labels, badge tones, terminal flag). UI and sync import from
// here — no status strings scattered through the code.
//
// Shopee v2.returns status values (documented; unknown values are kept as
// raw text, shown as-is and treated as NOT terminal so they keep being
// re-synced until Shopee reports a known terminal state).
// Pure: no I/O.
// ============================================================

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

interface StatusInfo {
  label: string;
  tone: Tone;
  /** No further changes expected → not re-polled. */
  terminal: boolean;
  /** Refund / settlement concluded (sets completed_at). */
  completed: boolean;
}

export const RETURN_STATUS: Record<string, StatusInfo> = {
  REQUESTED: { label: "Yêu cầu trả hàng", tone: "warning", terminal: false, completed: false },
  ACCEPTED: { label: "Đã chấp nhận trả hàng", tone: "info", terminal: false, completed: false },
  PROCESSING: { label: "Đang vận chuyển hoàn", tone: "info", terminal: false, completed: false },
  JUDGING: { label: "Shopee đang xem xét", tone: "warning", terminal: false, completed: false },
  SELLER_DISPUTE: { label: "Đang khiếu nại", tone: "warning", terminal: false, completed: false },
  REFUND_PAID: { label: "Đã hoàn tiền", tone: "success", terminal: true, completed: true },
  CLOSED: { label: "Đã hoàn tất", tone: "neutral", terminal: true, completed: true },
  CANCELLED: { label: "Đã huỷ", tone: "neutral", terminal: true, completed: false },
};

export function returnStatusInfo(status: string | null | undefined): StatusInfo {
  const known = status ? RETURN_STATUS[status.toUpperCase()] : undefined;
  return known ?? { label: status || "Không rõ", tone: "neutral", terminal: false, completed: false };
}

export const isReturnTerminal = (status: string | null | undefined): boolean => returnStatusInfo(status).terminal;

export const RETURN_DISPOSITIONS = ["pending", "restock", "damaged", "lost", "disposed"] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export const DISPOSITION_INFO: Record<ReturnDisposition, { label: string; tone: Tone; description: string }> = {
  pending: { label: "Chờ xử lý", tone: "warning", description: "Chưa xác định hàng xử lý thế nào — chưa nhập kho, chưa hoàn giá vốn." },
  restock: { label: "Nhập lại kho", tone: "success", description: "Hàng về kho, bán lại được — nhập kho theo giá vốn gốc của đơn, hoàn lại giá vốn." },
  damaged: { label: "Hỏng", tone: "danger", description: "Hàng về nhưng không bán lại được — không nhập kho, giá vốn vẫn tính." },
  lost: { label: "Thất lạc", tone: "danger", description: "Hàng không về — không nhập kho, giá vốn vẫn tính." },
  disposed: { label: "Huỷ bỏ", tone: "neutral", description: "Huỷ bỏ / không dùng lại — không nhập kho, giá vốn vẫn tính." },
};

export const isReturnDisposition = (v: unknown): v is ReturnDisposition => typeof v === "string" && (RETURN_DISPOSITIONS as readonly string[]).includes(v);
