// Run: node --env-file=.env.local --test src/lib/auth/role.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canManageIntegrations } from "./role.ts";

test("canManageIntegrations: admin only — the gate used by /api/zalo/oauth/start and /api/zalo/test-message", () => {
  assert.equal(canManageIntegrations("admin"), true);
  assert.equal(canManageIntegrations("staff"), false);
  assert.equal(canManageIntegrations("viewer"), false);
});
