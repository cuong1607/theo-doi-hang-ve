"use client";

// UIUX-1 FilterBar: one toolbar for list filters.
//   • every filter lives in the URL (?status=…); changing one resets page
//   • navigation runs in a transition: the current table STAYS on screen
//     and the toolbar shows "Đang cập nhật…" (refresh ≠ initial load)
//   • "Xóa bộ lọc" when anything is active
//   • mobile: collapsed behind "Bộ lọc (n)"; desktop: one row
import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FilterX, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activeFilterCount } from "@/lib/ui/list-query";

interface FilterNav {
  setParam: (key: string, value: string) => void;
  pending: boolean;
  /** Bumped by "Xóa bộ lọc" so free-text / date inputs reset themselves. */
  resetToken: number;
}

const FilterNavContext = createContext<FilterNav | null>(null);

/** For filter controls inside <FilterBar>: URL updates in a transition. */
export function useFilterNav(): FilterNav {
  const ctx = useContext(FilterNavContext);
  if (!ctx) throw new Error("useFilterNav must be used inside <FilterBar>");
  return ctx;
}

export function FilterBar({ filterKeys, children, className }: { filterKeys: readonly string[]; children: React.ReactNode; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  const query = Object.fromEntries(filterKeys.map((k) => [k, searchParams.get(k) ?? undefined]));
  const active = activeFilterCount(query, filterKeys);

  const navigate = (params: URLSearchParams) => {
    params.delete("page");
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") params.set(key, value);
    else params.delete(key);
    navigate(params);
  };
  const clear = () => {
    const params = new URLSearchParams(searchParams.toString());
    for (const k of filterKeys) params.delete(k);
    setResetToken((t) => t + 1);
    navigate(params);
  };

  return (
    <FilterNavContext.Provider value={{ setParam, pending, resetToken }}>
      <div className={cn("w-full space-y-2", className)} data-slot="filter-bar">
        <div className="flex items-center gap-2 md:hidden">
          <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <SlidersHorizontal /> Bộ lọc{active ? ` (${active})` : ""}
          </Button>
          {pending && <RefreshingHint />}
        </div>
        <div className={cn("flex-wrap items-center gap-2", open ? "flex" : "hidden md:flex")}>
          {children}
          {active > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={clear} className="text-muted-foreground">
              <FilterX /> Xóa bộ lọc
            </Button>
          )}
          {pending && <RefreshingHint className="hidden md:inline-flex" />}
        </div>
      </div>
    </FilterNavContext.Provider>
  );
}

function RefreshingHint({ className }: { className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> Đang cập nhật…
    </span>
  );
}

export type FilterOption = { label: string; value: string };

/** Select bound to one URL param ("all" = no filter). */
export function FilterSelect({ paramKey, value, options, label, className }: { paramKey: string; value: string | undefined; options: FilterOption[]; label: string; className?: string }) {
  const { setParam } = useFilterNav();
  return (
    <Select value={value || "all"} onValueChange={(v) => setParam(paramKey, String(v))} items={options}>
      <SelectTrigger className={cn("w-full sm:w-auto sm:min-w-40", className)} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Date input bound to one URL param (yyyy-MM-dd). */
export function FilterDate({ paramKey, value, label, className }: { paramKey: string; value: string | undefined; label: string; className?: string }) {
  const { setParam, resetToken } = useFilterNav();
  return <Input key={resetToken} type="date" defaultValue={resetToken ? "" : value} onChange={(e) => setParam(paramKey, e.target.value)} aria-label={label} title={label} className={cn("w-full sm:w-[150px]", className)} />;
}

/**
 * Search box: icon, clear button, debounced (400 ms) — the server is queried
 * once typing pauses, not on every keystroke.
 */
export function SearchInput({ paramKey, defaultValue, placeholder, label, className, debounceMs = 400 }: { paramKey: string; defaultValue?: string; placeholder: string; label: string; className?: string; debounceMs?: number }) {
  const { setParam, resetToken } = useFilterNav();
  const [value, setValue] = useState(defaultValue ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Xóa bộ lọc" (and unmount): cancel a pending debounce.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, [resetToken]);
  const [seenToken, setSeenToken] = useState(resetToken);
  if (seenToken !== resetToken) {
    // …and drop the text (state update during render — React's documented "adjust state on prop change" pattern).
    setSeenToken(resetToken);
    setValue("");
  }
  const push = (v: string, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setParam(paramKey, v.trim()), delay);
  };
  return (
    <div className={cn("relative w-full sm:w-52", className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          push(e.target.value, debounceMs);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") push(value, 0);
        }}
        placeholder={placeholder}
        aria-label={label}
        className="pr-8 pl-8"
      />
      {value && (
        <button
          type="button"
          aria-label={`Xóa ô tìm ${label.toLowerCase()}`}
          onClick={() => {
            setValue("");
            push("", 0);
          }}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
