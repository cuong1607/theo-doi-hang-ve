// UIUX-1: list-page URL state (pure — unit tested). page / size / filters
// live in the query string so refresh, back button and sharing keep the view.

/** Page-size options for list pages (DataTablePagination). */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/** Parses ?size= safely: only the allowed options, else the default. */
export function parsePageSize(raw: string | string[] | undefined, fallback: PageSize = DEFAULT_PAGE_SIZE): PageSize {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? (n as PageSize) : fallback;
}

/** Parses ?page= (≥ 1); clamped to the last page when totalPages is given. */
export function parsePage(raw: string | string[] | undefined, totalPages?: number): number {
  const n = Math.floor(Number(Array.isArray(raw) ? raw[0] : raw));
  const page = Number.isFinite(n) && n >= 1 ? n : 1;
  return totalPages !== undefined ? Math.min(page, Math.max(1, totalPages)) : page;
}

/** "Hiển thị 26–50 / 1.234" range for the pagination footer. */
export function pageRange(page: number, pageSize: number, total: number): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 };
  const from = (page - 1) * pageSize + 1;
  return { from: Math.min(from, total), to: Math.min(page * pageSize, total) };
}

/**
 * List URL from the current query + overrides: empty / "all" values dropped,
 * page 1 and the default size omitted (clean, shareable URLs).
 */
export function buildListHref(pathname: string, current: Record<string, string | undefined>, overrides: Record<string, string | number | undefined> = {}): string {
  const sp = new URLSearchParams();
  const merged: Record<string, string | number | undefined> = { ...current, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || v === "all") continue;
    if (k === "page" && Number(v) <= 1) continue;
    if (k === "size" && Number(v) === DEFAULT_PAGE_SIZE) continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Number of active filters among `keys` (for "Bộ lọc (3)" / "Xóa bộ lọc"). */
export function activeFilterCount(query: Record<string, string | undefined>, keys: readonly string[]): number {
  return keys.filter((k) => {
    const v = query[k];
    return v !== undefined && v !== "" && v !== "all";
  }).length;
}
