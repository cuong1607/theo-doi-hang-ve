// ============================================================
// PHASE 04.5 — AI Reply dashboard smoke test (Playwright) on the LOCAL stack.
// Seeds throw-away users + a connection (content mode) with a mention_only
// group, ingests bot calls through the real Phase 02 RPC, runs ONE real reply
// tick (AI off → rules + formatter, no model, no network), drives the UI as
// owner / manager / outsider, and plays the WORKER by calling claim + report
// on the store (no Zalo message is sent). Everything is removed afterwards.
//
//   node --env-file=.env.local scripts/e2e/zalo-reply-045.ts http://localhost:3000 <outDir>
// Needs PERSONAL_REPLY_ENABLED + PERSONAL_SEND_ENABLED + AI_SYSTEM_PERSONAL_DRAFTS_ENABLED
// + ZALO_PERSONAL_DASHBOARD_ENABLED on the dev server.
// ============================================================
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";

import { getAiConfig } from "../../src/lib/ai-assistant/config.ts";
import { FakeAiProvider } from "../../src/lib/ai-assistant/fake-provider.ts";
import { getSystemAssistantConfig } from "../../src/lib/ai-system/config.ts";
import { systemDemoScript } from "../../src/lib/ai-system/fake-script.ts";
import { SupabaseSystemStore } from "../../src/lib/ai-system/supabase-store.ts";
import { createDefaultRegistry } from "../../src/lib/ai-system/tools/index.ts";
import { encryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { SupabaseAiStore } from "../../src/lib/zalo-personal/ai/supabase-store.ts";
import { workerSecretContext } from "../../src/lib/zalo-personal/config.ts";
import { SupabaseDashboardStore } from "../../src/lib/zalo-personal/dashboard/supabase-store.ts";
import { generateWorkerSecret } from "../../src/lib/zalo-personal/signing.ts";
import { getReplyConfig } from "../../src/lib/zalo-reply/config.ts";
import { runReplyTick } from "../../src/lib/zalo-reply/engine.ts";
import { SupabaseReplyStore } from "../../src/lib/zalo-reply/supabase-store.ts";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? ".";
mkdirSync(OUT, { recursive: true });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
if (!/localhost|127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")) throw new Error("local only");
const store = new SupabaseReplyStore(db);
const TAG = `r45e${Date.now()}`;
const PASSWORD = `Pw-${TAG}-x!`;
const T = Date.now();
const ACC = `84${T}`.slice(0, 17);
const GROUP = `64${T}`.slice(0, 18);
const U_ADMIN = `72${T}1`.slice(0, 18);
const ids = { owner: "", manager: "", outsider: "", conn: "", worker: "", group: "", groupDraft: "", dmDraft: "" };

const results: Array<{ name: string; ok: boolean; msg?: string }> = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 400) : String(e);
    results.push({ name, ok: false, msg });
    console.log(`  FAIL ${name} - ${msg}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const settle = (page: Page) => page.waitForLoadState("networkidle", { timeout: 180_000 }).catch(() => undefined);
async function login(page: Page, email: string) {
  await page.goto(`${BASE}/login`, { timeout: 180_000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), page.click('button[type="submit"]')]);
  await settle(page);
}
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
};
const main$ = (page: Page) => page.locator("main").last().innerText();

async function user(key: "owner" | "manager" | "outsider", role: "admin" | "staff") {
  const { data, error } = await db.auth.admin.createUser({ email: `${TAG}${key}@example.test`, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  await db.from("profiles").update({ is_active: true, role, full_name: `E2E ${key}` }).eq("id", data.user.id);
  ids[key] = data.user.id;
}

let seq = 0;
const ev = (type: "group" | "user", conv: string, sender: string, text: string, mention = false) => {
  seq++;
  const at = new Date().toISOString();
  return { eventKey: createHash("sha256").update(`${TAG}|${seq}`).digest("hex"), kind: "message", conversationType: type, conversationId: conv, externalMessageId: `${TAG}${seq}`, senderId: sender, messageType: "text", text, textLength: text.length, mentions: mention ? [{ uid: ACC, pos: 0, len: 4, kind: "user" }] : [], mentionsSelf: mention, isSelf: false, subtype: null, sentAt: at, receivedAt: at };
};
const ingest = async (events: unknown[]) => {
  const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: ids.worker, p_account_id: ACC, p_events: events });
  if (error || data?.ok !== true) throw new Error(`ingest ${error?.message}`);
};
function tick() {
  const sys = new SupabaseSystemStore(db);
  const off = getAiConfig({ AI_ENABLED: "false", NODE_ENV: "test" });
  return runReplyTick({
    store,
    config: { ...getReplyConfig({ PERSONAL_REPLY_ENABLED: "true", PERSONAL_SEND_ENABLED: "true" }), scanLagMs: 0 },
    identity: sys,
    system: { db, store: sys, identityStore: sys, registry: createDefaultRegistry(), aiConfig: off, config: getSystemAssistantConfig({ AI_SYSTEM_PERSONAL_DRAFTS_ENABLED: "true" }), flags: { adsRealData: false }, provider: () => new FakeAiProvider(systemDemoScript, "fake") },
    memory: { dashboard: new SupabaseDashboardStore(db), store: new SupabaseAiStore(db), config: off, provider: () => new FakeAiProvider(systemDemoScript, "fake") },
    workerId: `e2e-${TAG}`.slice(0, 60),
  });
}

async function seed() {
  await user("owner", "admin");
  await user("manager", "staff");
  await user("outsider", "staff");
  const { data: c } = await db.from("zalo_personal_connections").insert({ connection_key: `e2e-${TAG}`.slice(0, 32), owner_user_id: ids.owner, direct_message_mode: "content" }).select("id").single();
  ids.conn = c!.id;
  ids.worker = randomUUID();
  await db.from("zalo_personal_workers").insert({ id: ids.worker, worker_key: `e2ew-${TAG}`, connection_id: ids.conn, secret_encrypted: encryptSecret(generateWorkerSecret(), parseEncryptionKey(process.env.APP_ENCRYPTION_KEY), workerSecretContext(ids.worker)) });
  await db.rpc("zp_record_heartbeat", { p_worker_id: ids.worker, p_account_id: ACC, p_state: { workerVersion: "e2e", workerStartedAt: new Date().toISOString(), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: null, lastDeliveryOkAt: new Date().toISOString(), outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null } });
  await ingest([ev("group", GROUP, U_ADMIN, "khởi tạo")]);
  ids.group = (await db.from("zalo_personal_groups").select("id").eq("connection_id", ids.conn).eq("external_group_id", GROUP).single()).data!.id;
  await db.rpc("zp_update_group", { p_actor: ids.owner, p_connection_id: ids.conn, p_group_id: ids.group, p_action: "grant_consent", p_mode: null, p_note: "đồng ý (e2e)" });
  await db.rpc("zp_update_group", { p_actor: ids.owner, p_connection_id: ids.conn, p_group_id: ids.group, p_action: "set_mode", p_mode: "mention_only", p_note: null });
  await db.from("zalo_personal_groups").update({ display_name: "Kho E2E 04.5" }).eq("id", ids.group);
  await db.rpc("zp_grant_access", { p_actor: ids.owner, p_connection_id: ids.conn, p_grantee: ids.manager, p_scope: "connection", p_conversation_id: null, p_level: "manage", p_note: null });
  await db.from("ai_channel_identities").insert({ channel: "zalo_personal", connection_id: ids.conn, external_user_id: U_ADMIN, internal_user_id: ids.owner, verified_via: "link_code" });
  await tick(); // cursor = now: older messages are never answered
  // PHASE 07 defaults are draft_only + sending OFF: the owner explicitly switches to approve-then-send
  await db.from("zalo_personal_reply_settings").update({ reply_mode: "manual_approval", send_enabled: true }).eq("connection_id", ids.conn);
  await ingest([ev("group", GROUP, U_ADMIN, "@Bot công nợ là gì?", true), ev("user", U_ADMIN, U_ADMIN, "công nợ nhà cung cấp hôm nay")]);
  const r = await tick();
  if (r.status === "error") throw new Error(`tick ${JSON.stringify(r.stats)}`);
  const drafts = (await db.from("zalo_personal_reply_drafts").select("id, conversation_type").eq("connection_id", ids.conn)).data!;
  ids.groupDraft = drafts.find((d) => d.conversation_type === "group")!.id;
  ids.dmDraft = drafts.find((d) => d.conversation_type === "user")!.id;
}

async function cleanup() {
  if (ids.conn) {
    for (const t of ["zalo_personal_reply_audit", "zalo_personal_reply_drafts", "zalo_personal_reply_inbound", "zalo_personal_reply_allowlist", "zalo_personal_reply_blocks", "zalo_personal_reply_scan_state", "zalo_personal_reply_settings", "ai_channel_identities"]) await db.from(t).delete().eq("connection_id", ids.conn);
    for (const t of ["zalo_personal_audit_log", "zalo_personal_access_grants", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", ids.conn);
    await db.from("zalo_personal_connections").delete().eq("id", ids.conn);
  }
  const us = [ids.owner, ids.manager, ids.outsider].filter(Boolean);
  if (us.length) await db.from("zalo_personal_reply_audit").delete().is("connection_id", null).in("actor_user_id", us);
  await db.from("zalo_personal_reply_control").update({ emergency_stop: false, changed_by: null, changed_at: null, reason: null }).eq("id", 1);
  for (const u of us) {
    await db.from("ai_system_requests").delete().eq("user_id", u);
    await db.from("ai_request_usage").delete().eq("user_id", u);
    await db.from("ai_identity_link_codes").delete().eq("internal_user_id", u);
    await db.auth.admin.deleteUser(u);
  }
}

async function main() {
  await seed();
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
    await login(page, `${TAG}owner@example.test`);

    await step("owner: 'Trả lời AI' menu + inbox lists the group and the 1-1 draft", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/replies`);
      await settle(page);
      expect(await page.getByRole("heading", { level: 2, name: "Hộp duyệt trả lời AI" }).isVisible(), "heading");
      expect((await page.getByRole("link", { name: "Lịch sử gửi" }).count()) > 0, "sidebar item");
      const body = await main$(page);
      expect(body.includes("@Bot công nợ là gì?"), "group source");
      expect(body.includes("công nợ nhà cung cấp hôm nay"), "1-1 source");
      expect(body.includes("Chờ duyệt"), "status");
      await shot(page, "045-inbox");
    });

    await step("owner: 1-1 draft detail shows source, proposal, sources, audit", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/replies/${ids.dmDraft}`);
      await settle(page);
      const body = await main$(page);
      expect(body.includes("Tin nhắn nguồn") && body.includes("Trả lời đề xuất") && body.includes("Nhật ký"), "cards");
      expect(body.includes("chỉ người hỏi"), "audience private");
      expect(body.includes("Tạo bản nháp"), "audit created");
      await shot(page, "045-detail");
    });

    await step("owner: edit then approve the group draft → queued", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/replies/${ids.groupDraft}`);
      await settle(page);
      expect((await main$(page)).includes("mọi thành viên nhóm"), "audience group");
      await page.getByRole("button", { name: "Sửa nội dung" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Nội dung trả lời").fill("Công nợ là số tiền còn phải trả nhà cung cấp. (E2E)");
      await dialog.getByRole("button", { name: "Lưu" }).click();
      await page.getByText("Đã lưu nội dung.").waitFor({ timeout: 30_000 });
      await settle(page);
      await page.getByRole("button", { name: "Duyệt & gửi" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Xác nhận" }).click();
      await page.getByText("Đã duyệt, chờ gửi").first().waitFor({ timeout: 30_000 });
      const row = (await db.from("zalo_personal_reply_drafts").select("status, approval, edited").eq("id", ids.groupDraft).single()).data!;
      expect(row.status === "queued" && row.approval === "manual" && row.edited === true, JSON.stringify(row));
      await shot(page, "045-approved");
    });

    await step("worker (simulated): claim returns the edited text for the stored group; report sent → history 'Đã gửi'", async () => {
      const c = await store.claim(ids.worker, ACC, 60, 100, false);
      expect(c.ok && c.job && c.job.threadId === GROUP && c.job.text.includes("(E2E)"), JSON.stringify(c));
      if (!c.ok || !c.job) return;
      await store.report(ids.worker, c.job.draftId, c.job.claimToken, "sent", "8200000000001", null);
      await page.goto(`${BASE}/apps/zalo/personal/replies/outbound`);
      await settle(page);
      const body = await main$(page);
      expect(body.includes("Đã gửi") && body.includes("Cả nhóm"), "history row");
      await shot(page, "045-outbound");
    });

    await step("owner: settings — emergency stop then resume (admin), link code shown once", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/replies/settings`);
      await settle(page);
      expect((await main$(page)).includes("Kết nối e2e-"), "connection card");
      await page.getByRole("button", { name: "Dừng khẩn cấp mọi gửi tin" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Dừng ngay" }).click();
      await page.getByText("Đã dừng khẩn cấp.").waitFor({ timeout: 30_000 });
      const stopped = (await db.from("zalo_personal_reply_control").select("emergency_stop").eq("id", 1).single()).data!.emergency_stop;
      expect(stopped === true, "stored");
      const claim = await store.claim(ids.worker, ACC, 60, 100, false);
      expect(claim.ok && claim.job === null && claim.reason === "emergency_stop", JSON.stringify(claim));
      await settle(page);
      await page.getByRole("button", { name: "Gỡ dừng khẩn cấp" }).click();
      await page.getByText("Đã gỡ dừng khẩn cấp.").waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Tạo mã liên kết" }).click();
      await page.getByText(/^LINK [A-Z2-9]{8}$/).waitFor({ timeout: 30_000 });
      await shot(page, "045-settings");
    });

    await step("owner: save settings (cooldown 120s) is stored", async () => {
      await page.getByLabel("Giãn cách mỗi hội thoại (giây)").fill("120");
      await page.getByRole("button", { name: "Lưu cài đặt" }).click();
      await page.getByText("Đã lưu cài đặt trả lời.").waitFor({ timeout: 30_000 });
      const s = (await db.from("zalo_personal_reply_settings").select("cooldown_seconds").eq("connection_id", ids.conn).single()).data!;
      expect(s.cooldown_seconds === 120, JSON.stringify(s));
    });

    await step("PHASE 07 owner: 1-1 content mode 'only linked people' saved from the settings page", async () => {
      await page.getByText("Chỉ người đã liên kết (khuyên dùng)").click();
      await page.getByRole("button", { name: "Lưu chế độ nội dung 1-1" }).click();
      await page.getByText("Đã đổi chế độ lưu nội dung 1-1.").waitFor({ timeout: 30_000 });
      const c = (await db.from("zalo_personal_connections").select("direct_message_mode").eq("id", ids.conn).single()).data!;
      expect(c.direct_message_mode === "linked", JSON.stringify(c));
    });

    await step("PHASE 07 owner: operations page — real health, queues, AI, reminders, audit", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/operations`);
      await settle(page);
      const body = await main$(page);
      for (const s of ["Vận hành Zalo cá nhân", `Kết nối e2e-`, "Worker", "Trả lời & gửi", "AI trả lời", "Nhắc việc", "Nhật ký thao tác gần đây"]) expect(body.includes(s), `missing: ${s}`);
      expect(/Hoạt động tốt|Cần chú ý|Mất kết nối|Cần đăng nhập lại|Chưa rõ/.test(body), "a health state is shown");
      expect(!/zps_|session|cookie/i.test(body.replace(/Phiên Zalo/g, "")), "no secret / session shown");
      await shot(page, "07-operations");
    });

    await step("mobile 390px: inbox has no horizontal page overflow", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${BASE}/apps/zalo/personal/replies`);
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow <= 1, `overflow ${overflow}px`);
      await shot(page, "045-mobile");
    });
    await ctx.close();

    const mctx = await browser.newContext();
    const mp = await mctx.newPage();
    await login(mp, `${TAG}manager@example.test`);
    await step("manager (manage grant): sees group drafts only; 1-1 draft → 404; cannot configure", async () => {
      const list = await mp.request.get(`${BASE}/api/zalo-personal/replies?status=all`);
      const j = (await list.json()) as { data?: { rows?: Array<{ conversation: { type: string } }> } };
      expect(list.status() === 200 && (j.data?.rows ?? []).length > 0 && j.data!.rows!.every((r) => r.conversation.type === "group"), `group only (${list.status()})`);
      const dm = await mp.request.get(`${BASE}/api/zalo-personal/replies/${ids.dmDraft}`);
      expect(dm.status() === 404, `dm ${dm.status()}`);
      const save = await mp.request.patch(`${BASE}/api/zalo-personal/replies/settings`, { data: { connectionId: ids.conn, replyMode: "disabled" } });
      expect(save.status() === 404, `settings ${save.status()}`);
      const dmMode = await mp.request.post(`${BASE}/api/zalo-personal/replies/control`, { data: { action: "set_direct_mode", connectionId: ids.conn, directMessageMode: "content" } });
      expect(dmMode.status() === 404, `1-1 content mode ${dmMode.status()}`);
      const resume = await mp.request.post(`${BASE}/api/zalo-personal/replies/control`, { data: { action: "emergency_resume" } });
      expect(resume.status() === 403, `resume ${resume.status()}`);
    });
    await step("PHASE 07 manager (staff): operations page → not found, nothing of it rendered", async () => {
      // the (zalo) segment streams (loading.tsx), so notFound() arrives after a 200 header: assert the CONTENT
      const r = await mp.goto(`${BASE}/apps/zalo/personal/operations`);
      await settle(mp);
      const body = await mp.locator("body").innerText();
      expect(r?.status() === 404 || !body.includes("Vận hành Zalo cá nhân"), `operations heading rendered (${r?.status()})`);
      expect(!body.includes("Heartbeat gần nhất") && !body.includes(`e2e-${TAG}`.slice(0, 20)), "no connection data");
      await mp.goto(`${BASE}/apps/zalo/personal/replies`);
      await settle(mp);
      const shell = await mp.locator("body").innerText();
      expect(shell.includes("Hộp duyệt trả lời") && !shell.includes("Vận hành"), "menu item hidden for staff");
    });
    await mctx.close();

    const octx = await browser.newContext();
    const op = await octx.newPage();
    await login(op, `${TAG}outsider@example.test`);
    await step("outsider: draft page / API never reveal anything", async () => {
      await op.goto(`${BASE}/apps/zalo/personal/replies/${ids.groupDraft}`);
      await settle(op);
      expect(!(await op.locator("body").innerText()).includes("(E2E)"), "no leak");
      const r = await op.request.get(`${BASE}/api/zalo-personal/replies/${ids.groupDraft}`);
      expect(r.status() === 404 || r.status() === 403, `api ${r.status()}`);
      const a = await op.request.post(`${BASE}/api/zalo-personal/replies/${ids.dmDraft}/actions`, { data: { action: "approve", version: 1 } });
      expect(a.status() === 404 || a.status() === 403, `action ${a.status()}`);
    });
    await step("outsider (staff, no Zalo access): settings page = link my Zalo only; a code is issued", async () => {
      await op.goto(`${BASE}/apps/zalo/personal/replies/settings`);
      await settle(op);
      expect(op.url().includes("/replies/settings"), `redirected to ${op.url()}`);
      const text = await main$(op);
      expect(text.includes("Liên kết tài khoản Zalo của tôi"), "link card shown");
      expect(!text.includes("Dừng khẩn cấp") && !text.includes(`e2e-${TAG}`.slice(0, 32)), "no admin section, no other connection");
      await op.getByRole("button", { name: "Tạo mã liên kết" }).click();
      await op.locator("text=/LINK [A-Z2-9]{8}/").waitFor({ timeout: 20_000 });
      await shot(op, "outsider-link-code");
      const { count } = await db.from("ai_identity_link_codes").select("id", { count: "exact", head: true }).eq("internal_user_id", ids.outsider);
      expect(count === 1, `code stored for the outsider (${count})`);
    });
    await octx.close();

    await step("anonymous: reply API → 401; worker endpoint without signature → 401", async () => {
      const a = await browser.newContext();
      const r = await a.request.get(`${BASE}/api/zalo-personal/replies`);
      expect(r.status() === 401, `status ${r.status()}`);
      const w = await a.request.post(`${BASE}/api/internal/zalo-personal/outbound/claim`, { data: { v: 1 } });
      expect(w.status() === 401, `worker ${w.status()}`);
      await a.close();
    });
  } finally {
    await browser.close();
    await cleanup();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${consoleErrors.length ? ` · console errors: ${consoleErrors.length} (${consoleErrors.slice(0, 3).join(" | ")})` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  process.exit(1);
});
