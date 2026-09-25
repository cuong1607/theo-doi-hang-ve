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

// No time-limited edit window exists yet (e.g. "only within 24h/7 days") —
// per Phase 9A, don't invent one. admin/staff can always edit; viewer never.
export function canEditReceipts(role: Role): boolean {
  return role === "admin" || role === "staff";
}

// Mirrors canCreateReceipts: admin/staff can record supplier invoices,
// viewer is read-only.
export function canCreateInvoices(role: Role): boolean {
  return role === "admin" || role === "staff";
}

// Mirrors canEditReceipts: no time-limited edit window, admin/staff can
// always edit, viewer never. Added in Phase UP3 alongside the edit route.
export function canEditInvoices(role: Role): boolean {
  return role === "admin" || role === "staff";
}

// Mirrors canCreateInvoices: admin/staff can record a payment against
// invoices, viewer can only read debt/payment history (Phase CN3 spec).
export function canCreatePayments(role: Role): boolean {
  return role === "admin" || role === "staff";
}

// Phase ZL1: connecting/testing the Zalo OA integration is a system-level
// config action (like managing suppliers/products) — admin only, unlike the
// day-to-day staff actions above.
export function canManageIntegrations(role: Role): boolean {
  return role === "admin";
}
