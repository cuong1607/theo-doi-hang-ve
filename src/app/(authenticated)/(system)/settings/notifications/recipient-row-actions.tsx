"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal, Pencil, Power, PowerOff, Send, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { deleteRecipient, setRecipientActive } from "./recipients-actions";
import { RecipientFormDialog, type RecipientRecord } from "./recipient-form-dialog";

type Recipient = RecipientRecord & { isActive: boolean };

export function RecipientRowActions({ recipient }: { recipient: Recipient }) {
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState(0);
  const [toggleConfirmOpen, setToggleConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [testResultOpen, setTestResultOpen] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // ZL7 Phần 7 — "test 1 recipient": same route as "Gửi tin thử cho tất
  // cả" (ZL2), scoped to just this recipient via the request body.
  async function handleTestSend() {
    setTestResultOpen(true);
    setTestPending(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/notifications/test-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientId: recipient.id }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const outcome = data.results?.[0];
        setTestResult(
          outcome?.status === "sent"
            ? "Đã gửi thành công."
            : `Gửi thất bại${outcome?.errorCode ? ` (mã lỗi: ${outcome.errorCode})` : ""}.`
        );
      } else {
        setTestResult(data.errorMessage ?? "Gửi thử thất bại.");
      }
    } catch {
      setTestResult("Không thể gọi API gửi thử.");
    } finally {
      setTestPending(false);
    }
  }

  function handleToggleActive() {
    setError(null);
    startTransition(async () => {
      const result = await setRecipientActive(recipient.id, !recipient.isActive);
      if (result.status === "error") {
        setError(result.message ?? "Không thể cập nhật trạng thái.");
        return;
      }
      setToggleConfirmOpen(false);
    });
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteRecipient(recipient.id);
      if (result.status === "error") {
        setError(result.message ?? "Không thể xóa người nhận.");
        return;
      }
      setDeleteConfirmOpen(false);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
          <MoreHorizontal />
          <span className="sr-only">Thao tác</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setEditKey((k) => k + 1);
              setEditOpen(true);
            }}
          >
            <Pencil /> Sửa
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setToggleConfirmOpen(true)}>
            {recipient.isActive ? <PowerOff /> : <Power />}
            {recipient.isActive ? "Tắt" : "Bật lại"}
          </DropdownMenuItem>
          {recipient.isActive && (
            <DropdownMenuItem onClick={handleTestSend}>
              <Send /> Gửi thử
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onClick={() => setDeleteConfirmOpen(true)}>
            <Trash2 /> Xóa
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RecipientFormDialog key={editKey} open={editOpen} onOpenChange={setEditOpen} recipient={recipient} />

      <Dialog
        open={toggleConfirmOpen}
        onOpenChange={(next) => {
          setToggleConfirmOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{recipient.isActive ? "Tắt người nhận này?" : "Bật lại người nhận này?"}</DialogTitle>
            <DialogDescription>
              {recipient.isActive
                ? `"${recipient.name}" sẽ không nhận thông báo nào cho tới khi bật lại.`
                : `"${recipient.name}" sẽ nhận thông báo trở lại.`}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setToggleConfirmOpen(false)} disabled={isPending}>
              Hủy
            </Button>
            <Button type="button" onClick={handleToggleActive} disabled={isPending}>
              {isPending ? "Đang xử lý..." : "Xác nhận"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteConfirmOpen}
        onOpenChange={(next) => {
          setDeleteConfirmOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xóa người nhận?</DialogTitle>
            <DialogDescription>
              &quot;{recipient.name}&quot; sẽ bị xóa khỏi danh sách nhận thông báo. Lịch sử gửi trước đó vẫn được
              giữ nguyên.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteConfirmOpen(false)} disabled={isPending}>
              Hủy
            </Button>
            <Button type="button" variant="destructive" onClick={handleDelete} disabled={isPending}>
              {isPending ? "Đang xóa..." : "Xóa"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={testResultOpen} onOpenChange={setTestResultOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gửi thử tới &quot;{recipient.name}&quot;</DialogTitle>
            <DialogDescription>{testPending ? "Đang gửi..." : (testResult ?? "")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => setTestResultOpen(false)}>
              Đóng
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
