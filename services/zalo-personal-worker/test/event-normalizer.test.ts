import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyMessage, dedupeKey, MAX_TEXT_LENGTH, normalizeEvent, parseProviderTimestamp } from "../src/event-normalizer.ts";
import type { NormalizedMessage } from "../src/types.ts";
import { FRIEND, GROUP_ALLOWED, NOW, OWN_ID, rawDirectMessage, rawGroupMessage } from "./helpers.ts";

const ctx = { connectionId: "primary", now: NOW };

function message(raw: unknown): NormalizedMessage {
  const r = normalizeEvent("message", raw, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.ok && r.event.kind === "message");
  return r.event as NormalizedMessage;
}

describe("event-normalizer: messages", () => {
  it("normalizes a group text message with every required field", () => {
    const m = message(rawGroupMessage());
    assert.equal(m.channel, "zalo_personal");
    assert.equal(m.connectionId, "primary");
    assert.equal(m.conversationId, GROUP_ALLOWED);
    assert.equal(m.conversationType, "group");
    assert.equal(m.externalMessageId, "7000000000001");
    assert.equal(m.senderExternalId, FRIEND);
    assert.equal(m.text, "xin chào nhóm");
    assert.equal(m.messageType, "text");
    assert.deepEqual(m.mentions, []);
    assert.equal(m.isSelf, false);
    assert.equal(m.sentAt?.getTime(), NOW.getTime() - 1500);
    assert.equal(m.receivedAt, NOW);
    assert.deepEqual(m.issues, []);
  });

  it("normalizes a direct message (conversationId = the other person)", () => {
    const m = message(rawDirectMessage());
    assert.equal(m.conversationType, "direct");
    assert.equal(m.conversationId, FRIEND);
  });

  it("keeps isSelf from the library for messages sent by this account", () => {
    const m = message(rawDirectMessage({ isSelf: true }));
    assert.equal(m.isSelf, true);
    assert.equal(m.senderExternalId, OWN_ID);
    assert.equal(message(rawGroupMessage({ isSelf: true, uidFrom: OWN_ID })).isSelf, true);
  });

  it("isSelf is strictly boolean true (a truthy string is not self)", () => {
    const raw = { ...rawGroupMessage(), isSelf: "true" };
    assert.equal(message(raw).isSelf, false);
  });

  it("parses mentions (UID based) and ignores invalid ones", () => {
    const text = "@Bot hỏi chút @Ai";
    const m = message(
      rawGroupMessage({
        content: text,
        mentions: [
          { uid: OWN_ID, pos: 0, len: 4, type: 0 },
          { uid: "-1", pos: 0, len: 4, type: 1 },
          { uid: FRIEND, pos: 99, len: 4, type: 0 },
          { uid: FRIEND, pos: 14, len: 3, type: 1 },
          "garbage",
        ],
      }),
    );
    assert.deepEqual(m.mentions, [
      { uid: OWN_ID, pos: 0, len: 4, kind: "user" },
      { uid: FRIEND, pos: 14, len: 3, kind: "all" },
    ]);
  });

  it("non-text content → text null, typed by msgType", () => {
    const m = message(rawGroupMessage({ content: { title: "", href: "https://x" }, msgType: "chat.photo" }));
    assert.equal(m.text, null);
    assert.equal(m.messageType, "image");
    assert.deepEqual(m.mentions, []);
  });

  it("truncates very long text and records the issue", () => {
    const m = message(rawGroupMessage({ content: "a".repeat(MAX_TEXT_LENGTH + 10) }));
    assert.equal(m.text?.length, MAX_TEXT_LENGTH);
    assert.ok(m.issues.includes("text_truncated"));
  });

  it("invalid / missing timestamp → sentAt null + issue, message still accepted", () => {
    for (const ts of [undefined, "", "abc", "123", String(Date.UTC(2010, 0, 1)), String(NOW.getTime() + 3 * 86_400_000)]) {
      const m = message(rawGroupMessage({ ts }));
      assert.equal(m.sentAt, null, `ts=${String(ts)}`);
      assert.ok(m.issues.includes("invalid_timestamp"));
    }
  });

  it("accepts second-based timestamps", () => {
    const secs = String(Math.floor(NOW.getTime() / 1000));
    assert.equal(parseProviderTimestamp(secs, NOW)?.getTime(), Math.floor(NOW.getTime() / 1000) * 1000);
  });
});

