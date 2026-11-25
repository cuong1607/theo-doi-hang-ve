// ============================================================
// PHASE 06 — Vietnamese notification texts (Web Inbox). Pure.
// Rule: a notification never carries the group's message text. It names the
// task (a title the recipient may read: they were checked against the source
// chat) and counts; the inbox re-checks the scope when it is listed and hides
// the body if the reader lost access meanwhile.
// ============================================================
import { formatVn } from "./time.ts";

export interface InboxNotification {
  userId: string;
  kind: "mention" | "task_confirmation" | "deadline_proposal" | "deadline_day" | "deadline_hour" | "overdue" | "overdue_digest" | "morning_digest";
  title: string;
  body: string | null;
  taskId?: string | null;
  taskIds?: string[];
  connectionId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  link: string | null;
  dedupeKey: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const chat = (groupName: string | null, type: "user" | "group") => (type === "group" ? `nhóm ${groupName?.trim() || "Zalo"}` : "chat 1-1");
const deadlineText = (d: Date | null) => (d ? formatVn(d) : "chưa có hạn");

export const taskLink = (taskId: string) => `/apps/zalo/personal/tasks/${taskId}`;

export function mentionNotification(a: { userId: string; messageId: string; connectionId: string; conversationId: string; groupName: string | null; messageAt: Date }): InboxNotification {
  return {
    userId: a.userId,
    kind: "mention",
    title: `Bạn được nhắc tên trong ${chat(a.groupName, "group")}`,
    body: `Lúc ${formatVn(a.messageAt, false)}. Mở để xem tin nhắn (cần quyền xem hội thoại).`,
    connectionId: a.connectionId,
    conversationId: a.conversationId,
    messageId: a.messageId,
    link: `/apps/zalo/personal/conversations/${a.conversationId}?focus=${a.messageId}&at=${encodeURIComponent(a.messageAt.toISOString())}`,
    dedupeKey: `mention:${a.messageId}:${a.userId}`,
  };
}

export function confirmationText(t: { title: string; deadlineAt: Date | null; extractor: "gemini" | "rules"; groupName: string | null; conversationType: "user" | "group" }) {
  return {
    title: clip(`Việc mới cần xác nhận: ${t.title}`, 200),
    body: `${t.extractor === "gemini" ? "AI" : "Bộ quy tắc"} phát hiện trong ${chat(t.groupName, t.conversationType)}. Hạn: ${deadlineText(t.deadlineAt)}. Chưa có nhắc việc nào cho đến khi được xác nhận.`,
  };
}

export function proposalText(t: { title: string; current: Date | null; proposed: Date }) {
  return { title: clip(`Đề xuất đổi hạn: ${t.title}`, 200), body: `Hạn hiện tại: ${deadlineText(t.current)}. Tin nhắn mới gợi ý: ${formatVn(t.proposed)}. Hạn chỉ đổi khi người quản lý áp dụng.` };
}

export function reminderNotification(kind: "DAY" | "HOUR" | "OVERDUE", a: { userId: string; occurrenceId: string; taskId: string; title: string; deadlineAt: Date; late: boolean; connectionId: string; conversationId: string }): InboxNotification {
  const head = kind === "DAY" ? "Còn khoảng 24 giờ" : kind === "HOUR" ? "Còn khoảng 1 giờ" : "Quá hạn";
  return {
    userId: a.userId,
    kind: kind === "DAY" ? "deadline_day" : kind === "HOUR" ? "deadline_hour" : "overdue",
    title: clip(`${head}: ${a.title}`, 200),
    body: `Hạn: ${formatVn(a.deadlineAt)}.${a.late ? " (Nhắc bù: hệ thống gửi trễ so với lịch.)" : ""}`,
    taskId: a.taskId,
    connectionId: a.connectionId,
    conversationId: a.conversationId,
    link: taskLink(a.taskId),
    dedupeKey: `reminder:${a.occurrenceId}`,
  };
}

export function overdueDigest(a: { userId: string; dayKey: string; tasks: Array<{ id: string; title: string; deadlineAt: Date | null }> }): InboxNotification {
  const lines = a.tasks.slice(0, 10).map((t) => `• ${clip(t.title, 90)} (hạn ${deadlineText(t.deadlineAt)})`);
  return {
    userId: a.userId,
    kind: "overdue_digest",
    title: `${a.tasks.length} việc đang quá hạn`,
    body: [...lines, a.tasks.length > 10 ? `… và ${a.tasks.length - 10} việc khác.` : "", "Cảnh báo tổng hợp (hệ thống gửi bù sau thời gian gián đoạn)."].filter(Boolean).join("\n"),
    taskIds: a.tasks.slice(0, 50).map((t) => t.id),
    link: "/apps/zalo/personal/tasks?view=overdue",
    dedupeKey: `overdue-digest:${a.userId}:${a.dayKey}`,
  };
}

export function morningDigest(a: { userId: string; dayKey: string; overdue: Array<{ id: string; title: string }>; today: Array<{ id: string; title: string; deadlineAt: Date | null }>; other: number; late: boolean }): InboxNotification | null {
  if (!a.overdue.length && !a.today.length && !a.other) return null;
  const lines: string[] = [];
  if (a.overdue.length) lines.push(`Quá hạn (${a.overdue.length}): ${a.overdue.slice(0, 5).map((t) => clip(t.title, 60)).join("; ")}${a.overdue.length > 5 ? "; …" : ""}`);
  if (a.today.length) lines.push(`Hạn hôm nay (${a.today.length}): ${a.today.slice(0, 5).map((t) => `${clip(t.title, 60)}${t.deadlineAt ? ` — ${formatVn(t.deadlineAt, false).slice(0, 5)}` : ""}`).join("; ")}${a.today.length > 5 ? "; …" : ""}`);
  if (a.other) lines.push(`Việc đang mở khác: ${a.other}`);
  if (a.late) lines.push("(Gửi bù sau 08:00 do hệ thống gián đoạn.)");
  const [y, m, d] = a.dayKey.split("-");
  return {
    userId: a.userId,
    kind: "morning_digest",
    title: `Việc của bạn hôm nay ${d}/${m}/${y}`,
    body: lines.join("\n"),
    taskIds: [...a.overdue, ...a.today].slice(0, 50).map((t) => t.id),
    link: "/apps/zalo/personal/tasks?view=mine",
    dedupeKey: `morning:${a.userId}:${a.dayKey}`,
  };
}

export const KIND_LABEL: Record<InboxNotification["kind"], string> = {
  mention: "Được nhắc tên",
  task_confirmation: "Cần xác nhận",
  deadline_proposal: "Đề xuất đổi hạn",
  deadline_day: "Sắp đến hạn (24h)",
  deadline_hour: "Sắp đến hạn (1h)",
  overdue: "Quá hạn",
  overdue_digest: "Tổng hợp quá hạn",
  morning_digest: "Bản tin sáng",
};
