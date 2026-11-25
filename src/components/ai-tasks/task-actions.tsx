"use client";

// PHASE 06 — task actions. UI convenience only: the server re-checks the per-task
// role (manager / assignee) and the transition, and the revision makes a
// concurrent change fail with a clear message instead of overwriting it.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/patterns/toast";
import { callApi } from "@/components/zalo-personal/api-client";

type Action = "confirm" | "dismiss" | "edit" | "start" | "progress" | "complete" | "cancel" | "reopen" | "accept_proposal" | "reject_proposal";

export interface TaskActionsProps {
  taskId: string;
  revision: number;
  actions: Array<{ action: Action; label: string }>;
  title: string;
  description: string | null;
  deadlineAt: string | null;
  deadlineAssumed: boolean;
  progress: number;
  assignedUserIds: string[];
  assignable: Array<{ userId: string; name: string }>;
}

/** ISO → "YYYY-MM-DDTHH:mm" in Asia/Ho_Chi_Minh (UTC+7, no DST) for <input type="datetime-local">. */
const toVnLocal = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 16) : "");
const fromVnLocal = (v: string) => (v ? new Date(`${v}:00+07:00`).toISOString() : null);

const SUCCESS: Record<Action, string> = {
  confirm: "Đã xác nhận công việc. Nhắc việc đã được lên lịch.",
  dismiss: "Đã đánh dấu không phải việc.",
  edit: "Đã lưu thay đổi.",
  start: "Đã chuyển sang đang làm.",
  progress: "Đã cập nhật tiến độ.",
  complete: "Đã hoàn thành công việc.",
  cancel: "Đã hủy công việc.",
  reopen: "Đã mở lại công việc.",
  accept_proposal: "Đã áp dụng hạn mới.",
  reject_proposal: "Đã giữ hạn cũ.",
};

export function TaskActions(p: TaskActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<Action | null>(null);
  const [title, setTitle] = useState(p.title);
  const [description, setDescription] = useState(p.description ?? "");
  const [deadline, setDeadline] = useState(toVnLocal(p.deadlineAt));
  const [assigned, setAssigned] = useState<string[]>(p.assignedUserIds.filter((u) => p.assignable.some((a) => a.userId === u)));
  const [progress, setProgress] = useState(String(p.progress || 0));
  const [note, setNote] = useState("");

  const send = (action: Action, extra: Record<string, unknown> = {}) =>
    startTransition(async () => {
      const res = await callApi<{ status: string }>(`/api/zalo-personal/tasks/${p.taskId}/actions`, { method: "POST", body: { action, revision: p.revision, ...extra } });
      if (!res.ok) {
        toast.error(res.message);
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(SUCCESS[action]);
      setOpen(null);
      router.refresh();
    });

  const editBody = () => {
    const body: Record<string, unknown> = {};
    if (title.trim() !== p.title) body.title = title.trim();
    if ((description || null) !== p.description) body.description = description || null;
    const d = fromVnLocal(deadline);
    if (d !== (p.deadlineAt ? new Date(p.deadlineAt).toISOString() : null) || (open === "confirm" && p.deadlineAssumed)) body.deadlineAt = d;
    const before = [...p.assignedUserIds].filter((u) => p.assignable.some((a) => a.userId === u)).sort().join();
    if ([...assigned].sort().join() !== before) body.assigneeUserIds = assigned;
    return body;
  };

  if (!p.actions.length) return <p className="text-sm text-muted-foreground">Bạn chỉ có quyền xem công việc này.</p>;
  const direct: Action[] = ["start", "reopen", "accept_proposal", "reject_proposal"];

  return (
    <div className="flex flex-wrap gap-2">
      {p.actions.map(({ action, label }) => (
        <Button
          key={action}
          size="sm"
          variant={action === "confirm" || action === "complete" ? "default" : action === "cancel" || action === "dismiss" ? "outline" : "secondary"}
          disabled={pending}
          onClick={() => (direct.includes(action) ? send(action) : setOpen(action))}
        >
          {label}
        </Button>
      ))}

      <Dialog open={open === "confirm" || open === "edit"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open === "confirm" ? "Xác nhận công việc" : "Chỉnh sửa công việc"}</DialogTitle>
            <DialogDescription>{open === "confirm" ? "Kiểm tra lại nội dung, hạn và người được giao. Sau khi xác nhận, hệ thống mới lên lịch nhắc việc." : "Đổi hạn hoặc người được giao sẽ hủy lịch nhắc cũ và lập lịch mới."}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Tiêu đề</span>
              <Input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Mô tả (tùy chọn)</span>
              <textarea className="min-h-20 rounded-md border bg-transparent px-3 py-2 text-sm" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Hạn (giờ Việt Nam)</span>
              <Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              {p.deadlineAssumed && <span className="text-xs text-warning-text">Hạn hiện tại là giả định của hệ thống — hãy kiểm tra.</span>}
            </label>
            {p.assignable.length > 0 && (
              <fieldset className="grid gap-1 text-sm">
                <legend className="mb-1 font-medium">Giao cho (người có quyền xem hội thoại này)</legend>
                {p.assignable.map((a) => (
                  <label key={a.userId} className="flex items-center gap-2">
                    <input type="checkbox" checked={assigned.includes(a.userId)} onChange={(e) => setAssigned((s) => (e.target.checked ? [...s, a.userId] : s.filter((x) => x !== a.userId)))} />
                    {a.name}
                  </label>
                ))}
              </fieldset>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} disabled={pending}>
              Đóng
            </Button>
            <Button disabled={pending || !title.trim()} onClick={() => send(open!, editBody())}>
              {open === "confirm" ? "Xác nhận" : "Lưu"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "progress"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cập nhật tiến độ</DialogTitle>
            <DialogDescription>Tiến độ do người làm tự báo; hệ thống không tự suy ra từ tin nhắn.</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Tiến độ (%)</span>
            <Input type="number" min={0} max={100} value={progress} onChange={(e) => setProgress(e.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Ghi chú (tùy chọn)</span>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} disabled={pending}>
              Đóng
            </Button>
            <Button disabled={pending || !/^\d{1,3}$/.test(progress) || Number(progress) > 100} onClick={() => send("progress", { progress: Number(progress), note: note || null })}>
              Lưu tiến độ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "complete" || open === "cancel" || open === "dismiss"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open === "complete" ? "Hoàn thành công việc" : open === "cancel" ? "Hủy công việc" : "Không phải việc"}</DialogTitle>
            <DialogDescription>{open === "complete" ? "Mọi nhắc việc chưa gửi sẽ được hủy." : open === "cancel" ? "Mọi nhắc việc chưa gửi sẽ được hủy. Có thể mở lại sau." : "Đề xuất này sẽ được bỏ qua. Có thể mở lại sau."}</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{open === "complete" ? "Ghi chú (tùy chọn)" : "Lý do (tùy chọn)"}</span>
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} disabled={pending}>
              Đóng
            </Button>
            <Button variant={open === "complete" ? "default" : "destructive"} disabled={pending} onClick={() => send(open!, open === "complete" ? { note: note || null } : { reason: note || null })}>
              {open === "complete" ? "Hoàn thành" : open === "cancel" ? "Hủy việc" : "Bỏ qua"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
