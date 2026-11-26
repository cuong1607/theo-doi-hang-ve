// ============================================================
// PHASE 04.5 — REPLY-05 / REPLY-06: draft + delivery state machine. Pure.
// The database (zp_reply_act / zp_reply_claim_outbound / zp_reply_report /
// zp_reply_recover) enforces the SAME transitions; this module decides which
// buttons the UI shows and is the unit-tested reference.
//
//   pending_approval ──approve──▶ queued ──claim──▶ sending ──sent──▶ sent
//        │  ▲ edit                 │                  │ not_sent (≤3) ─▶ queued
//        │──┘                      │                  │ failed ───────▶ failed (+ send pause)
//        ├─reject──▶ rejected      │                  │ unknown / lease lost ─▶ delivery_unknown
//        ├─cancel──▶ cancelled ◀───┘ cancel / gate fails at claim         │
//        └─(TTL)───▶ expired ◀──── (TTL)              confirm_sent ◀──────┤──▶ sent
//                                                     confirm_not_sent ◀──┘──▶ failed
// "draft" and "approved" of the spec are pending_approval and queued (+ approved_by).
// ============================================================

export const DRAFT_STATUSES = ["pending_approval", "queued", "sending", "sent", "failed", "delivery_unknown", "rejected", "cancelled", "expired"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const REVIEW_ACTIONS = ["approve", "edit", "reject", "cancel", "confirm_sent", "confirm_not_sent"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export type WorkerOutcome = "sent" | "not_sent" | "failed" | "unknown";

export const STATUS_LABEL: Record<DraftStatus, string> = {
  pending_approval: "Chờ duyệt",
  queued: "Đã duyệt, chờ gửi",
  sending: "Đang gửi",
  sent: "Đã gửi",
  failed: "Gửi thất bại",
  delivery_unknown: "Chưa rõ đã gửi chưa",
  rejected: "Đã từ chối",
  cancelled: "Đã hủy",
  expired: "Hết hạn",
};

export const ACTION_LABEL: Record<ReviewAction, string> = {
  approve: "Duyệt & gửi",
  edit: "Sửa nội dung",
  reject: "Từ chối",
  cancel: "Hủy",
  confirm_sent: "Xác nhận đã gửi",
  confirm_not_sent: "Xác nhận chưa gửi",
};

const RULES: Record<ReviewAction, readonly DraftStatus[]> = {
  approve: ["pending_approval"],
  edit: ["pending_approval"],
  reject: ["pending_approval"],
  cancel: ["pending_approval", "queued"],
  confirm_sent: ["delivery_unknown"],
  confirm_not_sent: ["delivery_unknown"],
};

const NEXT: Record<ReviewAction, DraftStatus | null> = {
  approve: "queued",
  edit: null,
  reject: "rejected",
  cancel: "cancelled",
  confirm_sent: "sent",
  confirm_not_sent: "failed",
};

export function canPerform(status: DraftStatus, action: ReviewAction, expired: boolean): boolean {
  if (!RULES[action].includes(status)) return false;
  if ((action === "approve" || action === "edit") && expired) return false;
  return true;
}

export function nextStatus(status: DraftStatus, action: ReviewAction): DraftStatus {
  return NEXT[action] ?? status;
}

export function allowedActions(status: DraftStatus, expired: boolean): ReviewAction[] {
  return REVIEW_ACTIONS.filter((a) => canPerform(status, a, expired));
}

/** Worker report → next status (mirror of zp_reply_report). */
export function afterReport(status: DraftStatus, outcome: WorkerOutcome, attempts: number, expired: boolean): DraftStatus {
  if (status === "sent" || status === "cancelled" || status === "expired" || status === "rejected") return status;
  if ((status === "failed" || status === "delivery_unknown") && outcome !== "sent") return status;
  if (status !== "sending" && status !== "delivery_unknown" && status !== "failed") return status;
  switch (outcome) {
    case "sent":
      return "sent";
    case "not_sent":
      return attempts < 3 && !expired ? "queued" : "failed";
    case "failed":
      return "failed";
    case "unknown":
      return "delivery_unknown";
  }
}

export const FINAL_STATUSES: ReadonlySet<DraftStatus> = new Set(["sent", "failed", "rejected", "cancelled", "expired"]);

export const HOLD_LABEL: Record<string, string> = {
  cooldown: "Đang chờ hết thời gian giãn cách của hội thoại",
  user_rate_limited: "Người hỏi đã đạt giới hạn mỗi giờ",
  group_rate_limited: "Nhóm đã đạt giới hạn mỗi giờ",
  conversation_daily_cap: "Hội thoại đã đạt giới hạn trong ngày",
  mode_no_send: "Kết nối đang ở chế độ Tắt / Chỉ bản nháp (không gửi)",
};

export const ERROR_LABEL: Record<string, string> = {
  lease_expired: "Worker không báo kết quả kịp (có thể đã khởi động lại giữa lúc gửi)",
  timeout: "Hết thời gian chờ Zalo phản hồi",
  network_after_send: "Mất kết nối sau khi đã gửi yêu cầu",
  response_unreadable: "Zalo trả về phản hồi không đọc được",
  zalo_rejected: "Zalo từ chối tin nhắn",
  account_restricted: "Có dấu hiệu tài khoản bị hạn chế",
  http_error: "Zalo trả lỗi HTTP",
  not_connected: "Worker chưa kết nối Zalo",
  invalid_message: "Nội dung tin không hợp lệ với Zalo",
  network: "Không kết nối được tới Zalo (chưa gửi)",
  operator_not_sent: "Người vận hành xác nhận chưa gửi",
  group_not_allowed: "Nhóm không còn cho phép phản hồi",
  auto_not_allowed: "Không còn đủ điều kiện tự động gửi",
  direct_disabled: "Đã tắt trả lời chat 1-1",
  sender_blocked: "Người hỏi bị chặn",
  asker_not_authorized: "Người hỏi không còn liên kết / bị khóa",
  approver_inactive: "Người duyệt bị khóa",
  operator_cancelled: "Người vận hành đã hủy",
  channel_disabled: "Kênh nhắc việc qua Zalo đã tắt",
  task_closed: "Công việc đã hoàn thành / hủy",
  unknown: "Không rõ kết quả",
};

/** Claim reasons the worker gets when nothing is sent (operations page). */
export const CLAIM_REASON_LABEL: Record<string, string> = {
  emergency_stop: "Dừng khẩn cấp đang bật",
  connection_send_off: "Kết nối chưa được bật gửi",
  send_paused: "Kết nối đang tạm dừng gửi",
  global_daily_limit: "Đã đạt giới hạn toàn hệ thống hôm nay",
  daily_limit: "Kết nối đã đạt giới hạn hôm nay",
  send_disabled: "Gửi tin đang tắt ở cấp hệ thống",
  empty: "Không có tin chờ gửi",
};
