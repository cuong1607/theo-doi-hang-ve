// PHASE 04.5 — status pill of an AI reply (label always shown; colour is never the only signal).
import { StatusBadge } from "@/components/patterns/status-badge";
import type { Tone } from "@/lib/ui/status";

const TONE: Record<string, Tone> = {
  pending_approval: "warning",
  queued: "info",
  sending: "info",
  sent: "success",
  failed: "danger",
  delivery_unknown: "danger",
  rejected: "neutral",
  cancelled: "neutral",
  expired: "neutral",
};

export function DraftStatusBadge({ status, label }: { status: string; label: string }) {
  return <StatusBadge tone={TONE[status] ?? "neutral"}>{label}</StatusBadge>;
}

export const KIND_LABEL: Record<string, string> = { ai_answer: "Câu trả lời AI", link_help: "Hướng dẫn liên kết", link_result: "Kết quả liên kết", notice: "Thông báo", reminder: "Nhắc việc" };
export const PIPELINE_LABEL: Record<string, string> = { system: "Dữ liệu hệ thống (Trợ lý hệ thống)", memory: "Lịch sử hội thoại (Hỏi AI)", none: "Không dùng AI" };
