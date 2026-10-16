// UIUX-1 Callout: page-level notice (fixture mode, API not configured,
// scheduler stale, …). Same tones as StatusBadge; icon + text, role per tone.
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "cn";

import { TONE_CALLOUT_CLASS, type Tone } from "@/lib/ui/status";

const ICON: Record<Tone, LucideIcon> = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info, neutral: Info };

export function Callout({
  tone = "info",
  title,
  icon,
  action,
  children,
  className,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const Icon = icon ?? ICON[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm", TONE_CALLOUT_CLASS[tone], className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && "opacity-90")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
