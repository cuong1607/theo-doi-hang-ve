// UIUX-1 DataTablePagination: "Hiển thị 26–50 / 1.234", rows per page
// (25 / 50 / 100) and prev/next — all plain links that keep every filter in
// the URL (refresh, back button and sharing keep the view). Server-side
// paging only: never fetches all rows.
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

import { LinkPendingHint } from "./link-pending-hint";
import { buildListHref, pageRange, PAGE_SIZE_OPTIONS } from "@/lib/ui/list-query";

export function DataTablePagination({
  pathname,
  query,
  page,
  pageSize,
  total,
  sizeOptions = true,
}: {
  pathname: string;
  /** Current filters (without page / size). */
  query: Record<string, string | undefined>;
  page: number;
  pageSize: number;
  total: number;
  sizeOptions?: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const { from, to } = pageRange(page, pageSize, total);
  const href = (p: number, size = pageSize) => buildListHref(pathname, query, { page: p, size });
  const nav = (target: number, disabled: boolean, label: string, icon: React.ReactNode, iconAfter = false) =>
    disabled ? (
      <Button variant="outline" size="sm" disabled aria-label={label}>
        {!iconAfter && icon}
        <span className="hidden sm:inline">{label}</span>
        {iconAfter && icon}
      </Button>
    ) : (
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href={href(target)} scroll={false} aria-label={label} />}>
        {!iconAfter && icon}
        <span className="hidden sm:inline">{label}</span>
        {iconAfter && icon}
        <LinkPendingHint className="ml-0" />
      </Button>
    );

  return (
    <nav aria-label="Phân trang" className="flex flex-col gap-3 pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground tabular-nums">
        {total === 0 ? "Không có dòng nào" : `Hiển thị ${from.toLocaleString("vi-VN")}–${to.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")}`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {sizeOptions && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="mr-1 hidden md:inline">Số dòng:</span>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <Link
                key={size}
                href={href(1, size)}
                scroll={false}
                aria-current={size === pageSize ? "true" : undefined}
                className={cn(
                  "rounded-md px-2 py-0.5 tabular-nums transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  size === pageSize && "bg-accent font-medium text-accent-foreground",
                )}
              >
                {size}
              </Link>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          {nav(page - 1, page <= 1, "Trước", <ChevronLeft />)}
          <span className="tabular-nums text-muted-foreground">
            Trang {page} / {totalPages}
          </span>
          {nav(page + 1, page >= totalPages, "Sau", <ChevronRight />, true)}
        </div>
      </div>
    </nav>
  );
}
