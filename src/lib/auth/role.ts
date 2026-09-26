// Named permission checks used across pages/components. Each one is a thin
// wrapper over the central matrix in ./permissions.ts — add new rules there,
// not here. The role passed in must come from the server-side auth context
// (src/lib/auth/session.ts), never from the client.
import { hasPermission, type Role } from "./permissions.ts";

export type { Role } from "./permissions.ts";

export function canManageSuppliers(role: Role): boolean {
  return hasPermission(role, "supplier:manage");
}

export function canManageProducts(role: Role): boolean {
  return hasPermission(role, "product:manage");
}

export function canCreateReceipts(role: Role): boolean {
  return hasPermission(role, "receipt:create");
}

export function canEditReceipts(role: Role): boolean {
  return hasPermission(role, "receipt:edit");
}

export function canCreateInvoices(role: Role): boolean {
  return hasPermission(role, "invoice:create");
}

export function canEditInvoices(role: Role): boolean {
  return hasPermission(role, "invoice:edit");
}

export function canCreatePayments(role: Role): boolean {
  return hasPermission(role, "payment:create");
}

export function canManageIntegrations(role: Role): boolean {
  return hasPermission(role, "integration:manage");
}

export function canManageNotificationRecipients(role: Role): boolean {
  return hasPermission(role, "notification:manage");
}

export function canManageUsers(role: Role): boolean {
  return hasPermission(role, "user:manage");
}
