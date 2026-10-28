// SHOPEE-ADS-UI-1: dashboard section shell — rounded card on the Ads
// surface, coloured icon chip, title / description / actions, and a small
// entrance stagger (--ads-delay) that plays once on mount.
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";

export function AdsSection({
  id,
  title,
  description,
  icon: Icon,
  iconClass = "bg-ads-primary/12 text-ads-primary",
  actions,
  delay = 0,
  className,
  children,
}: {
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClass?: string;
  actions?: React.ReactNode;
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      data-refresh-dim
      style={{ "--ads-delay": `${delay}ms` } as React.CSSProperties}
      className={cn("animate-ads-rise min-w-0 rounded-2xl border border-ads-border bg-card p-4 transition-opacity duration-(--ads-dur-normal) sm:p-5", className)}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon && (
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", iconClass)}>
              <Icon aria-hidden="true" className="size-4" />
            </span>
          )}
          <div className="min-w-0">
            <h3 id={id ? `${id}-title` : undefined} className="text-base leading-8 font-semibold">
              {title}
            </h3>
            {description && <p className="-mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
