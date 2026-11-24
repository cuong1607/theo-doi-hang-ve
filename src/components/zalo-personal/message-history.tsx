"use client";

// ZALO PERSONAL Phase 03 — message history with "Tải thêm tin cũ hơn": one bounded page
// per click (keyset cursor), never the whole history; nothing loads automatically.
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/patterns/toast";
import type { MessageView } from "@/lib/zalo-personal/dashboard/service";

import { callApi } from "./api-client";
import { MessageItem } from "./message-item";

type Cursor = { beforeAt: string; beforeId: string } | null;

export function MessageHistory({ conversationId, initial, initialCursor, pageSize }: { conversationId: string; initial: MessageView[]; initialCursor: Cursor; pageSize: number }) {
  const [messages, setMessages] = useState(initial);
  const [cursor, setCursor] = useState<Cursor>(initialCursor);
  const [pending, startTransition] = useTransition();

  const loadMore = () =>
    cursor &&
    startTransition(async () => {
      const qs = new URLSearchParams({ beforeAt: cursor.beforeAt, beforeId: cursor.beforeId, limit: String(pageSize) });
      const res = await callApi<{ rows: MessageView[]; nextCursor: Cursor }>(`/api/zalo-personal/conversations/${conversationId}/messages?${qs}`);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      setMessages((prev) => [...prev, ...res.data.rows.filter((m) => !prev.some((p) => p.id === m.id))]);
      setCursor(res.data.nextCursor);
    });

  return (
    <div className="space-y-3">
      <ol className="space-y-2" aria-label="Tin nhắn, mới nhất trước">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </ol>
      <div className="flex flex-col items-center gap-1 pt-2 text-xs text-muted-foreground">
        {cursor ? (
          <Button variant="outline" size="sm" onClick={loadMore} disabled={pending}>
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            Tải thêm {pageSize} tin cũ hơn
          </Button>
        ) : (
          <p>Đã hiển thị hết tin đã lưu. Hệ thống không có tin trước thời điểm worker bắt đầu nhận tin.</p>
        )}
        <p>Đang hiển thị {messages.length} tin.</p>
      </div>
    </div>
  );
}
