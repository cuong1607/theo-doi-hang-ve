"use client";

// ZALO PERSONAL Phase 03 — change a group's monitoring mode / consent. UI convenience
// only: the API re-checks the permission (owner or manage grant), the database
// refuses monitoring without recorded consent and "interactive" without a verified
// sending path, and every change is audited. Turning monitoring off is always allowed.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/patterns/toast";

import { callApi } from "./api-client";

type Mode = "disabled" | "monitor" | "mention_only" | "interactive";

const MODE_ITEMS: { value: Mode; label: string }[] = [
  { value: "disabled", label: "Tắt" },
  { value: "monitor", label: "Theo dõi" },
  { value: "mention_only", label: "Chỉ khi được nhắc" },
  { value: "interactive", label: "Tương tác (chưa khả dụng)" },
];

export function GroupActions({ group }: { group: { id: string; name: string; mode: Mode; consentStatus: "none" | "granted" | "withdrawn"; interactiveAvailable: boolean } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmMode, setConfirmMode] = useState<Mode | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const consent = group.consentStatus === "granted";

  const send = (body: Record<string, unknown>, success: string, done?: () => void) =>
    startTransition(async () => {
      const res = await callApi<{ changed: boolean }>(`/api/zalo-personal/groups/${group.id}`, { method: "PATCH", body });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(res.data.changed ? success : "Không có thay đổi.");
      done?.();
      router.refresh();
    });

  const onModeChange = (value: Mode) => {
    if (value === group.mode) return;
    if (value === "disabled") send({ action: "set_mode", mode: "disabled" }, `Đã tắt theo dõi nhóm ${group.name}.`);
    else setConfirmMode(value);
  };

  const items = MODE_ITEMS.map((i) => ({ ...i, disabled: (i.value === "interactive" && !group.interactiveAvailable) || (i.value !== "disabled" && i.value !== "interactive" && !consent) }));

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={group.mode} onValueChange={(v) => onModeChange(String(v) as Mode)} items={items} disabled={pending}>
          <SelectTrigger className="w-[170px]" aria-label={`Chế độ theo dõi của ${group.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((i) => (
              <SelectItem key={i.value} value={i.value} disabled={i.disabled}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {consent ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => setWithdrawOpen(true)}>
            Rút lại đồng ý
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => setConsentOpen(true)}>
            Ghi nhận đồng ý
          </Button>
        )}
      </div>
      {!consent && <p className="text-xs text-muted-foreground">Cần ghi nhận đồng ý của nhóm trước khi bật theo dõi.</p>}

      {/* enable monitoring */}
      <Dialog open={confirmMode !== null} onOpenChange={(o) => !o && setConfirmMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bật “{MODE_ITEMS.find((m) => m.value === confirmMode)?.label}” cho nhóm {group.name}?</DialogTitle>
            <DialogDescription>
              {confirmMode === "mention_only"
                ? "Chỉ những tin nhắc tới tài khoản đang kết nối mới được lưu."
                : "Nội dung tin nhắn mới của nhóm sẽ được lưu vào hệ thống (không đồng bộ lịch sử cũ, không tự trả lời)."}{" "}
              Worker trên máy Windows chỉ gửi tin của nhóm có trong ZP_ALLOWED_GROUP_IDS. Thay đổi được ghi vào nhật ký.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmMode(null)} disabled={pending}>
              Hủy
            </Button>
            <Button disabled={pending} onClick={() => confirmMode && send({ action: "set_mode", mode: confirmMode }, `Đã đổi chế độ nhóm ${group.name}.`, () => setConfirmMode(null))}>
              Xác nhận bật
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* record consent */}
      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ghi nhận đồng ý của nhóm {group.name}</DialogTitle>
            <DialogDescription>Chỉ xác nhận khi các thành viên đã được thông báo và đồng ý việc tin nhắn của nhóm được lưu. Bạn là người chịu trách nhiệm cho xác nhận này; nó được ghi vào nhật ký.</DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Cách nhóm đã đồng ý (bắt buộc)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Ví dụ: đã thông báo trong nhóm ngày 24/11, các thành viên đồng ý."
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span>Tôi xác nhận nhóm đã đồng ý.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConsentOpen(false)} disabled={pending}>
              Hủy
            </Button>
            <Button
              disabled={pending || !confirmed || note.trim().length < 3}
              onClick={() =>
                send({ action: "grant_consent", note: note.trim(), confirm: true }, "Đã ghi nhận đồng ý. Bạn có thể bật theo dõi.", () => {
                  setConsentOpen(false);
                  setNote("");
                  setConfirmed(false);
                })
              }
            >
              Ghi nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* withdraw consent */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rút lại đồng ý của nhóm {group.name}?</DialogTitle>
            <DialogDescription>Nhóm sẽ chuyển về “Tắt” ngay: tin mới không được lưu nữa. Tin đã lưu vẫn giữ nguyên.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)} disabled={pending}>
              Hủy
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => send({ action: "withdraw_consent" }, `Đã rút lại đồng ý, nhóm ${group.name} đã tắt.`, () => setWithdrawOpen(false))}>
              Rút lại và tắt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
