// APP-SHELL-1: one launcher card per registry app. Open apps are a single
// focusable link; "Sắp có" / locked apps are inert (no link, not focusable,
// aria-disabled) and visibly different (dashed, muted, badge).
import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";

import type { HubApp } from "@/lib/apps/registry";

import { AppIconTile } from "./app-icons";

export interface HubCardStatus {
  lines: string[];
  tone: "ok" | "warning" | "muted";
}

const DOT: Record<HubCardStatus["tone"], string> = { ok: "bg-success", warning: "bg-warning", muted: "bg-muted-foreground" };
const TONE_WORD: Record<HubCardStatus["tone"], string> = { ok: "bình thường", warning: "cần chú ý", muted: "" };

export function HubCard({ app, status, index }: { app: HubApp; status?: HubCardStatus | null; index: number }) {
  const open = app.access === "open";
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <AppIconTile icon={app.icon} size="lg" />
        {open ? (
          <ArrowRight aria-hidden="true" className="size-5 -translate-x-1 text-app-accent-text opacity-0 transition-all duration-(--ads-dur-normal) group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" />
        ) : app.access === "soon" ? (
          <span className="rounded-full border border-dashed px-2 py-0.5 text-xs font-medium text-muted-foreground">Sắp có</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            <Lock aria-hidden="true" className="size-3" /> Không có quyền
          </span>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-xs font-semibold tracking-wide text-app-accent-text uppercase">{app.subtitle}</p>
        <h2 className="text-lg leading-snug font-semibold">{app.name}</h2>
        <p className="text-sm text-muted-foreground">{app.description}</p>
      </div>
      {open && status && status.lines.length > 0 && (
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground" data-slot="hub-card-status">
          <span aria-hidden="true" className={`size-2 rounded-full ${DOT[status.tone]}`} />
          {TONE_WORD[status.tone] && <span className="sr-only">Trạng thái {TONE_WORD[status.tone]}:</span>}
          {status.lines.map((line, i) => (
            <span key={i} className={i === 0 ? "font-medium text-foreground" : ""}>
              {i > 0 && <span aria-hidden="true">· </span>}
              {line}
            </span>
          ))}
        </div>
      )}
    </>
  );

  // the entrance runs on a wrapper: a finished fill-mode animation would otherwise pin `transform` and cancel the hover lift
  const shared = "flex h-full min-h-44 flex-col gap-4 rounded-2xl border p-5";
  const delay = { "--ads-delay": `${index * 45}ms` } as React.CSSProperties;
  if (!open) {
    return (
      <div className="animate-ads-rise" style={delay}>
        <div data-app={app.accent} data-app-card={app.id} data-access={app.access} aria-disabled="true" className={`${shared} border-dashed bg-muted/30 opacity-75 saturate-50`}>
          {body}
        </div>
      </div>
    );
  }
  return (
    <div className="animate-ads-rise" style={delay}>
      <Link
        href={app.href}
        data-app={app.accent}
        data-app-card={app.id}
        data-access="open"
        className={`${shared} app-card app-wash group outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background`}
      >
        {body}
      </Link>
    </div>
  );
}
