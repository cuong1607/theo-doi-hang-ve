"use client";

// PHASE 04.5 — reply settings + controls. Every value is enforced by the
// BACKEND (zp_reply_admin + the claim gates); this form only edits them.
//   settings / pause / allowlist / blocks   connection owner
//   emergency stop                          anyone with module access
//   emergency resume                        admin only (server-checked)
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/patterns/toast";
import { callApi } from "@/components/zalo-personal/api-client";

export interface SettingsValue {
  replyMode: "off" | "draft_only" | "auto";
  directEnabled: boolean;
  unlinkedHelp: boolean;
  cooldownSeconds: number;
  perUserPerHour: number;
  perGroupPerHour: number;
  dailySendLimit: number;
  maxPerConversationPerDay: number;
  draftTtlMinutes: number;
}

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (url: string, method: "POST" | "PATCH" | "DELETE", body: unknown, success: string, after?: (data: unknown) => void) =>
    startTransition(async () => {
      const res = await callApi<unknown>(url, { method, body });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(success);
      after?.(res.data);
      router.refresh();
    });
  return { pending, run };
}

const NUMBERS: Array<{ key: keyof SettingsValue; label: string; min: number; max: number; hint: string }> = [
  { key: "cooldownSeconds", label: "Giãn cách mỗi hội thoại (giây)", min: 5, max: 3600, hint: "Không gửi 2 tin vào cùng hội thoại trong khoảng này. Muốn hỏi đáp liên tục thì đặt thấp (5–10 giây)." },
  { key: "perUserPerHour", label: "Tối đa mỗi người hỏi / giờ", min: 1, max: 100, hint: "Áp cho cả câu hỏi nhận vào và tin gửi ra." },
  { key: "perGroupPerHour", label: "Tối đa mỗi nhóm / giờ", min: 1, max: 200, hint: "Tin gửi ra trong một nhóm." },
  { key: "dailySendLimit", label: "Tối đa tin gửi / ngày (kết nối)", min: 1, max: 500, hint: "Tính theo ngày giờ Việt Nam." },
  { key: "maxPerConversationPerDay", label: "Tối đa trả lời / hội thoại / ngày", min: 1, max: 200, hint: "Cả câu hỏi nhận vào và tin gửi ra." },
  { key: "draftTtlMinutes", label: "Hạn của bản nháp (phút)", min: 5, max: 1440, hint: "Quá hạn chưa gửi → hết hạn, không gửi câu trả lời đã lỗi thời." },
];

export function ReplySettingsForm({ connectionId, initial, autoAvailable }: { connectionId: string; initial: SettingsValue; autoAvailable: boolean }) {
  const [v, setV] = useState(initial);
  const { pending, run } = useAction();
  const valid = NUMBERS.every((n) => Number.isInteger(v[n.key] as number) && (v[n.key] as number) >= n.min && (v[n.key] as number) <= n.max);
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Chế độ trả lời</legend>
        {(
          [
            ["off", "Tắt", "Không tạo câu trả lời nào."],
            ["draft_only", "Chỉ bản nháp (mặc định)", "Mọi câu trả lời chờ người duyệt trước khi gửi."],
            ["auto", "Tự động gửi, không cần duyệt", autoAvailable ? "Chat 1-1: trả lời ngay mọi người đã liên kết; người lạ không được trả lời. Nhóm: chỉ nhóm trong danh sách cho phép, ở chế độ Tương tác." : "Đang tắt ở cấp hệ thống (PERSONAL_AUTO_REPLY_ENABLED)."],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="flex items-start gap-3 rounded-lg border p-3">
            <input type="radio" name={`mode-${connectionId}`} className="mt-1" checked={v.replyMode === value} disabled={value === "auto" && !autoAvailable} onChange={() => setV((s) => ({ ...s, replyMode: value }))} />
            <span className="grid gap-0.5">
              <span className="font-medium">{label}</span>
              <span className="text-sm text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-start gap-3 rounded-lg border p-3">
          <input type="checkbox" className="mt-1" checked={v.directEnabled} onChange={(e) => setV((s) => ({ ...s, directEnabled: e.target.checked }))} />
          <span className="grid gap-0.5">
            <span className="font-medium">Trả lời chat 1-1</span>
            <span className="text-sm text-muted-foreground">Cần kết nối lưu nội dung 1-1 (chế độ content).</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border p-3">
          <input type="checkbox" className="mt-1" checked={v.unlinkedHelp} onChange={(e) => setV((s) => ({ ...s, unlinkedHelp: e.target.checked }))} />
          <span className="grid gap-0.5">
            <span className="font-medium">Hướng dẫn liên kết cho người chưa liên kết</span>
            <span className="text-sm text-muted-foreground">Chỉ trong chat 1-1, dạng bản nháp. Không bao giờ trả dữ liệu.</span>
          </span>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {NUMBERS.map((n) => (
          <label key={n.key} className="grid gap-1 text-sm">
            <span className="font-medium">{n.label}</span>
            <Input type="number" min={n.min} max={n.max} value={String(v[n.key])} onChange={(e) => setV((s) => ({ ...s, [n.key]: Number(e.target.value) }))} />
            <span className="text-xs text-muted-foreground">{n.hint}</span>
          </label>
        ))}
      </div>
      <div>
        <Button disabled={pending || !valid} onClick={() => run("/api/zalo-personal/replies/settings", "PATCH", { connectionId, ...v }, "Đã lưu cài đặt trả lời.")}>
          Lưu cài đặt
        </Button>
      </div>
    </div>
  );
}

export function EmergencyControl({ stopped, canResume }: { stopped: boolean; canResume: boolean }) {
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (stopped)
    return canResume ? (
      <Button variant="outline" disabled={pending} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "emergency_resume" }, "Đã gỡ dừng khẩn cấp.")}>
        Gỡ dừng khẩn cấp
      </Button>
    ) : (
      <p className="text-sm text-muted-foreground">Chỉ quản trị viên mới gỡ được dừng khẩn cấp.</p>
    );
  return (
    <>
      <Button variant="destructive" disabled={pending} onClick={() => setOpen(true)}>
        Dừng khẩn cấp mọi gửi tin
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dừng khẩn cấp</DialogTitle>
            <DialogDescription>Mọi kết nối ngừng gửi ngay ở lần kiểm tra kế tiếp của worker. Bản nháp vẫn được tạo và giữ nguyên.</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Lý do (tùy chọn)</span>
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Đóng
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "emergency_stop", ...(note.trim() ? { note: note.trim() } : {}) }, "Đã dừng khẩn cấp.", () => setOpen(false))}>
              Dừng ngay
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function PauseControl({ connectionId, paused }: { connectionId: string; paused: boolean }) {
  const { pending, run } = useAction();
  return paused ? (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "resume_sending", connectionId }, "Đã cho phép gửi lại.")}>
      Cho phép gửi lại
    </Button>
  ) : (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "pause_sending", connectionId }, "Đã tạm dừng gửi cho kết nối này.")}>
      Tạm dừng gửi
    </Button>
  );
}

