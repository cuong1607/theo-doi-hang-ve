// UIUX-1 navigation helpers (pure — unit tested): which sidebar item is
// active, and the header title / breadcrumb for a path.

/** Longest href that equals the path or is a parent segment of it; null when none. */
export function activeNavHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const match = pathname === href || pathname.startsWith(href.endsWith("/") ? href : `${href}/`);
    if (match && (!best || href.length > best.length)) best = href;
  }
  return best;
}

/** Header titles: the longest matching prefix wins (detail pages inherit their list's section). */
export const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Tổng quan",
  "/receipts": "Lịch sử hàng về",
  "/receipts/new": "Nhập hàng",
  "/receipts/daily": "Chi tiết hàng về theo ngày",
  "/invoices": "Hóa đơn",
  "/invoices/new": "Tạo hóa đơn mới",
  "/outstanding": "Theo dõi hàng còn phải về",
  "/debts": "Công nợ NCC",
  "/payments": "Lịch sử thanh toán",
  "/products": "Sản phẩm",
  "/suppliers": "Nhà cung cấp",
  "/inventory/costs": "Giá vốn",
  "/shopee/products": "Sản phẩm Shopee",
  "/shopee/orders": "Đơn hàng Shopee",
  "/shopee/sync": "Đồng bộ Shopee",
  "/users": "Người dùng",
  "/settings/notifications": "Cài đặt thông báo",
  "/settings/shopee": "Tích hợp Shopee",
};

export function pageTitleFor(pathname: string, fallback: string): string {
  const href = activeNavHref(pathname, Object.keys(PAGE_TITLES));
  return href ? PAGE_TITLES[href] : fallback;
}
