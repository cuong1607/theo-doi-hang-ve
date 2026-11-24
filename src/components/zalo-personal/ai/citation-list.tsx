// ZALO PERSONAL Phase 04 — source messages behind an AI answer. Snippets are UNTRUSTED
// Zalo text: React text nodes only (escaped), never HTML, never linkified. "Mở tin"
// opens the message in the dashboard, where access is checked again.
import Link from "next/link";
import { ExternalLink, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/ui/format";
import type { CitationView } from "@/lib/zalo-personal/ai/service";

export function CitationChips({ citations }: { citations: CitationView[] }) {
  if (citations.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {citations.map((c, i) => (
        <Link key={c.messageId} href={c.href} className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums hover:bg-muted hover:text-foreground" title={`${c.conversationTitle} · ${c.senderLabel} · ${formatDateTime(c.at)}`}>
          nguồn {i + 1}
        </Link>
      ))}
    </span>
  );
}

export function CitationList({ citations, title }: { citations: CitationView[]; title: string }) {
  if (citations.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ol className="space-y-1.5">
        {citations.map((c) => (
          <li key={c.messageId} className="rounded-md border bg-card px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <User aria-hidden="true" className="size-3.5" />
                {c.senderLabel}
              </span>
              <Badge variant="outline">{c.conversationTitle}</Badge>
              <time dateTime={c.at} className="tabular-nums">
                {formatDateTime(c.at)}
              </time>
              <Link href={c.href} className="ml-auto inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                Mở tin
                <ExternalLink aria-hidden="true" className="size-3" />
              </Link>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words">{c.snippet ?? <span className="text-muted-foreground italic">{c.typeLabel}: không có nội dung văn bản.</span>}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
