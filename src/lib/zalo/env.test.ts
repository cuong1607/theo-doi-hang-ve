// Run: node --env-file=.env.local --test src/lib/zalo/env.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getZaloAppConfig, getAppUrl, ZaloEnvError, getZaloTestRecipientId } from "./env.ts";

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("getZaloAppConfig: throws a clear ZaloEnvError naming the missing var, never a generic crash", () => {
  withEnv({ ZALO_APP_ID: undefined }, () => {
    assert.throws(
      () => getZaloAppConfig(),
      (err: unknown) => {
        assert.ok(err instanceof ZaloEnvError);
        assert.match((err as Error).message, /ZALO_APP_ID/);
        return true;
      }
    );
  });
});

test("getZaloAppConfig: succeeds and never echoes the secret value in any thrown message", () => {
  withEnv({ ZALO_APP_ID: "app123", ZALO_APP_SECRET: "top-secret-value", ZALO_OA_ID: "oa456" }, () => {
    const config = getZaloAppConfig();
    assert.equal(config.appId, "app123");
    assert.equal(config.appSecret, "top-secret-value");
    assert.equal(config.oaId, "oa456");
  });
});

test("getZaloTestRecipientId: throws ZaloEnvError when unset", () => {
  withEnv({ ZALO_TEST_RECIPIENT_ID: undefined }, () => {
    assert.throws(() => getZaloTestRecipientId(), ZaloEnvError);
  });
});

test("getAppUrl: falls back to localhost when APP_URL is unset", () => {
  withEnv({ APP_URL: undefined }, () => {
    assert.equal(getAppUrl(), "http://localhost:3000");
  });
});

test("getAppUrl: returns APP_URL when set", () => {
  withEnv({ APP_URL: "https://theo-doi-hang-ve.vercel.app" }, () => {
    assert.equal(getAppUrl(), "https://theo-doi-hang-ve.vercel.app");
  });
});
