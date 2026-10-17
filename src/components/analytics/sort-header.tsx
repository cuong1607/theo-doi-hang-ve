// SHOPEE-8: server-side sortable column header (?sort=…&dir=asc|desc).
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import Link from "next/link";

export function SortHeader({ label, column, sort, desc, pathname, query }: { label: string; column: string; sort: string; desc: boolean; pathname: string; query: Record<string, string | undefined> }) {
  const active = sort === column;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v && k !== "page" && k !== "sort" && k !== "dir") sp.set(k, v);
  sp.set("sort", column);
  sp.set("dir", active && desc ? "asc" : "desc");
  const Icon = active ? (desc ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <Link href={`${pathname}?${sp}`} className="inline-flex items-center gap-1 hover:text-foreground" aria-sort={active ? (desc ? "descending" : "ascending") : undefined}>
      {label}
      <Icon aria-hidden="true" className={`size-3 ${active ? "" : "opacity-40"}`} />
    </Link>
  );
}
