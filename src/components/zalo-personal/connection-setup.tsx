"use client";

// ZALO PERSONAL — self-service setup. The user creates a connection THEY own, issues a
// worker credential (the secret is shown ONCE, here, and never again), revokes workers,
// pauses / resumes the connection. Every action is re-authorized on the server and
// audited. Zalo login (QR) is done on the Windows machine — never through this page.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, Loader2, Pause, Play, Plus, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Callout } from "@/components/patterns/callout";
import { toast } from "@/components/patterns/toast";

import { callApi } from "./api-client";

interface Issued {
  workerKey: string;
  connectionKey: string;
  secret: string;
  envLines: string[];
}

const DM_ITEMS = [
  { value: "metadata", label: "Chỉ metadata (không lưu nội dung) — khuyến nghị" },
  { value: "off", label: "Không lưu gì" },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast.error("Không sao chép được, hãy chọn và sao chép thủ công.");
        }
      }}
    >
      {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {done ? "Đã chép" : label}
    </Button>
  );
}

/** The one-time secret + the setup steps for the Windows machine. */
function IssuedDialog({ issued, onClose }: { issued: Issued | null; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  const env = issued?.envLines.join("\n") ?? "";
  return (
    <Dialog open={issued !== null} onOpenChange={(o) => !o && saved && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Đã cấp worker {issued?.workerKey}</DialogTitle>
          <DialogDescription>Làm 3 bước dưới đây trên máy Windows sẽ chạy worker. Secret chỉ hiển thị MỘT lần: đóng hộp thoại này là không xem lại được (khi đó hãy thu hồi và cấp worker mới).</DialogDescription>
        </DialogHeader>
        {issued && (
          <ol className="space-y-4 text-sm">
            <li className="space-y-1.5">
              <p className="font-medium">1. Thêm vào file <code>services/zalo-personal-worker/.env</code></p>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">{env}</pre>
              <CopyButton text={env} label="Chép cấu hình" />
            </li>
            <li className="space-y-1.5">
              <p className="font-medium">2. Nạp secret (được Windows mã hóa bằng DPAPI, không ghi vào .env)</p>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">cd services\zalo-personal-worker{"\n"}npm run ingest:set-secret</pre>
              <p className="text-muted-foreground">Dán secret này khi được hỏi:</p>
              <pre className="overflow-x-auto break-all whitespace-pre-wrap rounded-md border border-warning bg-warning-soft p-3 font-mono text-xs" aria-label="Worker secret">
                {issued.secret}
              </pre>
              <CopyButton text={issued.secret} label="Chép secret" />
            </li>
            <li className="space-y-1.5">
              <p className="font-medium">3. Đăng nhập Zalo và chạy worker</p>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">npm run login    (quét QR bằng app Zalo trên điện thoại){"\n"}npm run build{"\n"}npm run start</pre>
              <p className="text-muted-foreground">Khi worker gửi heartbeat đầu tiên, trang này sẽ hiện tài khoản Zalo đã gắn và trạng thái kết nối.</p>
            </li>
          </ol>
        )}
        <Callout tone="warning">Không gửi secret qua chat / email, không đưa lên Git. Ai có secret này có thể gửi dữ liệu vào kết nối của bạn.</Callout>
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            Tôi đã lưu secret và cấu hình
          </label>
          <Button disabled={!saved} onClick={onClose}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function issue(connectionId: string): Promise<Issued | null> {
  const res = await callApi<Issued>(`/api/zalo-personal/connections/${connectionId}/workers`, { method: "POST" });
  if (!res.ok) {
    toast.error(res.message);
    return null;
  }
  return res.data;
}

export function NewConnectionButton({ disabled, variant = "default" }: { disabled?: boolean; variant?: "default" | "outline" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [directMode, setDirectMode] = useState("metadata");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, startTransition] = useTransition();

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await callApi<{ id: string; key: string }>("/api/zalo-personal/connections", { method: "POST", body: { name: name.trim() || undefined, directMode } });
      if (!res.ok) return void toast.error(res.message);
      setOpen(false);
      setName("");
      toast.success(`Đã tạo kết nối ${res.data.key}.`);
      // step 2 right away: a connection is useless without a worker
      setIssued(await issue(res.data.id));
      router.refresh();
    });
  };

  return (
    <>
      <Button variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        Thêm kết nối Zalo
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={create} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Kết nối tài khoản Zalo cá nhân của bạn</DialogTitle>
              <DialogDescription>Kết nối thuộc về bạn: mặc định không ai khác (kể cả quản trị viên) xem được. Bạn cấp quyền cho người khác sau, nếu muốn.</DialogDescription>
            </DialogHeader>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Tên gợi nhớ (tùy chọn)</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Ví dụ: Zalo bán hàng" autoComplete="off" />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Tin nhắn 1-1</span>
              <Select value={directMode} onValueChange={(v) => setDirectMode(String(v))} items={DM_ITEMS}>
                <SelectTrigger className="w-full" aria-label="Tin nhắn 1-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DM_ITEMS.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              <li>Nhóm mới phát hiện luôn ở chế độ Tắt: chỉ lưu tin sau khi bạn ghi nhận đồng ý và bật theo dõi từng nhóm.</li>
              <li>Hệ thống không tự gửi tin Zalo nào.</li>
              <li>Bước tiếp theo: hệ thống cấp worker và hiện hướng dẫn cài trên máy Windows.</li>
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Hủy
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
                Tạo kết nối
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <IssuedDialog issued={issued} onClose={() => setIssued(null)} />
    </>
  );
}

export function OwnerConnectionActions({ connectionId, connectionKey, status, workers }: { connectionId: string; connectionKey: string; status: "active" | "disabled"; workers: { id: string; workerKey: string; status: "active" | "revoked" }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; workerKey: string } | null>(null);
  const [toggling, setToggling] = useState(false);
  const active = workers.filter((w) => w.status === "active");

  const issueNew = () =>
    startTransition(async () => {
      setIssued(await issue(connectionId));
      router.refresh();
    });
  const revoke = (w: { id: string; workerKey: string }) =>
    startTransition(async () => {
      const res = await callApi<{ changed: boolean }>(`/api/zalo-personal/connections/${connectionId}/workers/${w.id}`, { method: "DELETE" });
      setRevoking(null);
      if (!res.ok) return void toast.error(res.message);
      toast.success(`Đã thu hồi worker ${w.workerKey}.`);
      router.refresh();
    });
  const toggle = () =>
    startTransition(async () => {
      const res = await callApi<{ changed: boolean }>(`/api/zalo-personal/connections/${connectionId}`, { method: "PATCH", body: { status: status === "active" ? "disabled" : "active" } });
      setToggling(false);
      if (!res.ok) return void toast.error(res.message);
      toast.success(status === "active" ? "Đã tạm dừng kết nối." : "Đã bật lại kết nối.");
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={issueNew} disabled={pending || status !== "active" || active.length >= 2}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <KeyRound aria-hidden="true" />}
          {active.length === 0 ? "Cấp worker" : "Cấp worker mới"}
        </Button>
        {active.map((w) => (
          <Button key={w.id} size="sm" variant="outline" onClick={() => setRevoking(w)} disabled={pending}>
            <ShieldOff aria-hidden="true" />
            Thu hồi {w.workerKey}
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={() => setToggling(true)} disabled={pending}>
          {status === "active" ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {status === "active" ? "Tạm dừng kết nối" : "Bật lại kết nối"}
        </Button>
      </div>
      {active.length >= 2 && <p className="text-xs text-muted-foreground">Tối đa 2 worker đang hoạt động: thu hồi bớt để cấp mới.</p>}

      <IssuedDialog issued={issued} onClose={() => setIssued(null)} />
      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Thu hồi worker {revoking?.workerKey}?</DialogTitle>
            <DialogDescription>Mọi request của worker này bị từ chối ngay (403). Dữ liệu đã lưu vẫn còn. Muốn chạy tiếp, cấp worker mới và nạp secret mới trên máy Windows.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)} disabled={pending}>
              Hủy
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => revoking && revoke(revoking)}>
              Thu hồi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={toggling} onOpenChange={setToggling}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{status === "active" ? `Tạm dừng kết nối ${connectionKey}?` : `Bật lại kết nối ${connectionKey}?`}</DialogTitle>
            <DialogDescription>{status === "active" ? "Server sẽ từ chối mọi tin và heartbeat của kết nối này cho tới khi bật lại (worker giữ tin trong outbox và thử lại). Dữ liệu đã lưu vẫn còn." : "Server nhận lại tin và heartbeat từ worker của kết nối này."}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToggling(false)} disabled={pending}>
              Hủy
            </Button>
            <Button variant={status === "active" ? "destructive" : "default"} disabled={pending} onClick={toggle}>
              {status === "active" ? "Tạm dừng" : "Bật lại"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
