import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";

import { DedupeCache } from "../src/dedupe.ts";
import { HealthMonitor } from "../src/health-monitor.ts";
import { createEventPipeline } from "../src/message-listener.ts";
import { hashId, JsonlMetadataSink, loadOrCreateSalt, pruneMetadataLogs } from "../src/metadata-sink.ts";
import { captureLogger, FRIEND, GROUP_ALLOWED, GROUP_OTHER, NOW, OWN_ID, rawDirectMessage, rawGroupMessage, tempDir } from "./helpers.ts";

const TOKEN = "ctb-discover-7f3a9c";

async function setup() {
  const { dir, cleanup } = await tempDir();
  const { logger, lines } = captureLogger();
  const salt = await loadOrCreateSalt(path.join(dir, "log-salt"));
  const logsDir = path.join(dir, "logs");
  const discoveryFile = path.join(dir, "discovered-groups.jsonl");
  const sink = new JsonlMetadataSink({ logsDir, discoveryFile, salt });
  const health = new HealthMonitor({ file: path.join(dir, "health.json"), connectionId: "primary", now: () => NOW });
  const announced: string[] = [];
  const pipeline = createEventPipeline({
    connectionId: "primary",
    filter: { allowedGroupIds: new Set([GROUP_ALLOWED]), discoveryToken: TOKEN, directMessages: "metadata" },
    dedupe: new DedupeCache({ maxEntries: 100, ttlMs: 60_000 }),
    sink,
    health,
    logger,
    ownId: () => OWN_ID,
    now: () => NOW,
    announce: (l) => announced.push(l),
  });
  const readLogs = async () => {
    const files = await readdir(logsDir).catch(() => [] as string[]);
    let all = "";
    for (const f of files) all += await readFile(path.join(logsDir, f), "utf8");
    return all;
  };
  return { dir, pipeline, health, lines, salt, readLogs, discoveryFile, announced, cleanup: async () => { await health.flush(); await cleanup(); } };
}

describe("pipeline", () => {
  it("allowlisted group message → one metadata line, no text, no display name", async () => {
    const t = await setup();
    assert.equal(await t.pipeline("message", rawGroupMessage({ content: "@Bot nội dung bí mật", mentions: [{ uid: OWN_ID, pos: 0, len: 4, type: 0 }] })), "processed");
    const log = await t.readLogs();
    const rec = JSON.parse(log.trim());
    assert.equal(rec.conversationRef, GROUP_ALLOWED);
    assert.equal(rec.senderRef, `h:${hashId(t.salt, FRIEND)}`);
    assert.equal(rec.textLength, "@Bot nội dung bí mật".length);
    assert.equal(rec.mentionsSelf, true);
    assert.ok(!log.includes("bí mật"), "text never written");
    assert.ok(!log.includes("Tên Hiển Thị"), "display name never written");
    assert.ok(!log.includes(FRIEND), "sender uid hashed");
    assert.ok(!t.lines.join("\n").includes("bí mật"), "text never logged");
    await t.cleanup();
  });

  it("non-allowlisted group → nothing written at all, only a counter", async () => {
    const t = await setup();
    assert.equal(await t.pipeline("message", rawGroupMessage({ threadId: GROUP_OTHER, content: "chuyện riêng của nhóm khác" })), "dropped");
    assert.equal(await t.readLogs(), "");
    assert.equal(t.health.current.counters.dropped.group_not_allowed, 1);
    assert.ok(!t.lines.join("\n").includes(GROUP_OTHER), "unknown group id not logged");
    await t.cleanup();
  });

  it("duplicate event (replay after reconnect) is processed once", async () => {
    const t = await setup();
    assert.equal(await t.pipeline("message", rawGroupMessage()), "processed");
    assert.equal(await t.pipeline("message", rawGroupMessage()), "duplicate");
    assert.equal((await t.readLogs()).trim().split("\n").length, 1);
    assert.equal(t.health.current.counters.duplicates, 1);
    await t.cleanup();
  });

  it("direct message → metadata with hashed conversation id", async () => {
    const t = await setup();
    assert.equal(await t.pipeline("message", rawDirectMessage()), "processed");
    const rec = JSON.parse((await t.readLogs()).trim());
    assert.equal(rec.conversationType, "direct");
    assert.match(rec.conversationRef, /^h:[0-9a-f]{16}$/);
    await t.cleanup();
  });

  it("self message is recorded with isSelf=true", async () => {
    const t = await setup();
    await t.pipeline("message", rawGroupMessage({ isSelf: true, uidFrom: OWN_ID }));
    assert.equal(JSON.parse((await t.readLogs()).trim()).isSelf, true);
    await t.cleanup();
  });

  it("discovery: writes only {at, groupId} and announces the id", async () => {
    const t = await setup();
    assert.equal(await t.pipeline("message", rawGroupMessage({ threadId: GROUP_OTHER, isSelf: true, uidFrom: OWN_ID, content: TOKEN })), "discovered");
    const disc = JSON.parse((await readFile(t.discoveryFile, "utf8")).trim());
    assert.deepEqual(Object.keys(disc).sort(), ["at", "groupId"]);
    assert.equal(disc.groupId, GROUP_OTHER);
    assert.equal(await t.readLogs(), "", "discovery does not store the message");
    assert.ok(t.announced[0]?.includes(GROUP_OTHER));
    await t.cleanup();
  });

  it("malformed event → rejected counter, no crash", async () => {
    const t = await setup();
    assert.equal(await t.pipeline("message", { nonsense: true }), "rejected");
    assert.equal(await t.pipeline("message", null), "rejected");
    assert.equal(t.health.current.counters.rejected.malformed, 1);
    assert.equal(t.health.current.counters.rejected.unsupported_event, 1, "no thread type → unsupported");
    await t.cleanup();
  });

  it("health snapshot contains no ids or text", async () => {
    const t = await setup();
    await t.pipeline("message", rawGroupMessage({ content: "abc-secret-text" }));
    await t.pipeline("message", rawGroupMessage({ threadId: GROUP_OTHER }));
    await t.health.flush();
    const raw = await readFile(path.join(t.dir, "health.json"), "utf8");
    for (const needle of [GROUP_ALLOWED, GROUP_OTHER, FRIEND, OWN_ID, "abc-secret-text"]) assert.ok(!raw.includes(needle), needle);
    await t.cleanup();
  });
});

describe("dedupe cache", () => {
  it("expires entries after the TTL and stays bounded", () => {
    const d = new DedupeCache({ maxEntries: 3, ttlMs: 1000 });
    assert.equal(d.firstSeen("a", 0), true);
    assert.equal(d.firstSeen("a", 500), false);
    assert.equal(d.firstSeen("a", 1500), true);
    for (const k of ["b", "c", "d", "e"]) d.firstSeen(k, 1600);
    assert.ok(d.size <= 3);
  });
});

describe("metadata retention", () => {
  it("prunes event logs older than N days", async () => {
    const t = await setup();
    const { mkdir, writeFile } = await import("node:fs/promises");
    const logs = path.join(t.dir, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "events-2026-11-01.jsonl"), "{}\n");
    await writeFile(path.join(logs, "events-2026-11-23.jsonl"), "{}\n");
    await writeFile(path.join(logs, "notes.txt"), "keep");
    assert.equal(await pruneMetadataLogs(logs, 7, NOW), 1);
    assert.deepEqual((await readdir(logs)).sort(), ["events-2026-11-23.jsonl", "notes.txt"]);
    await t.cleanup();
  });
});
