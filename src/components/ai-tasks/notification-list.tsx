"use client";

// PHASE 06 — Web Inbox list: open (marks read) and "mark all read". The server only
// ever touches the session user's own rows.
import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellDot, EyeOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/patterns/toast";
import { callApi } from "@/components/zalo-personal/api-client";
import { cn } from "@/lib/utils";

export interface InboxItem {
  id: string;
  kindLabel: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdLabel: string;
  hidden: boolean;
}

export function NotificationList({ items, unread }: { items: InboxItem[]; unread: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const mark = (body: { ids: string[] } | { all: true }, after?: () => void) =>
    startTransition(async () => {
      const res = await callApi<{ updated: number }>("/api/zalo-personal/notifications/read", { method: "POST", body });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      after?.();
      router.refresh();
    });

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{unread > 0 ? `${unread} thông báo chưa đọc` : "Đã đọc hết"}</p>
        <Button size="sm" variant="outline" disabled={pending || unread === 0} onClick={() => mark({ all: true }, () => toast.success("Đã đánh dấu đã đọc tất cả."))}>
          Đánh dấu đã đọc tất cả
        </Button>
      </div>
      <ul className="grid gap-2">
        {items.map((n) => (
          <li key={n.id} className={cn("rounded-lg border p-3", !n.read && "border-primary/40 bg-primary/5")}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {!n.read && <BellDot aria-label="Chưa đọc" className="size-3.5 text-primary" />}
              <Badge variant="outline">{n.kindLabel}</Badge>
              <span className="tabular-nums">{n.createdLabel}</span>
            </div>
            <div className="mt-1 font-medium">
              {n.hidden && <EyeOff aria-hidden="true" className="mr-1 inline size-4 text-muted-foreground" />}
              {n.link ? (
                <Link href={n.link} className="underline-offset-2 hover:underline" onClick={() => !n.read && mark({ ids: [n.id] })}>
                  {n.title}
                </Link>
              ) : (
                n.title
              )}
            </div>
            {n.body && <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{n.body}</p>}
            {!n.read && !n.link && (
              <Button className="mt-2" size="sm" variant="ghost" disabled={pending} onClick={() => mark({ ids: [n.id] })}>
                Đánh dấu đã đọc
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
