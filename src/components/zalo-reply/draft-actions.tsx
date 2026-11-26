"use client";

// PHASE 04.5 — review actions of one AI reply. UI convenience only: the server
// re-checks the reviewer (owner / manage grant + data permissions), the state
// transition, the expiry and the version (a concurrent change fails with 409).
// Approving only QUEUES the reply; the worker sends it after the database
// re-checks every gate (stop, pause, group mode, identity, limits).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/patterns/toast";
import { callApi } from "@/components/zalo-personal/api-client";

type Action = "approve" | "edit" | "reject" | "cancel" | "confirm_sent" | "confirm_not_sent";

const SUCCESS: Record<Action, string> = {
  approve: "Đã duyệt. Tin sẽ được gửi khi worker kết nối và đủ điều kiện.",
  edit: "Đã lưu nội dung.",
  reject: "Đã từ chối bản nháp.",
  cancel: "Đã hủy.",
  confirm_sent: "Đã ghi nhận: tin đã đến người nhận.",
  confirm_not_sent: "Đã ghi nhận: tin chưa được gửi. Hệ thống sẽ không tự gửi lại.",
};

export function DraftActions({ draftId, version, text, actions, sendEnabled }: { draftId: string; version: number; text: string; actions: Array<{ action: Action; label: string }>; sendEnabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<Action | null>(null);
  const [draft, setDraft] = useState(text);
  const [note, setNote] = useState("");

  const send = (action: Action, extra: Record<string, unknown> = {}) =>
    startTransition(async () => {
      const res = await callApi<{ status: string }>(`/api/zalo-personal/replies/${draftId}/actions`, { method: "POST", body: { action, version, ...extra } });
      if (!res.ok) {
        toast.error(res.message);
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(SUCCESS[action]);
      setOpen(null);
      router.refresh();
    });

  if (!actions.length) return <p className="text-sm text-muted-foreground">Không còn thao tác nào cho trạng thái này.</p>;

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map(({ action, label }) => (
        <Button key={action} size="sm" variant={action === "approve" || action === "confirm_sent" ? "default" : action === "reject" || action === "cancel" ? "outline" : "secondary"} disabled={pending} onClick={() => setOpen(action)}>
          {label}
        </Button>
      ))}

      <Dialog open={open === "edit"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sửa nội dung trả lời</DialogTitle>
            <DialogDescription>Nội dung gốc do AI đề xuất vẫn được lưu để đối chiếu. Tối đa 1800 ký tự, chỉ văn bản thuần.</DialogDescription>
          </DialogHeader>
          <textarea aria-label="Nội dung trả lời" className="min-h-48 rounded-md border bg-transparent px-3 py-2 text-sm" value={draft} maxLength={1800} onChange={(e) => setDraft(e.target.value)} />
          <p className="text-xs text-muted-foreground tabular-nums">{draft.length}/1800</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} disabled={pending}>
              Đóng
            </Button>
            <Button disabled={pending || !draft.trim() || draft === text} onClick={() => send("edit", { text: draft })}>
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open !== null && open !== "edit"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {open === "approve" ? "Duyệt và đưa vào hàng gửi" : open === "reject" ? "Từ chối bản nháp" : open === "cancel" ? "Hủy trả lời" : open === "confirm_sent" ? "Xác nhận tin ĐÃ đến người nhận" : "Xác nhận tin CHƯA được gửi"}
            </DialogTitle>
            <DialogDescription>
              {open === "approve"
                ? sendEnabled
                  ? "Tin sẽ được gửi từ tài khoản Zalo cá nhân đang kết nối. Ngay trước khi gửi, hệ thống kiểm tra lại quyền, chế độ nhóm, giới hạn tần suất và dừng khẩn cấp."
                  : "Gửi tin đang TẮT ở cấp hệ thống (PERSONAL_SEND_ENABLED). Tin sẽ nằm trong hàng chờ và hết hạn nếu không được bật."
                : open === "confirm_sent"
                  ? "Chỉ xác nhận khi bạn đã thấy tin trong cuộc trò chuyện trên điện thoại."
                  : open === "confirm_not_sent"
                    ? "Chỉ xác nhận khi bạn đã kiểm tra trên điện thoại và KHÔNG thấy tin. Hệ thống sẽ không tự gửi lại."
                    : "Thao tác được ghi vào nhật ký."}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Ghi chú (tùy chọn)</span>
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} disabled={pending}>
              Đóng
            </Button>
            <Button variant={open === "reject" || open === "cancel" ? "destructive" : "default"} disabled={pending} onClick={() => send(open!, note.trim() ? { note: note.trim() } : {})}>
              Xác nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