export function AllowlistToggle({ connectionId, conversationId, allowlisted, available }: { connectionId: string; conversationId: string; allowlisted: boolean; available: boolean }) {
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (allowlisted)
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "disallow_conversation", connectionId, conversationId }, "Đã bỏ khỏi danh sách tự động.")}>
        Bỏ tự động
      </Button>
    );
  return (
    <>
      <Button size="sm" variant="secondary" disabled={pending || !available} onClick={() => setOpen(true)}>
        Cho phép tự động
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cho phép tự động trả lời</DialogTitle>
            <DialogDescription>Chỉ dùng cho hội thoại thử nghiệm đã đồng ý. Ghi rõ ai đồng ý và khi nào (bắt buộc).</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Ghi chú đồng ý</span>
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Đóng
            </Button>
            <Button disabled={pending || note.trim().length < 3} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "allow_conversation", connectionId, conversationId, note: note.trim() }, "Đã thêm vào danh sách tự động.", () => setOpen(false))}>
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function BlockForm({ connectionId }: { connectionId: string }) {
  const { pending, run } = useAction();
  const [uid, setUid] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-sm">
        <span className="font-medium">Zalo ID người gửi (chỉ chữ số)</span>
        <Input value={uid} inputMode="numeric" maxLength={32} onChange={(e) => setUid(e.target.value.replace(/\D/g, ""))} />
      </label>
      <Button size="sm" variant="outline" disabled={pending || !/^\d{1,32}$/.test(uid)} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "block_user", connectionId, externalUserId: uid }, "Đã chặn người gửi. Bản nháp chưa gửi của họ đã bị hủy.", () => setUid(""))}>
        Chặn
      </Button>
    </div>
  );
}

export function UnblockButton({ connectionId, externalUserId }: { connectionId: string; externalUserId: string }) {
  const { pending, run } = useAction();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("/api/zalo-personal/replies/control", "POST", { action: "unblock_user", connectionId, externalUserId }, "Đã bỏ chặn.")}>
      Bỏ chặn
    </Button>
  );
}

export function LinkCodeCard({ identities }: { identities: Array<{ id: string; connectionKey: string; externalLabel: string; linkedAt: string }> }) {
  const { pending, run } = useAction();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  return (
    <div className="grid gap-3 text-sm">
      <p className="text-muted-foreground">
        Mã dùng một lần, hạn 10 phút. Gửi đúng tin <code className="rounded bg-muted px-1">LINK &lt;mã&gt;</code> từ tài khoản Zalo của bạn vào chat 1-1 với tài khoản Zalo đang kết nối. Hệ thống chỉ lưu mã đã băm.
      </p>
      {code ? (
        <div className="rounded-lg border p-3">
          <div className="font-mono text-lg tracking-widest">LINK {code.code}</div>
          <div className="text-xs text-muted-foreground">Hết hạn lúc {new Date(code.expiresAt).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}. Mã chỉ hiển thị một lần.</div>
        </div>
      ) : (
        <div>
          <Button size="sm" disabled={pending} onClick={() => run("/api/zalo-personal/replies/link-code", "POST", {}, "Đã tạo mã liên kết.", (d) => setCode(d as { code: string; expiresAt: string }))}>
            Tạo mã liên kết
          </Button>
        </div>
      )}
      {identities.length > 0 && (
        <ul className="grid gap-1">
          {identities.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
              <span>
                Kết nối <strong>{i.connectionKey}</strong> · Zalo {i.externalLabel}
              </span>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(`/api/zalo-personal/replies/identities/${i.id}`, "DELETE", undefined, "Đã hủy liên kết.")}>
                Hủy liên kết
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
