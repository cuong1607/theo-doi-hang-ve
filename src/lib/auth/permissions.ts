// ============================================================
// PHASE AUTHENTICATION AND AUTHORIZATION — the single permission matrix.
//
// Pure (no I/O, no "@/" imports): safe for client components (UI
// visibility only) and unit-testable with `node --test`. The SERVER is
// what enforces it — every page, server action and route handler goes
// through src/lib/auth/session.ts, which loads the role from the database,
// never from the client.
// ============================================================

export type Role = "admin" | "staff" | "viewer";

export const ROLES: readonly Role[] = ["admin", "staff", "viewer"];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Quản trị",
  staff: "Nhân viên",
  viewer: "Chỉ xem",
};

const ALL: readonly Role[] = ROLES;
const OPERATORS: readonly Role[] = ["admin", "staff"];
const ADMIN: readonly Role[] = ["admin"];

export const PERMISSIONS = {
  // Read access to business screens — every active role.
  "dashboard:view": ALL,
  "receipt:view": ALL,
  "invoice:view": ALL,
  "outstanding:view": ALL,
  "debt:view": ALL,
  "payment:view": ALL,
  "product:view": ALL,
  "supplier:view": ALL,
  "channel:view": ALL, // sales-channel data (Shopee shops, orders, financials)
  "cost:view": ALL, // inventory cost ledger / moving average (read-only audit)

  // Day-to-day operations — admin + staff.
  "receipt:create": OPERATORS,
  "receipt:edit": OPERATORS,
  "invoice:create": OPERATORS, // includes "create invoice from receipt history"
  "invoice:edit": OPERATORS,
  "payment:create": OPERATORS,
  "channel:map": OPERATORS, // map / unmap a Shopee variation to an internal SKU
  "channel:sync": OPERATORS, // request a normal (incremental) Shopee sync — enqueue only, never inline
  "return:receive": OPERATORS, // SHOPEE-6B: "Đã nhận" on a delivered return package (operational only — no stock, no cost, no money)

  // Master data + system administration — admin only.
  "product:manage": ADMIN,
  "supplier:manage": ADMIN,
  "user:manage": ADMIN,
  "notification:manage": ADMIN, // recipients, retry, test sends, report sends
  "integration:manage": ADMIN, // Zalo OA connect / test message
  "channel:manage": ADMIN, // shops, connections/tokens, sync config, backfill / repair / retry / cancel sync jobs
  "cost:manage": ADMIN, // rebuild cost ledger, backfill order COGS
  "return:disposition": ADMIN, // SHOPEE-6: return disposition (restock moves stock + reverses COGS → profit)
  "payout:reconcile": ADMIN, // SHOPEE-7: payout reconciliation notes / mismatch resolution (never changes amounts)

  // ZALO PERSONAL Phase 03: may use the Zalo Personal dashboard at all. Only a
  // NECESSARY condition — what is visible comes from data: the connection owner
  // sees their own connection, everyone else (admin included) only what the
  // owner granted in zalo_personal_access_grants (src/lib/zalo-personal/dashboard/access.ts).
  "zalo_personal:use": OPERATORS,

  // APP-SHELL-1: app-level access (which workspaces a role may enter). Navigation
  // only — every page inside still checks its own feature permission, and shop
  // scope is unchanged. Mapped so no existing role loses a screen it had.
  "app:accounting": ALL,
  "app:shopee": ALL, // = channel:view
  "app:purchasing": ALL,
  "app:creative": ALL,
  "app:marketing": ALL,
  "app:system": ADMIN, // users + notification settings were admin-only already
  "app:zalo": OPERATORS, // ZALO PERSONAL Phase 03 — "Trợ lý Zalo AI"; hidden unless the user also owns a connection or holds a grant
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
