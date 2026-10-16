// UIUX-1 EmptyState: different words per situation — never one generic box.
//   no-data     nothing exists yet (often with a CTA: "Đồng bộ ngay")
//   no-results  data exists, the filter matched nothing ("Xóa bộ lọc")
import { Inbox, SearchX, type LucideIcon } from "lucide-react";
import { cn } from "cn";

export function EmptyState({
  title,
  description,
  icon,
  variant = "no-data",
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  variant?: "no-data" | "no-results";
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = icon ?? (variant === "no-results" ? SearchX : Inbox);
  return (
    <div data-slot="empty-state" data-variant={variant} className={cn("flex flex-col items-center gap-2 px-4 py-12 text-center", className)}>
      <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted">
        <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
