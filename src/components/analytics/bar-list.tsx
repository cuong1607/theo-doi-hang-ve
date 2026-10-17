// SHOPEE-8: horizontal bar list (top N / distributions). Server component;
// a bar's length is geometry only, the label + formatted value carry the
// meaning (and "lỗ" text for negatives — never colour alone).
import Link from "next/link";
import { cn } from "cn";

export interface BarItem {
  key: string;
  label: React.ReactNode;
  href?: string;
  /** geometry only */
  magnitude: number;
  value: string;
  sub?: React.ReactNode;
  negative?: boolean;
}

export function BarList({ items, emptyText = "Chưa có dữ liệu." }: { items: BarItem[]; emptyText?: string }) {
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  const max = Math.max(...items.map((i) => Math.abs(i.magnitude)), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {i.href ? (
                <Link href={i.href} className="underline-offset-4 hover:underline">
                  {i.label}
                </Link>
              ) : (
                i.label
              )}
            </span>
            <span className={cn("shrink-0 tabular-nums", i.negative && "text-danger-text")}>
              {i.value}
              {i.negative && <span className="ml-1 text-xs">(lỗ)</span>}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden="true">
            <div className={cn("h-1.5 rounded-full", i.negative ? "bg-danger-text/70" : "bg-primary/70")} style={{ width: `${Math.max(2, (Math.abs(i.magnitude) / max) * 100)}%` }} />
          </div>
          {i.sub && <p className="text-xs text-muted-foreground">{i.sub}</p>}
        </li>
      ))}
    </ul>
  );
}
