// Run: node --env-file=.env.local --test src/lib/auth/role.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canManageIntegrations, canManageNotificationRecipients } from "./role.ts";

test("canManageIntegrations: admin only — the gate used by /api/zalo/oauth/start and /api/zalo/test-message", () => {
  assert.equal(canManageIntegrations("admin"), true);
  assert.equal(canManageIntegrations("staff"), false);
  assert.equal(canManageIntegrations("viewer"), false);
});

test("canManageNotificationRecipients: admin only — the gate used by recipient CRUD actions and /api/notifications/test-all (ZL2 test cases 12-14)", () => {
  assert.equal(canManageNotificationRecipients("admin"), true, "case 14: admin quản lý recipient");
  assert.equal(canManageNotificationRecipients("staff"), false, "case 13: staff không quản lý recipient");
  assert.equal(canManageNotificationRecipients("viewer"), false, "case 12: viewer không quản lý recipient");
});
