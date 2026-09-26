// Run: node --test src/lib/auth/permissions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { PERMISSIONS, hasPermission, isRole, type Permission, type Role } from "./permissions.ts";
import { safeNextPath } from "./redirect.ts";

const EXPECTED: Record<Role, Permission[]> = {
  admin: Object.keys(PERMISSIONS) as Permission[],
  staff: [
    "dashboard:view", "receipt:view", "invoice:view", "outstanding:view", "debt:view", "payment:view",
    "product:view", "supplier:view", "receipt:create", "receipt:edit", "invoice:create", "invoice:edit",
    "payment:create",
  ],
  viewer: [
    "dashboard:view", "receipt:view", "invoice:view", "outstanding:view", "debt:view", "payment:view",
    "product:view", "supplier:view",
  ],
};

test("role matrix: each role has exactly the expected permissions", () => {
  for (const role of ["admin", "staff", "viewer"] as Role[]) {
    const granted = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => hasPermission(role, p)).sort();
    assert.deepEqual(granted, [...EXPECTED[role]].sort(), role);
  }
});

test("viewer is read-only: no create/edit/manage permission at all", () => {
  for (const p of Object.keys(PERMISSIONS) as Permission[]) {
    if (!p.endsWith(":view")) assert.equal(hasPermission("viewer", p), false, p);
  }
});

test("staff cannot manage users, notifications, integrations or master data", () => {
  for (const p of ["user:manage", "notification:manage", "integration:manage", "product:manage", "supplier:manage"] as Permission[]) {
    assert.equal(hasPermission("staff", p), false, p);
  }
});

test("no role / unknown role => nothing", () => {
  assert.equal(hasPermission(null, "dashboard:view"), false);
  assert.equal(hasPermission(undefined, "receipt:view"), false);
  assert.equal(isRole("superadmin"), false);
  assert.equal(isRole("admin"), true);
});

test("safeNextPath: only same-origin paths, never auth pages or open redirects", () => {
  assert.equal(safeNextPath("/receipts?from=2026-09-01"), "/receipts?from=2026-09-01");
  assert.equal(safeNextPath(undefined), "/dashboard");
  assert.equal(safeNextPath("https://evil.example"), "/dashboard");
  assert.equal(safeNextPath("//evil.example"), "/dashboard");
  assert.equal(safeNextPath("/\\evil.example"), "/dashboard");
  assert.equal(safeNextPath("/login"), "/dashboard");
  assert.equal(safeNextPath("/account-disabled"), "/dashboard");
});
