// ============================================================
// APP-SHELL-1: per-app navigation (one config per domain — no scattered
// sidebar definitions). Pure; unit tested.
//
// Menu visibility is UX only: every page still enforces its own permission
// server-side, and the proxy still retires the legacy Shopee pages.
// ============================================================
import { hasPermission, type Permission, type Role } from "../auth/permissions.ts";
import type { AppId } from "./registry.ts";

/** Icon keys (mapped to lucide-react in components/app-shell/app-icons.tsx). */
export type NavIconName =
  | "dashboard" | "package-plus" | "history" | "package-search" | "file-text" | "wallet" | "receipt" | "box" | "truck" | "calculator"
  | "shopping-bag" | "trending-up" | "undo" | "scale" | "banknote"
  | "megaphone" | "chart" | "siren" | "bot" | "store" | "heart-pulse"
  | "users" | "bell"
  | "clipboard" | "list-checks" | "lightbulb" | "image" | "video" | "library" | "layout-template" | "target" | "pen" | "calendar"
  | "plug" | "messages" | "search" | "activity" | "send" | "settings";

export interface NavItem {
  title: string;
  /** Path, optionally with a query that makes the item more specific ("?health=ATTENTION") or an in-page anchor ("#…", never "active"). */
  href: string;
  icon: NavIconName;
  permission?: Permission;
  /** shopeeAds = SHOPEE_ADS_ENABLED; legacy = SHOPEE_LEGACY_MODULES_ENABLED (retired modules: hidden while off). */
  flag?: "shopeeAds" | "legacy";
  /** Planned, not built: rendered disabled with "Sắp có", never a link. */
  soon?: boolean;
  /** PA-4: "Sắp có" unless this capability is on for the user (then a normal link). */
  soonUnless?: "aiWeb";
  /** PHASE 05 / 06: hidden unless this capability is on for the user (flag + permission). */
  requires?: "aiSystem" | "aiTasks" | "aiReply";
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const APP_NAV: Record<AppId, NavGroup[]> = {
  accounting: [
    {
      items: [
        { title: "Tổng quan", href: "/dashboard", icon: "dashboard" },
        // PHASE 05 — Central AI System Assistant (AI_SYSTEM_ASSISTANT_ENABLED + ai_system:use)
        { title: "Trợ lý AI", href: "/apps/accounting/assistant", icon: "bot", permission: "ai_system:use", requires: "aiSystem" },
      ],
    },
    {
      label: "Hàng về",
      items: [
        { title: "Nhập hàng", href: "/receipts/new", icon: "package-plus", permission: "receipt:create" },
        { title: "Lịch sử hàng về", href: "/receipts", icon: "history" },
        { title: "Hàng còn phải về", href: "/outstanding", icon: "package-search" },
      ],
    },
    {
      label: "Kế toán",
      items: [
        { title: "Hóa đơn", href: "/invoices", icon: "file-text" },
        { title: "Công nợ NCC", href: "/debts", icon: "wallet" },
        { title: "Lịch sử thanh toán", href: "/payments", icon: "receipt" },
        { title: "Giá vốn", href: "/inventory/costs", icon: "calculator", permission: "cost:view" },
        // Retired Shopee accounting modules (SHOPEE-ADS-0) — only listed if SHOPEE_LEGACY_MODULES_ENABLED is ever on again.
        { title: "Đơn hàng Shopee", href: "/shopee/orders", icon: "shopping-bag", permission: "channel:view", flag: "legacy" },
        { title: "Doanh thu & lợi nhuận", href: "/shopee/analytics/profitability", icon: "trending-up", permission: "channel:view", flag: "legacy" },
        { title: "Hoàn trả", href: "/shopee/returns", icon: "undo", permission: "channel:view", flag: "legacy" },
        { title: "Đối soát", href: "/shopee/payouts", icon: "scale", permission: "channel:view", flag: "legacy" },
        { title: "Dòng tiền", href: "/shopee/analytics/cashflow", icon: "banknote", permission: "channel:view", flag: "legacy" },
      ],
    },
    {
      label: "Danh mục",
      items: [
        { title: "Sản phẩm", href: "/products", icon: "box" },
        { title: "Nhà cung cấp", href: "/suppliers", icon: "truck" },
      ],
    },
  ],
  shopee: [
    { items: [{ title: "Tổng quan", href: "/apps/shopee", icon: "dashboard" }] },
    {
      label: "Phân tích",
      items: [
        { title: "Quảng cáo", href: "/shopee/ads", icon: "megaphone", permission: "channel:view", flag: "shopeeAds" },
        { title: "Phân tích sản phẩm", href: "/shopee/product-analytics", icon: "chart", permission: "channel:view", flag: "shopeeAds" },
        { title: "Sản phẩm cần chú ý", href: "/shopee/product-analytics?health=ATTENTION", icon: "siren", permission: "channel:view", flag: "shopeeAds" },
      ],
    },
    // PA-4: live only with AI_PRODUCT_ANALYST_ENABLED + _WEB_ENABLED for the rollout roles
    { label: "Trợ lý AI", items: [{ title: "Trợ lý phân tích", href: "/apps/shopee/ai", icon: "bot", permission: "channel:view", soonUnless: "aiWeb" }] },
    {
      label: "Kết nối",
      items: [
        { title: "Shop Shopee", href: "/settings/shopee", icon: "store", permission: "channel:manage" },
        { title: "Sức khỏe đồng bộ", href: "/apps/shopee#suc-khoe-dong-bo", icon: "heart-pulse", permission: "channel:view" },
      ],
    },
  ],
  purchasing: [
    { items: [{ title: "Tổng quan", href: "/apps/purchasing", icon: "dashboard" }] },
    {
      label: "Sắp có",
      items: [
        { title: "Kế hoạch mua", href: "/apps/purchasing/plan", icon: "clipboard", soon: true },
        { title: "Nhu cầu nhập", href: "/apps/purchasing/demand", icon: "list-checks", soon: true },
        { title: "Nhà cung cấp", href: "/apps/purchasing/suppliers", icon: "truck", soon: true },
        { title: "Đề xuất đặt hàng", href: "/apps/purchasing/suggestions", icon: "lightbulb", soon: true },
      ],
    },
  ],
  creative: [
    { items: [{ title: "Tổng quan", href: "/apps/creative", icon: "dashboard" }] },
    {
      label: "Sắp có",
      items: [
        { title: "Ảnh", href: "/apps/creative/images", icon: "image", soon: true },
        { title: "Video", href: "/apps/creative/videos", icon: "video", soon: true },
        { title: "Thư viện", href: "/apps/creative/library", icon: "library", soon: true },
        { title: "Templates", href: "/apps/creative/templates", icon: "layout-template", soon: true },
      ],
    },
  ],
  marketing: [
    { items: [{ title: "Tổng quan", href: "/apps/marketing", icon: "dashboard" }] },
    {
      label: "Sắp có",
      items: [
        { title: "Chiến dịch", href: "/apps/marketing/campaigns", icon: "target", soon: true },
        { title: "Nội dung", href: "/apps/marketing/content", icon: "pen", soon: true },
        { title: "Hiệu quả kênh", href: "/apps/marketing/performance", icon: "trending-up", soon: true },
        { title: "Lịch", href: "/apps/marketing/calendar", icon: "calendar", soon: true },
      ],
    },
  ],
  // ZALO PERSONAL Phase 03 — "Trợ lý Zalo AI → Zalo cá nhân". Every page and API
  // re-checks the data scope on the server (owner / grants); the menu is UX only.
  zalo: [
    {
      label: "Zalo cá nhân",
      items: [
        { title: "Tổng quan", href: "/apps/zalo/personal", icon: "dashboard", permission: "zalo_personal:use" },
        { title: "Kết nối", href: "/apps/zalo/personal/connections", icon: "plug", permission: "zalo_personal:use" },
        { title: "Nhóm", href: "/apps/zalo/personal/groups", icon: "users", permission: "zalo_personal:use" },
        { title: "Hội thoại", href: "/apps/zalo/personal/conversations", icon: "messages", permission: "zalo_personal:use" },
        { title: "Tìm tin nhắn", href: "/apps/zalo/personal/search", icon: "search", permission: "zalo_personal:use" },
        { title: "Nhật ký đồng bộ", href: "/apps/zalo/personal/sync", icon: "activity", permission: "zalo_personal:use" },
        // Phase 04 — Ask AI / summaries inside the same data scope (no sending)
        { title: "Hỏi AI", href: "/apps/zalo/personal/ai", icon: "lightbulb", permission: "zalo_personal:ai" },
      ],
    },
    // PHASE 06 — task detection & reminders (AI_TASKS_ENABLED); visibility per task = the source chat's scope
    {
      label: "Công việc",
      items: [
        { title: "Việc cần xác nhận", href: "/apps/zalo/personal/tasks?view=pending", icon: "clipboard", permission: "zalo_personal:use", requires: "aiTasks" },
        { title: "Việc của tôi", href: "/apps/zalo/personal/tasks?view=mine", icon: "list-checks", permission: "zalo_personal:use", requires: "aiTasks" },
        { title: "Quá hạn", href: "/apps/zalo/personal/tasks?view=overdue", icon: "siren", permission: "zalo_personal:use", requires: "aiTasks" },
        { title: "Tất cả công việc", href: "/apps/zalo/personal/tasks", icon: "clipboard", permission: "zalo_personal:use", requires: "aiTasks" },
        { title: "Thông báo", href: "/apps/zalo/personal/notifications", icon: "bell", permission: "zalo_personal:use", requires: "aiTasks" },
        { title: "Lịch sử nhắc việc", href: "/apps/zalo/personal/tasks/reminders", icon: "history", permission: "zalo_personal:use", requires: "aiTasks" },
        { title: "Cài đặt nhắc việc", href: "/apps/zalo/personal/tasks/preferences", icon: "calendar", permission: "zalo_personal:use", requires: "aiTasks" },
      ],
    },
    // PHASE 04.5 — AI replies (PERSONAL_REPLY_ENABLED); drafts / settings re-checked on the server (owner / manage grant)
    {
      label: "Trả lời AI",
      items: [
        { title: "Hộp duyệt trả lời", href: "/apps/zalo/personal/replies", icon: "bot", permission: "zalo_personal:use", requires: "aiReply" },
        { title: "Lịch sử gửi", href: "/apps/zalo/personal/replies/outbound", icon: "send", permission: "zalo_personal:use", requires: "aiReply" },
        { title: "Cài đặt trả lời", href: "/apps/zalo/personal/replies/settings", icon: "settings", permission: "zalo_personal:use", requires: "aiReply" },
      ],
    },
  ],
  system: [
    {
      label: "Quản trị",
      items: [
        { title: "Người dùng", href: "/users", icon: "users", permission: "user:manage" },
        { title: "Cài đặt thông báo", href: "/settings/notifications", icon: "bell", permission: "notification:manage" },
      ],
    },
  ],
};

export interface NavContext {
  role: Role;
  adsEnabled: boolean;
  legacyModulesEnabled: boolean;
  /** PA-4 web assistant available to this user (flags + rollout role) */
  aiWebEnabled?: boolean;
  /** PHASE 05 system assistant available to this user (flag + ai_system:use) */
  aiSystemEnabled?: boolean;
  /** PHASE 06 task engine on (AI_TASKS_ENABLED + Zalo Personal dashboard) */
  aiTasksEnabled?: boolean;
  /** PHASE 04.5 AI replies on (PERSONAL_REPLY_ENABLED + Zalo Personal dashboard) */
  aiReplyEnabled?: boolean;
}

/** The app's nav for this role and these flags; empty groups dropped. */
export function visibleNav(app: AppId, ctx: NavContext): NavGroup[] {
  return APP_NAV[app]
    .map((group) => ({
      ...group,
      items: group.items.map((item) => (item.soonUnless === "aiWeb" ? { ...item, soon: !ctx.aiWebEnabled } : item)).filter(
        (item) =>
          (!item.permission || hasPermission(ctx.role, item.permission)) &&
          (item.requires !== "aiSystem" || !!ctx.aiSystemEnabled) &&
          (item.requires !== "aiTasks" || !!ctx.aiTasksEnabled) &&
          (item.requires !== "aiReply" || !!ctx.aiReplyEnabled) &&
          (item.flag !== "shopeeAds" || ctx.adsEnabled) &&
          (item.flag !== "legacy" || ctx.legacyModulesEnabled),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Exactly one active item: the longest path that equals the URL path or is a
 * parent segment of it; among equal paths, an item whose query matches the
 * URL beats the plain one ("Sản phẩm cần chú ý" vs "Phân tích sản phẩm").
 * Anchor items and "soon" items are never active.
 */
export function activeNavItemHref(groups: readonly NavGroup[], pathname: string, search: string | URLSearchParams = ""): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  let best: { href: string; score: number } | null = null;
  for (const item of groups.flatMap((g) => g.items)) {
    if (item.soon || item.href.includes("#")) continue;
    const [path, query = ""] = item.href.split("?");
    if (!(pathname === path || pathname.startsWith(path.endsWith("/") ? path : `${path}/`))) continue;
    const wanted = [...new URLSearchParams(query)];
    if (!wanted.every(([k, v]) => params.get(k) === v)) continue;
    const score = path.length * 10 + wanted.length;
    if (!best || score > best.score) best = { href: item.href, score };
  }
  return best?.href ?? null;
}

export function navItemByHref(groups: readonly NavGroup[], href: string | null): NavItem | null {
  if (!href) return null;
  return groups.flatMap((g) => g.items).find((i) => i.href === href) ?? null;
}
