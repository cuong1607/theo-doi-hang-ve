import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEvent } from "../src/event-normalizer.ts";
import { decide, type FilterConfig } from "../src/group-filter.ts";
import type { NormalizedEvent } from "../src/types.ts";
import { GROUP_ALLOWED, GROUP_OTHER, NOW, OWN_ID, rawDirectMessage, rawGroupMessage } from "./helpers.ts";

const TOKEN = "ctb-discover-7f3a9c";
const config: FilterConfig = { allowedGroupIds: new Set([GROUP_ALLOWED]), discoveryToken: TOKEN, directMessages: "metadata" };

function ev(raw: unknown, name: "message" | "group_event" = "message"): NormalizedEvent {
  const r = normalizeEvent(name, raw, { connectionId: "primary", now: NOW });
  assert.ok(r.ok);
  return r.event;
}

describe("group-filter: allowlist", () => {
  it("processes an allowlisted group", () => {
    assert.deepEqual(decide(ev(rawGroupMessage()), config), { action: "process", reason: "allowed_group" });
  });

  it("drops a group that is not allowlisted (new groups default to not monitored)", () => {
    assert.deepEqual(decide(ev(rawGroupMessage({ threadId: GROUP_OTHER })), config), { action: "drop", reason: "group_not_allowed" });
  });

  it("drops every group when the allowlist is empty", () => {
    assert.equal(decide(ev(rawGroupMessage()), { ...config, allowedGroupIds: new Set() }).action, "drop");
  });

  it("drops group signals (group_event) from non-allowlisted groups", () => {
    assert.equal(decide(ev({ type: "join", threadId: GROUP_OTHER, isSelf: false }, "group_event"), config).action, "drop");
    assert.equal(decide(ev({ type: "join", threadId: GROUP_ALLOWED, isSelf: false }, "group_event"), config).action, "process");
  });

  it("self messages in an allowlisted group are processed (flagged isSelf, never answered in Phase 01)", () => {
    const e = ev(rawGroupMessage({ isSelf: true, uidFrom: OWN_ID }));
    assert.equal(decide(e, config).action, "process");
    assert.equal(e.isSelf, true);
  });
});

describe("group-filter: discovery token", () => {
  it("sent by THIS account in an unknown group → discover (id only)", () => {
    assert.deepEqual(decide(ev(rawGroupMessage({ threadId: GROUP_OTHER, isSelf: true, uidFrom: OWN_ID, content: `  ${TOKEN} ` })), config), { action: "discover", groupId: GROUP_OTHER });
  });

  it("typed by ANOTHER member → dropped, never reveals the group", () => {
    assert.deepEqual(decide(ev(rawGroupMessage({ threadId: GROUP_OTHER, content: TOKEN })), config), { action: "drop", reason: "discovery_not_self" });
  });

  it("only an exact match counts", () => {
    assert.equal(decide(ev(rawGroupMessage({ threadId: GROUP_OTHER, isSelf: true, uidFrom: OWN_ID, content: `${TOKEN} nữa` })), config).action, "drop");
  });

  it("discovery off (token null) → the token text is just a normal message", () => {
    const off = { ...config, discoveryToken: null };
    assert.equal(decide(ev(rawGroupMessage({ threadId: GROUP_OTHER, isSelf: true, uidFrom: OWN_ID, content: TOKEN })), off).action, "drop");
  });

  it("the token in an allowlisted group is not processed as content", () => {
    assert.equal(decide(ev(rawGroupMessage({ isSelf: true, uidFrom: OWN_ID, content: TOKEN })), config).action, "discover");
  });
});

describe("group-filter: direct messages", () => {
  it("metadata mode processes direct messages", () => {
    assert.deepEqual(decide(ev(rawDirectMessage()), config), { action: "process", reason: "direct_metadata" });
  });
  it("off mode drops them", () => {
    assert.deepEqual(decide(ev(rawDirectMessage()), { ...config, directMessages: "off" }), { action: "drop", reason: "direct_disabled" });
  });
  it("the discovery token in a direct chat never discovers anything", () => {
    assert.equal(decide(ev(rawDirectMessage({ content: TOKEN, isSelf: true })), config).action, "process");
  });
});
