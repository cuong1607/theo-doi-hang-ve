"use client";

// SHOPEE-8 analytics tabs — carry the period / shop filters between tabs.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "cn";

const TABS = [
  { href: "/shopee/dashboard", label: "Tổng quan" },
  { href: "/shopee/analytics/products", label: "Sản phẩm" },
  { href: "/shopee/analytics/profitability", label: "Lợi nhuận" },
  { href: "/shopee/analytics/returns", label: "Trả hàng" },
  { href: "/shopee/analytics/cashflow", label: "Dòng tiền" },
];
const CARRY = ["period", "from", "to", "shop"];

export function AnalyticsTabs() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const carry = new URLSearchParams();
  for (const k of CARRY) {
    const v = sp.get(k);
    if (v) carry.set(k, v);
  }
  const qs = carry.toString() ? `?${carry}` : "";
  return (
    <nav aria-label="Phân tích Shopee" className="-mx-1 flex gap-1 overflow-x-auto border-b px-1">
      {TABS.map((t) => {
        const active = pathname === t.href || (t.href !== "/shopee/dashboard" && pathname.startsWith(`${t.href}/`));
        return (
          <Link
            key={t.href}
            href={`${t.href}${qs}`}
            aria-current={active ? "page" : undefined}
            className={cn("shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap", active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
