"use client";

// ZALO PERSONAL Phase 03 — the connection owner grants / revokes access. The API
// re-checks that the caller owns the connection and that the grantee's role (read
// from the database) may use the module; each change is audited.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/patterns/empty-state";
import { toast } from "@/components/patterns/toast";
import { formatDateTime } from "@/lib/ui/format";

import { callApi } from "./api-client";

export interface GrantItem {
  id: string;
  granteeName: string | null;
  granteeRole: string | null;
  scope: "connection" | "conversation";
  conversationTitle: string | null;
  level: "sync" | "read" | "manage";
  note: string | null;
  grantedAt: string;
  grantedByName: string | null;
}

const LEVEL_LABEL: Record<GrantItem["level"], string> = { sync: "Xem đồng bộ", read: "Xem nhóm & tin nhắn nhóm", manage: "Quản lý nhóm" };
const ROLE_LABEL: Record<string, string> = { admin: "Quản trị", staff: "Nhân viên" };

function SimpleSelect({ value, onChange, items, label }: { value: string; onChange: (v: string) => void; items: { value: string; label: string }[]; label: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(String(v))} items={items}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AccessManager({ connectionId, grants, candidates, conversations }: { connectionId: string; grants: GrantItem[]; candidates: { id: string; name: string; role: string }[]; conversations: { id: string; title: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [grantee, setGrantee] = useState(candidates[0]?.id ?? "");
  const [scope, setScope] = useState<"connection" | "conversation">("connection");
  const [level, setLevel] = useState<GrantItem["level"]>("read");
  const [conversationId, setConversationId] = useState(conversations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [revoking, setRevoking] = useState<GrantItem | null>(null);

  const grant = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await callApi<{ changed: boolean }>(`/api/zalo-personal/connections/${connectionId}/access`, {
        method: "POST",
        body: { granteeUserId: grantee, scope, level: scope === "conversation" ? "read" : level, conversationId: scope === "conversation" ? conversationId : undefined, note: note.trim() || undefined },
      });
      if (!res.ok) return void toast.error(res.message);
      toast.success(res.data.changed ? "Đã cấp quyền." : "Người này đã có đúng quyền đó.");
      setNote("");
      router.refresh();
    });
  };

  const revoke = (g: GrantItem) =>
    startTransition(async () => {
      const res = await callApi<{ changed: boolean }>(`/api/zalo-personal/connections/${connectionId}/access/${g.id}`, { method: "DELETE" });
      if (!res.ok) return void toast.error(res.message);
      toast.success("Đã thu hồi quyền.");
      setRevoking(null);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {grants.length === 0 ? (
        <EmptyState title="Chưa cấp quyền cho ai" description="Chỉ bạn (chủ sở hữu) xem được kết nối này. Quản trị viên khác cũng không xem được nếu bạn không cấp." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Người được cấp</TableHead>
                <TableHead>Phạm vi</TableHead>
                <TableHead>Mức</TableHead>
                <TableHead>Cấp lúc</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <div className="font-medium">{g.granteeName ?? "Người dùng"}</div>
                    <div className="text-xs text-muted-foreground">{ROLE_LABEL[g.granteeRole ?? ""] ?? g.granteeRole}</div>
                  </TableCell>
                  <TableCell>{g.scope === "connection" ? "Toàn kết nối (không gồm chat 1-1)" : `Hội thoại: ${g.conversationTitle ?? "—"}`}</TableCell>
                  <TableCell>{g.scope === "conversation" ? "Xem hội thoại" : LEVEL_LABEL[g.level]}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatDateTime(g.grantedAt)}
                    {g.grantedByName && <div className="text-xs text-muted-foreground">bởi {g.grantedByName}</div>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" disabled={pending} onClick={() => setRevoking(g)}>
                      Thu hồi
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">Không có người dùng nào khác (Quản trị / Nhân viên đang hoạt động) để cấp quyền.</p>
      ) : (
        <form onSubmit={grant} className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Cấp quyền truy cập">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Người dùng</span>
            <SimpleSelect value={grantee} onChange={setGrantee} label="Người dùng" items={candidates.map((c) => ({ value: c.id, label: `${c.name} (${ROLE_LABEL[c.role] ?? c.role})` }))} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Phạm vi</span>
            <SimpleSelect
              value={scope}
              onChange={(v) => setScope(v as "connection" | "conversation")}
              label="Phạm vi"
              items={[
                { value: "connection", label: "Toàn kết nối" },
                ...(conversations.length ? [{ value: "conversation", label: "Một hội thoại" }] : []),
              ]}
            />
          </label>
          {scope === "connection" ? (
            <label className="space-y-1 text-sm">
              <span className="font-medium">Mức quyền</span>
              <SimpleSelect value={level} onChange={(v) => setLevel(v as GrantItem["level"])} label="Mức quyền" items={(Object.keys(LEVEL_LABEL) as GrantItem["level"][]).map((l) => ({ value: l, label: LEVEL_LABEL[l] }))} />
            </label>
          ) : (
            <label className="space-y-1 text-sm">
              <span className="font-medium">Hội thoại</span>
              <SimpleSelect value={conversationId} onChange={setConversationId} label="Hội thoại" items={conversations.map((c) => ({ value: c.id, label: c.title }))} />
            </label>
          )}
          <label className="space-y-1 text-sm">
            <span className="font-medium">Ghi chú (tùy chọn)</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </label>
          <div className="md:col-span-2 xl:col-span-4">
            <Button type="submit" disabled={pending || !grantee || (scope === "conversation" && !conversationId)}>
              Cấp quyền
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">Quyền toàn kết nối không bao giờ gồm chat 1-1 của bạn; muốn chia sẻ một chat 1-1, chọn “Một hội thoại”.</p>
          </div>
        </form>
      )}

      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Thu hồi quyền của {revoking?.granteeName ?? "người dùng"}?</DialogTitle>
            <DialogDescription>Có hiệu lực ngay ở lần tải trang / gọi API kế tiếp. Thao tác được ghi vào nhật ký.</DialogDescription>
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
    </div>
  );
}
