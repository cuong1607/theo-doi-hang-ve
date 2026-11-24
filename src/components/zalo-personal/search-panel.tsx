"use client";

// ZALO PERSONAL Phase 03 — message search. The criteria are POSTed in the body, so
// the search text never appears in the URL / history / server logs. The server
// checks the scope first, caps the window (≤ 92 days) and the results (≤ 100).
import { useState, useTransition } from "react";
import { Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import type { MessageView } from "@/lib/zalo-personal/dashboard/service";

import { callApi } from "./api-client";
import { MessageItem } from "./message-item";

const TYPE_ITEMS = [
  { value: "all", label: "Mọi loại tin" },
  { value: "text", label: "Văn bản" },
  { value: "image", label: "Hình ảnh" },
  { value: "sticker", label: "Sticker" },
  { value: "video", label: "Video" },
  { value: "voice", label: "Tin thoại" },
  { value: "file", label: "Tệp" },
  { value: "link", label: "Liên kết" },
  { value: "location", label: "Vị trí" },
  { value: "other", label: "Loại khác" },
];

export function SearchPanel({ conversations, defaultFrom, defaultTo, maxDays }: { conversations: { id: string; title: string }[]; defaultFrom: string; defaultTo: string; maxDays: number }) {
  const [text, setText] = useState("");
  const [conversationId, setConversationId] = useState("all");
  const [senderId, setSenderId] = useState("");
  const [messageType, setMessageType] = useState("all");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [result, setResult] = useState<{ rows: MessageView[]; truncated: boolean; limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const convItems = [{ value: "all", label: "Mọi hội thoại được phép" }, ...conversations.map((c) => ({ value: c.id, label: c.title }))];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await callApi<{ rows: MessageView[]; truncated: boolean; limit: number }>("/api/zalo-personal/messages/search", {
        method: "POST",
        body: { text: text.trim() || undefined, conversationId: conversationId === "all" ? undefined : conversationId, senderId: senderId.trim() || undefined, messageType: messageType === "all" ? undefined : messageType, from, to, limit: 50 },
      });
      if (!res.ok) {
        setResult(null);
        setError(res.error === "invalid_input" ? `Điều kiện tìm kiếm không hợp lệ: nội dung từ 2 ký tự, mã người gửi là số, khoảng thời gian tối đa ${maxDays} ngày.` : res.message);
        return;
      }
      setResult(res.data);
    });
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Tìm tin nhắn">
        <label className="space-y-1 text-sm md:col-span-2 xl:col-span-3">
          <span className="font-medium">Nội dung</span>
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="Từ khóa trong tin nhắn (để trống: lọc theo điều kiện khác)" autoComplete="off" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Hội thoại</span>
          <Select value={conversationId} onValueChange={(v) => setConversationId(String(v))} items={convItems}>
            <SelectTrigger className="w-full" aria-label="Hội thoại">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {convItems.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Mã người gửi (Zalo ID)</span>
          <Input value={senderId} onChange={(e) => setSenderId(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={32} placeholder="Chỉ số" autoComplete="off" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Loại tin</span>
          <Select value={messageType} onValueChange={(v) => setMessageType(String(v))} items={TYPE_ITEMS}>
            <SelectTrigger className="w-full" aria-label="Loại tin">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_ITEMS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Từ ngày</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Đến ngày</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>
        <div className="flex items-end">
          <Button type="submit" disabled={pending} className="w-full md:w-auto">
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Search aria-hidden="true" />}
            Tìm
          </Button>
        </div>
      </form>
      <p className="text-xs text-muted-foreground">Chỉ tìm trong hội thoại bạn được cấp quyền, tối đa {maxDays} ngày và 50 kết quả mỗi lần. Tin không lưu nội dung chỉ lọc được theo hội thoại, người gửi, loại và thời gian.</p>

      {error && <Callout tone="warning">{error}</Callout>}
      {result &&
        (result.rows.length === 0 ? (
          <EmptyState variant="no-results" title="Không có tin nhắn khớp điều kiện" description="Thử bỏ bớt điều kiện hoặc mở rộng khoảng thời gian." />
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {result.rows.length} kết quả{result.truncated ? ` (đã giới hạn ${result.limit} — thu hẹp điều kiện để xem chính xác hơn)` : ""}
            </p>
            <ol className="space-y-2">
              {result.rows.map((m) => (
                <MessageItem key={m.id} message={m} showConversation />
              ))}
            </ol>
          </div>
        ))}
    </div>
  );
}
