export type Role = "admin" | "staff" | "viewer";

const ROLES: readonly Role[] = ["admin", "staff", "viewer"];

function isRole(value: string | undefined): value is Role {
  return !!value && (ROLES as readonly string[]).includes(value);
}

// Temporary stand-in until Phase 5 (Authentication) resolves the role from the
// logged-in session. Reads NEXT_PUBLIC_MOCK_ROLE so permission UI/logic can be
// exercised for admin/staff/viewer before real auth exists.
export function getCurrentRole(): Role {
  const raw = process.env.NEXT_PUBLIC_MOCK_ROLE;
  return isRole(raw) ? raw : "admin";
}

export function canManageSuppliers(role: Role): boolean {
  return role === "admin";
}

export function canManageProducts(role: Role): boolean {
  return role === "admin";
}

export function canCreateReceipts(role: Role): boolean {
  return role === "admin" || role === "staff";
}
