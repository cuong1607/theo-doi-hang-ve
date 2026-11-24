// ============================================================
// APP-SHELL-1: the ONE app registry. The App Hub cards, the app switcher,
// each shell's identity (name, icon, accent) and the URL → app mapping all
// read from here — no app is hardcoded anywhere else.
//
// Pure (no I/O, no "@/" imports): used by server layouts, client components
// and `node --test`. The URL is the source of truth for the current app
// (appForPath); nothing is stored in cookies / local storage.
// ============================================================
import { hasPermission, type Permission, type Role } from "../auth/permissions.ts";
import { LEGACY_SHOPEE_PAGE_PREFIXES } from "../feature-flags.ts";

export type AppId = "accounting" | "shopee" | "purchasing" | "creative" | "marketing" | "zalo" | "system";

/** Icon keys (mapped to lucide-react in components/app-shell/app-icons.tsx). */
export type AppIconName = "warehouse" | "store-chart" | "shopping-cart" | "palette" | "megaphone" | "message-circle" | "settings";

export interface AppDefinition {
  id: AppId;
  name: string;
  subtitle: string;
  description: string;
  icon: AppIconName;
  /** data-app value → accent tokens in globals.css (--app-accent, --app-accent-2, …). */
  accent: AppId;
  /** Where the hub card / switcher sends people (the app's landing). */
  href: string;
  /** false = "Sắp có": the card and switcher entry never navigate. */
  enabled: boolean;
  /** App-level access. Feature permissions inside the app still apply per page. */
  permission: Permission;
  /** Without access: hide the card (internal apps) or show it locked. */
  whenDenied: "hide" | "locked";
  /** Small trusted live status on the hub card (null = none, never invented). */
  statusSource: "shopee-connections" | null;
  /** URL prefixes owned by this app (segment match, longest wins). */
  routePrefixes: readonly string[];
}

export const APP_REGISTRY: readonly AppDefinition[] = [
  {
    id: "accounting",
    name: "Theo dõi hàng về",
    subtitle: "Kế toán & vận hành",
    description: "Hàng về, hóa đơn, công nợ nhà cung cấp, giá vốn và thanh toán.",
    icon: "warehouse",
    accent: "accounting",
    href: "/dashboard",
    enabled: true,
    permission: "app:accounting",
    whenDenied: "locked",
    statusSource: null,
    routePrefixes: ["/apps/accounting", "/dashboard", "/receipts", "/invoices", "/outstanding", "/debts", "/payments", "/products", "/suppliers", "/inventory", ...LEGACY_SHOPEE_PAGE_PREFIXES],
  },
  {
    id: "shopee",
    name: "Phân tích Shopee",
    subtitle: "Marketplace Intelligence",
    description: "Quảng cáo, phân tích sản phẩm, tín hiệu sức khỏe và trợ lý AI.",
    icon: "store-chart",
    accent: "shopee",
    href: "/apps/shopee",
    enabled: true,
    permission: "app:shopee",
    whenDenied: "locked",
    statusSource: "shopee-connections",
    routePrefixes: ["/apps/shopee", "/shopee/ads", "/shopee/product-analytics", "/settings/shopee", "/settings/zalo-agent"],
  },
  {
    id: "purchasing",
    name: "Gọi hàng",
    subtitle: "Purchasing",
    description: "Kế hoạch nhập hàng, nhu cầu mua và nhà cung cấp.",
    icon: "shopping-cart",
    accent: "purchasing",
    href: "/apps/purchasing",
    enabled: false,
    permission: "app:purchasing",
    whenDenied: "hide",
    statusSource: null,
    routePrefixes: ["/apps/purchasing"],
  },
  {
    id: "creative",
    name: "Thiết kế ảnh & video",
    subtitle: "Creative Studio",
    description: "Thiết kế nội dung hình ảnh, video và tài nguyên bán hàng.",
    icon: "palette",
    accent: "creative",
    href: "/apps/creative",
    enabled: false,
    permission: "app:creative",
    whenDenied: "hide",
    statusSource: null,
    routePrefixes: ["/apps/creative"],
  },
  {
    id: "marketing",
    name: "Marketing",
    subtitle: "Growth & Campaigns",
    description: "Nội dung, chiến dịch, hiệu quả kênh và tăng trưởng.",
    icon: "megaphone",
    accent: "marketing",
    href: "/apps/marketing",
    enabled: false,
    permission: "app:marketing",
    whenDenied: "hide",
    statusSource: null,
    routePrefixes: ["/apps/marketing"],
  },
  {
    // ZALO PERSONAL Phase 03. Hidden unless ZALO_PERSONAL_DASHBOARD_ENABLED, the role
    // may use it (admin / staff) AND the user owns a connection or holds a grant
    // (data gate passed to hubApps by the server, see app-shell.tsx).
    id: "zalo",
    name: "Trợ lý Zalo AI",
    subtitle: "Zalo cá nhân",
    description: "Kết nối Zalo cá nhân, nhóm được phép theo dõi, lịch sử hội thoại và trạng thái đồng bộ.",
    icon: "message-circle",
    accent: "zalo",
    href: "/apps/zalo/personal",
    enabled: true,
    permission: "app:zalo",
    whenDenied: "hide",
    statusSource: null,
    routePrefixes: ["/apps/zalo"],
  },
  {
    id: "system",
    name: "Quản trị hệ thống",
    subtitle: "Người dùng & thông báo",
    description: "Tài khoản người dùng, phân quyền và cài đặt thông báo Zalo.",
    icon: "settings",
    accent: "system",
    href: "/users",
    enabled: true,
    permission: "app:system",
    whenDenied: "hide",
    statusSource: null,
    routePrefixes: ["/apps/system", "/users", "/settings/notifications"],
  },
] as const;

export const APP_HUB_PATH = "/apps";

export function getApp(id: AppId): AppDefinition {
  const app = APP_REGISTRY.find((a) => a.id === id);
  if (!app) throw new Error(`unknown app ${id}`);
  return app;
}

export function canAccessApp(role: Role | null | undefined, id: AppId): boolean {
  return hasPermission(role, getApp(id).permission);
}

export type HubApp = AppDefinition & { access: "open" | "soon" | "locked" };

/**
 * Apps as the hub / switcher shows them to this role, in registry order:
 * open (navigates), soon (visible, never navigates), locked (visible, no
 * access). Apps with whenDenied "hide" are left out without access.
 */
export function hubApps(role: Role | null | undefined, dataGates: Partial<Record<AppId, boolean>> = {}): HubApp[] {
  const out: HubApp[] = [];
  for (const app of APP_REGISTRY) {
    // dataGates: server-computed, data-dependent access (false = no access even if the role allows it)
    const allowed = canAccessApp(role, app.id) && dataGates[app.id] !== false;
    if (!allowed && app.whenDenied === "hide") continue;
    out.push({ ...app, access: !allowed ? "locked" : app.enabled ? "open" : "soon" });
  }
  return out;
}

const segmentMatch = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Which app owns a URL (longest prefix wins); null for the hub and shared pages (/forbidden). */
export function appForPath(pathname: string): AppId | null {
  let best: { id: AppId; len: number } | null = null;
  for (const app of APP_REGISTRY) {
    for (const prefix of app.routePrefixes) {
      if (segmentMatch(pathname, prefix) && (!best || prefix.length > best.len)) best = { id: app.id, len: prefix.length };
    }
  }
  return best?.id ?? null;
}
