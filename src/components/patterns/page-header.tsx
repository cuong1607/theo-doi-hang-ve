// UIUX-1 page layout primitives: every business page starts with the same
// header (title, description, actions, optional meta line such as
// "Cập nhật lần cuối"), and sections use the same title style and spacing.
import { cn } from "cn";

/** Page wrapper: consistent vertical rhythm + a short fade-in (no layout shift). */
export function PageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("animate-page-in space-y-6", className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary action last (right-most on desktop, wraps under the title on mobile). */
  actions?: React.ReactNode;
  /** Small status line under the description (freshness, mode, …). */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 md:flex-row md:items-start md:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        {meta && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-2", className)}>
      <div className="space-y-0.5">
        <h3 className="text-base font-semibold">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
