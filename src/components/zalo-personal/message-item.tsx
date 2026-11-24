// ZALO PERSONAL Phase 03 — one Zalo message. Content is UNTRUSTED: it is rendered
// as a React text node only (escaped), never as HTML, never linkified, and no
// URL / attachment is fetched or previewed. Times in Asia/Ho_Chi_Minh.
import Link from "next/link";
import { AtSign, FileQuestion, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/ui/format";
import type { MessageView } from "@/lib/zalo-personal/dashboard/service";

export function MessageItem({ message, showConversation = false }: { message: MessageView; showConversation?: boolean }) {
  const m = message;
  return (
    <li data-slot="zp-message" className={`rounded-lg border px-3 py-2.5 ${m.isSelf ? "border-app-accent-border bg-app-accent-soft/50" : "bg-card"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <User aria-hidden="true" className="size-3.5" />
          {m.senderLabel}
        </span>
        {m.isSelf && <Badge variant="secondary">Tin của bạn</Badge>}
        <Badge variant="outline">{m.typeLabel}</Badge>
        {m.mentionsSelf && (
          <Badge variant="outline" className="gap-1">
            <AtSign aria-hidden="true" className="size-3" />
            Nhắc bạn
          </Badge>
        )}
        <time dateTime={m.at} className="tabular-nums" title={m.sentAt ? "Giờ gửi (Zalo)" : "Giờ worker nhận (Zalo không gửi kèm giờ gửi)"}>
          {formatDateTime(m.at)}
        </time>
        {showConversation && m.conversation && (
          <Link href={`/apps/zalo/personal/conversations/${m.conversation.id}`} className="underline underline-offset-2 hover:text-foreground">
            {m.conversation.title}
          </Link>
        )}
      </div>
      <div className="mt-1.5 text-sm">
        {m.contentState === "stored" && m.text !== null ? (
          // plain text node: React escapes it; whitespace kept, long words wrapped
          <p className="whitespace-pre-wrap break-words">{m.text}</p>
        ) : m.contentState === "not_stored" ? (
          <p className="text-muted-foreground italic">Nội dung không được lưu theo chính sách ({m.textLength} ký tự).</p>
        ) : !m.supported ? (
          <p className="inline-flex items-center gap-1 text-muted-foreground italic">
            <FileQuestion aria-hidden="true" className="size-3.5" />
            Loại tin chưa hỗ trợ hiển thị.
          </p>
        ) : (
          <p className="text-muted-foreground italic">{m.typeLabel}: không có nội dung văn bản (tệp / ảnh không được tải về dashboard).</p>
        )}
      </div>
      {m.mentions.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Nhắc tới: {m.mentions.map((x) => (x.kind === "all" ? "@tất cả" : `@${x.uidMasked ?? "?"}`)).join(", ")}
        </p>
      )}
    </li>
  );
}
