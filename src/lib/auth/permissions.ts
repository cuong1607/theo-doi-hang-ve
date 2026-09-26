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

  // Day-to-day operations — admin + staff.
  "receipt:create": OPERATORS,
  "receipt:edit": OPERATORS,
  "invoice:create": OPERATORS, // includes "create invoice from receipt history"
  "invoice:edit": OPERATORS,
  "payment:create": OPERATORS,

  // Master data + system administration — admin only.
  "product:manage": ADMIN,
  "supplier:manage": ADMIN,
  "user:manage": ADMIN,
  "notification:manage": ADMIN, // recipients, retry, test sends, report sends
  "integration:manage": ADMIN, // Zalo OA connect / test message
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
