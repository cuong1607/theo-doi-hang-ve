// ============================================================
// PHASE 06 — Task lifecycle (TASK-05) + who may do what (TASK-13). Pure.
//
//   pending_confirmation ──confirm──► accepted ──start/progress──► in_progress
//          │                              │  ╲                         │
//          └─dismiss─► dismissed          │   ╲ (deadline passed:      │
//                         │               │    system) ─► overdue ◄────┘
//                         └─reopen─► pending_confirmation
//   accepted | in_progress | overdue ──complete──► completed ──reopen──► accepted / in_progress / overdue
//   accepted | in_progress | overdue ──cancel────► cancelled ──reopen──► (same)
//   edit (title, description, assignees, deadline) in any open state; a
//   deadline moved into the future takes an overdue task back to accepted /
//   in_progress. AI and the system never complete, cancel or confirm a task.
//
// Roles per task (computed by the server from the Phase 03 scope, never sent by the client):
//   manager   connection owner, or a connection-wide "manage" grant
//   assignee  a resolved assignee (verified link / owner / manual) who can read the chat
//   reader    can read the source conversation
//   none      anything else → the task does not exist for this user (404)
// ============================================================

export const TASK_STATUSES = ["pending_confirmation", "accepted", "in_progress", "completed", "dismissed", "overdue", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_STATUSES: readonly TaskStatus[] = ["accepted", "in_progress", "overdue"];
export const EDITABLE_STATUSES: readonly TaskStatus[] = ["pending_confirmation", "accepted", "in_progress", "overdue"];

export type TaskRole = "manager" | "assignee" | "reader" | "none";

export type TaskAction = "confirm" | "dismiss" | "edit" | "start" | "progress" | "complete" | "cancel" | "reopen" | "accept_proposal" | "reject_proposal";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending_confirmation: "Chờ xác nhận",
  accepted: "Đã nhận",
  in_progress: "Đang làm",
  completed: "Hoàn thành",
  dismissed: "Đã bỏ qua",
  overdue: "Quá hạn",
  cancelled: "Đã hủy",
};

/** Who proposed the task (display only). */
export const EXTRACTOR_LABEL: Record<string, string> = { gemini: "AI", rules: "Quy tắc", manual: "Thủ công" };

export const ACTION_LABEL: Record<TaskAction, string> = {
  confirm: "Xác nhận",
  dismiss: "Không phải việc",
  edit: "Chỉnh sửa",
  start: "Bắt đầu làm",
  progress: "Cập nhật tiến độ",
  complete: "Hoàn thành",
  cancel: "Hủy việc",
  reopen: "Mở lại",
  accept_proposal: "Áp dụng hạn mới",
  reject_proposal: "Giữ hạn cũ",
};

interface Rule {
  from: readonly TaskStatus[];
  roles: readonly TaskRole[];
}

export const RULES: Record<TaskAction, Rule> = {
  confirm: { from: ["pending_confirmation"], roles: ["manager"] },
  dismiss: { from: ["pending_confirmation"], roles: ["manager"] },
  edit: { from: EDITABLE_STATUSES, roles: ["manager"] },
  start: { from: ["accepted"], roles: ["manager", "assignee"] },
  progress: { from: OPEN_STATUSES, roles: ["manager", "assignee"] },
  complete: { from: OPEN_STATUSES, roles: ["manager", "assignee"] },
  cancel: { from: OPEN_STATUSES, roles: ["manager"] },
  reopen: { from: ["completed", "cancelled", "dismissed"], roles: ["manager"] },
  accept_proposal: { from: EDITABLE_STATUSES, roles: ["manager"] },
  reject_proposal: { from: EDITABLE_STATUSES, roles: ["manager"] },
};

export interface TaskSnapshot {
  status: TaskStatus;
  deadlineAt: Date | null;
  progress: number;
  hasProposal: boolean;
}

export type Permission = { ok: true } | { ok: false; reason: "forbidden" | "invalid_state" };

export function canPerform(action: TaskAction, role: TaskRole, task: TaskSnapshot): Permission {
  const rule = RULES[action];
  if (!rule.roles.includes(role)) return { ok: false, reason: "forbidden" };
  if (!rule.from.includes(task.status)) return { ok: false, reason: "invalid_state" };
  if ((action === "accept_proposal" || action === "reject_proposal") && !task.hasProposal) return { ok: false, reason: "invalid_state" };
  return { ok: true };
}

export function allowedActions(role: TaskRole, task: TaskSnapshot): TaskAction[] {
  return (Object.keys(RULES) as TaskAction[]).filter((a) => canPerform(a, role, task).ok);
}

/** Open status for a (re)opened / edited task given its deadline. */
function openStatus(task: { deadlineAt: Date | null; progress: number }, now: Date): TaskStatus {
  if (task.deadlineAt && task.deadlineAt.getTime() <= now.getTime()) return "overdue";
  return task.progress > 0 ? "in_progress" : "accepted";
}

/** Status after `action` (the deadline / progress passed in are the NEW values). */
export function nextStatus(action: TaskAction, current: TaskStatus, after: { deadlineAt: Date | null; progress: number }, now: Date): TaskStatus {
  switch (action) {
    case "confirm":
      return openStatus({ deadlineAt: after.deadlineAt, progress: 0 }, now);
    case "dismiss":
      return "dismissed";
    case "start":
      return "in_progress";
    case "progress":
      return current === "overdue" ? "overdue" : "in_progress";
    case "complete":
      return "completed";
    case "cancel":
      return "cancelled";
    case "reopen":
      return current === "dismissed" ? "pending_confirmation" : openStatus(after, now);
    case "edit":
    case "accept_proposal":
    case "reject_proposal":
      return current === "pending_confirmation" ? current : openStatus(after, now);
  }
}

/** Does this change require the reminder plan to be rebuilt (old occurrences cancelled)? */
export function needsReplan(action: TaskAction, before: { status: TaskStatus; deadlineAt: Date | null }, after: { status: TaskStatus; deadlineAt: Date | null }, assigneesChanged: boolean): boolean {
  if (before.status !== after.status && (OPEN_STATUSES.includes(before.status) || OPEN_STATUSES.includes(after.status))) return true;
  if (action === "confirm" || action === "reopen" || action === "accept_proposal") return true;
  if ((before.deadlineAt?.getTime() ?? null) !== (after.deadlineAt?.getTime() ?? null)) return true;
  return assigneesChanged && OPEN_STATUSES.includes(after.status);
}
