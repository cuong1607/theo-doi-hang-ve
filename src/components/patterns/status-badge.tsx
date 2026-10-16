// UIUX-1 StatusBadge: the one status pill of the app. Tone = colour + icon,
// the label is always there (colour is never the only signal).
import { AlertTriangle, CheckCircle2, Circle, Info, Loader2, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "cn";

import { TONE_BADGE_CLASS, type Tone } from "@/lib/ui/status";

const TONE_ICON: Record<Tone, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: Circle,
};

export function StatusBadge({
  tone,
  children,
  icon = true,
  spinning = false,
  className,
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  /** false → text only (dense tables); a custom icon replaces the tone icon. */
  icon?: boolean | LucideIcon;
  /** Live work in progress: the icon spins (Loader2). */
  spinning?: boolean;
  className?: string;
  title?: string;
}) {
  const Icon = spinning ? Loader2 : icon === true ? TONE_ICON[tone] : icon || null;
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      title={title}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap transition-colors duration-200",
        TONE_BADGE_CLASS[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden="true" className={cn("size-3 shrink-0", spinning && "animate-spin", tone === "neutral" && !spinning && "size-2.5")} />}
      {children}
    </span>
  );
}
