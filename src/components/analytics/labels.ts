// SHOPEE-8 analytics labels (one place).
export const COST_FLAG_LABEL: Record<string, string> = {
  cogs_missing: "thiếu giá vốn",
  no_cost_state: "chưa có giá vốn",
  negative_stock: "tồn âm",
  provisional: "VAT tạm tính",
};

export const bandLabel = (lo: string | number | null, hi: string | number | null) =>
  lo === null ? `< ${hi}%` : hi === null ? `≥ ${lo}%` : `${lo}–${hi}%`;
