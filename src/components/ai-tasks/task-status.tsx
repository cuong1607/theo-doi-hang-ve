// PHASE 06 — status pill for a task (label always shown; colour is never the only signal).
import { StatusBadge } from "@/components/patterns/status-badge";
import type { Tone } from "@/lib/ui/status";

const TONE: Record<string, Tone> = {
  pending_confirmation: "warning",
  accepted: "info",
  in_progress: "info",
  completed: "success",
  dismissed: "neutral",
  overdue: "danger",
  cancelled: "neutral",
};

export function TaskStatusBadge({ status, label }: { status: string; label: string }) {
  return <StatusBadge tone={TONE[status] ?? "neutral"}>{label}</StatusBadge>;
}

const REMINDER_TONE: Record<string, Tone> = { pending: "info", claimed: "info", sent: "success", sent_late: "warning", skipped_expired: "neutral", skipped: "neutral", cancelled: "neutral", failed: "danger" };
export const REMINDER_STATUS_LABEL: Record<string, string> = {
  pending: "Đang chờ",
  claimed: "Đang xử lý",
  sent: "Đã gửi",
  sent_late: "Gửi bù (trễ)",
  skipped_expired: "Bỏ qua (quá hạn gửi)",
  skipped: "Bỏ qua",
  cancelled: "Đã hủy",
  failed: "Lỗi — cần kiểm tra",
};
export const REMINDER_KIND_LABEL: Record<string, string> = { DAY: "Trước 24 giờ", HOUR: "Trước 1 giờ", OVERDUE: "Quá hạn", MORNING: "Bản tin 08:00" };
export const REMINDER_REASON_LABEL: Record<string, string> = {
  superseded: "lịch cũ (việc đã đổi)",
  task_closed: "việc đã đóng",
  access_revoked: "không còn quyền xem",
  preference_off: "bạn đã tắt loại nhắc này",
  past_deadline: "đã qua hạn",
  too_late: "trễ quá ngưỡng gửi bù",
  morning_window_closed: "đã qua 10:00",
  nothing_to_report: "không có việc",
  nothing_overdue: "không còn việc quá hạn",
  aggregated: "gộp vào cảnh báo tổng hợp",
  collapsed: "đã có thông báo cùng loại",
  recipient_inactive: "tài khoản bị khóa",
  max_attempts: "hết số lần thử",
};

export function ReminderStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={REMINDER_TONE[status] ?? "neutral"}>{REMINDER_STATUS_LABEL[status] ?? status}</StatusBadge>;
}
