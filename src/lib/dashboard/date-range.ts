export type RangePreset = "today" | "7d" | "month" | "custom";

export const RANGE_PRESETS: { label: string; value: RangePreset }[] = [
  { label: "Hôm nay", value: "today" },
  { label: "7 ngày", value: "7d" },
  { label: "Tháng này", value: "month" },
  { label: "Tùy chọn", value: "custom" },
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toISODate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isRangePreset(value: string): value is RangePreset {
  return value === "today" || value === "7d" || value === "month" || value === "custom";
}

// Resolves a preset (or explicit custom bounds) into a concrete [from, to]
// date range, computed from the real current date — never hardcoded.
export function resolveDateRange(
  preset: RangePreset,
  customFrom?: string,
  customTo?: string
): { from: string; to: string } {
  const today = new Date();
  const todayStr = toISODate(today);

  switch (preset) {
    case "today":
      return { from: todayStr, to: todayStr };
    case "7d": {
      const from = new Date(today);
      from.setDate(from.getDate() - 6);
      return { from: toISODate(from), to: todayStr };
    }
    case "month": {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      const to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: toISODate(from), to: toISODate(to) };
    }
    case "custom":
      return {
        from: customFrom || todayStr,
        to: customTo || todayStr,
      };
  }
}