describe("event-normalizer: rejections", () => {
  const cases: Array<[string, unknown, string]> = [
    ["null", null, "malformed"],
    ["array", [], "malformed"],
    ["no data", { type: 1, threadId: GROUP_ALLOWED }, "malformed"],
    ["unknown thread type", { ...rawGroupMessage(), type: 7 }, "unsupported_event"],
    ["missing thread id", { ...rawGroupMessage(), threadId: undefined }, "missing_thread_id"],
    ["non-numeric thread id", { ...rawGroupMessage(), threadId: "abc" }, "invalid_thread_id"],
    ["zero thread id", { ...rawGroupMessage(), threadId: "0" }, "invalid_thread_id"],
    ["missing msgId", rawGroupMessage({ msgId: "" }), "missing_message_id"],
    ["bad msgId", rawGroupMessage({ msgId: "1; DROP TABLE" }), "invalid_message_id"],
    ["missing sender", rawGroupMessage({ uidFrom: "" }), "missing_sender"],
    ["sender 0", rawGroupMessage({ uidFrom: "0" }), "invalid_sender"],
  ];
  for (const [name, raw, reason] of cases) {
    it(`rejects: ${name}`, () => {
      assert.deepEqual(normalizeEvent("message", raw, ctx), { ok: false, reason });
    });
  }

  it("rejects an unsupported event name", () => {
    assert.deepEqual(normalizeEvent("typing" as never, {}, ctx), { ok: false, reason: "unsupported_event" });
  });
});

describe("event-normalizer: signals", () => {
  it("undo → metadata with the referenced message id", () => {
    const r = normalizeEvent("undo", { threadId: GROUP_ALLOWED, isSelf: false, isGroup: true, data: { uidFrom: FRIEND, content: { globalMsgId: 7000000000001 } } }, ctx);
    assert.ok(r.ok);
    assert.equal(r.event.kind, "undo");
    assert.equal(r.event.conversationType, "group");
    assert.equal(r.event.externalMessageId, "7000000000001");
  });

  it("reaction in a direct chat", () => {
    const r = normalizeEvent("reaction", { threadId: FRIEND, isSelf: true, isGroup: false, data: { uidFrom: OWN_ID, msgId: "55", content: { rIcon: "/-heart" } } }, ctx);
    assert.ok(r.ok);
    assert.equal(r.event.conversationType, "direct");
    assert.equal(r.event.isSelf, true);
  });

  it("group_event keeps only a sanitized subtype", () => {
    const ok = normalizeEvent("group_event", { type: "join", threadId: GROUP_ALLOWED, isSelf: false, data: { groupName: "Bí mật" } }, ctx);
    assert.ok(ok.ok && ok.event.kind === "group_event" && ok.event.subtype === "join");
    const weird = normalizeEvent("group_event", { type: "<script>", threadId: GROUP_ALLOWED }, ctx);
    assert.ok(weird.ok && weird.event.kind === "group_event" && weird.event.subtype === "unknown");
  });
});

describe("event-normalizer: helpers", () => {
  it("classifyMessage best-effort mapping", () => {
    assert.equal(classifyMessage("chat.sticker", {}), "sticker");
    assert.equal(classifyMessage("chat.video.msg", {}), "video");
    assert.equal(classifyMessage("share.file", {}), "file");
    assert.equal(classifyMessage(null, {}), "other");
    assert.equal(classifyMessage("chat.photo", "text wins"), "text");
  });

  it("dedupeKey is stable and null without a message id", () => {
    const m = message(rawGroupMessage());
    assert.equal(dedupeKey(m), dedupeKey(message(rawGroupMessage())));
    assert.notEqual(dedupeKey(m), dedupeKey(message(rawGroupMessage({ msgId: "7000000000002" }))));
    assert.equal(dedupeKey({ kind: "group_event", conversationType: "group", conversationId: GROUP_ALLOWED, externalMessageId: null, senderExternalId: null }), null);
  });
});
