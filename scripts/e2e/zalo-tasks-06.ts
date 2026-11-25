// ============================================================
// PHASE 06 — Task dashboard smoke test (Playwright) on the LOCAL stack.
// Seeds throw-away users + a Zalo Personal connection with a monitored group,
// ingests messages through the real Phase 02 RPC, runs ONE real engine tick
// (rules extraction, no model, no network), then drives the UI as owner,
// assignee (staff, read grant, linked UID) and outsider (staff, no grant).
// Everything it created is removed afterwards.
//
//   node --env-file=.env.local scripts/e2e/zalo-tasks-06.ts http://localhost:3000 <outDir>
// Needs AI_TASKS_ENABLED=true + ZALO_PERSONAL_DASHBOARD_ENABLED=true on the dev server.
// ============================================================
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";

import { getAiConfig } from "../../src/lib/ai-assistant/config.ts";
import { FakeAiProvider } from "../../src/lib/ai-assistant/fake-provider.ts";
import { unavailableAdapter } from "../../src/lib/ai-tasks/channels.ts";
import { getTaskEngineConfig } from "../../src/lib/ai-tasks/config.ts";
import { runTick } from "../../src/lib/ai-tasks/engine.ts";
import { SupabaseTaskStore } from "../../src/lib/ai-tasks/supabase-store.ts";
import { encryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { workerSecretContext } from "../../src/lib/zalo-personal/config.ts";
import { generateWorkerSecret } from "../../src/lib/zalo-personal/signing.ts";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? ".";
mkdirSync(OUT, { recursive: true });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
if (!/localhost|127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")) throw new Error("local only");
const TAG = `t6e${Date.now()}`;
const PASSWORD = `Pw-${TAG}-x!`;
const T = Date.now();
const ACC = `83${T}`.slice(0, 17);
const GROUP = `63${T}`.slice(0, 18);
const U_BOSS = `71${T}1`.slice(0, 18);
const U_STAFF = `71${T}2`.slice(0, 18);
const ids = { owner: "", staff: "", outsider: "", conn: "", worker: "", task: "" };

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

async function user(key: "owner" | "staff" | "outsider") {
  const { data, error } = await db.auth.admin.createUser({ email: `${TAG}${key}@example.test`, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  await db.from("profiles").update({ is_active: true, role: "staff", full_name: `E2E ${key}` }).eq("id", data.user.id);
  ids[key] = data.user.id;
}

let seq = 0;
const ev = (sender: string, text: string, mentions: Array<{ uid: string; pos: number; len: number }> = [], at = new Date()) => {
  seq++;
  return { eventKey: createHash("sha256").update(`${TAG}|${seq}`).digest("hex"), kind: "message", conversationType: "group", conversationId: GROUP, externalMessageId: `${TAG}${seq}`, senderId: sender, messageType: "text", text, textLength: text.length, mentions: mentions.map((m) => ({ ...m, kind: "user" })), mentionsSelf: false, isSelf: false, subtype: null, sentAt: at.toISOString(), receivedAt: at.toISOString() };
};
const ingest = async (events: unknown[]) => {
  const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: ids.worker, p_account_id: ACC, p_events: events });
  if (error || data?.ok !== true) throw new Error(`ingest ${error?.message}`);
};

async function seed() {
  await user("owner");
  await user("staff");
  await user("outsider");
  const { data: c } = await db.from("zalo_personal_connections").insert({ connection_key: `e2e-${TAG}`.slice(0, 32), owner_user_id: ids.owner }).select("id").single();
  ids.conn = c!.id;
  ids.worker = randomUUID();
  await db.from("zalo_personal_workers").insert({ id: ids.worker, worker_key: `e2ew-${TAG}`, connection_id: ids.conn, secret_encrypted: encryptSecret(generateWorkerSecret(), parseEncryptionKey(process.env.APP_ENCRYPTION_KEY), workerSecretContext(ids.worker)) });
  await db.rpc("zp_record_heartbeat", { p_worker_id: ids.worker, p_account_id: ACC, p_state: { workerVersion: "e2e", workerStartedAt: new Date().toISOString(), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: null, lastDeliveryOkAt: new Date().toISOString(), outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null } });
  await ingest([ev(U_BOSS, "khởi tạo", [], new Date(Date.now() - 3_600_000))]);
  const g = (await db.from("zalo_personal_groups").select("id").eq("connection_id", ids.conn).eq("external_group_id", GROUP).single()).data!.id;
  await db.rpc("zp_update_group", { p_actor: ids.owner, p_connection_id: ids.conn, p_group_id: g, p_action: "grant_consent", p_mode: null, p_note: "đồng ý (e2e)" });
  await db.rpc("zp_update_group", { p_actor: ids.owner, p_connection_id: ids.conn, p_group_id: g, p_action: "set_mode", p_mode: "monitor", p_note: null });
  await db.from("zalo_personal_groups").update({ display_name: "Kho E2E" }).eq("id", g);
  await db.rpc("zp_grant_access", { p_actor: ids.owner, p_connection_id: ids.conn, p_grantee: ids.staff, p_scope: "connection", p_conversation_id: null, p_level: "read", p_note: null });
  await db.from("ai_channel_identities").insert({ channel: "zalo_personal", connection_id: ids.conn, external_user_id: U_STAFF, internal_user_id: ids.staff, verified_via: "link_code" });
  await ingest([
    ev(U_BOSS, "@Lan xác nhận công nợ NCC Hưng Thịnh trước 17h nhé", [{ uid: U_STAFF, pos: 0, len: 4 }], new Date(Date.now() - 120_000)),
    ev(U_BOSS, "Ai phụ trách xử lý lô hàng ABC?", [], new Date(Date.now() - 90_000)),
  ]);
  const r = await runTick({
    store: new SupabaseTaskStore(db),
    config: getTaskEngineConfig({ AI_TASKS_ENABLED: "true", AI_TASKS_BACKFILL_MINUTES: "120", AI_TASKS_SCAN_SETTLE_SECONDS: "0" }),
    aiConfig: getAiConfig({ NODE_ENV: "test" }),
    provider: () => new FakeAiProvider(() => ({})),
    adapters: { zalo_personal: unavailableAdapter("zalo_personal"), zalo_oa: unavailableAdapter("zalo_oa") },
    workerId: `e2e-${TAG}`.slice(0, 60),
  });
  if (r.status === "error") throw new Error(`tick ${JSON.stringify(r.stats)}`);
  const t = (await db.from("ai_tasks").select("id, title").eq("connection_id", ids.conn).ilike("title", "%công nợ%").single()).data!;
  ids.task = t.id;
}

async function cleanup() {
  if (ids.conn) {
    await db.from("ai_tasks").delete().eq("connection_id", ids.conn);
    await db.from("ai_task_candidates").delete().eq("connection_id", ids.conn);
    await db.from("ai_mention_events").delete().eq("connection_id", ids.conn);
    await db.from("user_notifications").delete().eq("connection_id", ids.conn);
    await db.from("ai_task_scan_state").delete().eq("connection_id", ids.conn);
    await db.from("ai_channel_identities").delete().eq("connection_id", ids.conn);
    for (const t of ["zalo_personal_audit_log", "zalo_personal_access_grants", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", ids.conn);
    await db.from("zalo_personal_connections").delete().eq("id", ids.conn);
  }
  await db.from("ai_task_worker_runs").delete().like("worker_id", `e2e-${TAG}%`);
  for (const u of [ids.owner, ids.staff, ids.outsider].filter(Boolean)) {
    await db.from("ai_reminder_schedules").delete().eq("user_id", u);
    await db.from("user_notifications").delete().eq("user_id", u);
    await db.from("ai_reminder_preferences").delete().eq("user_id", u);
    await db.auth.admin.deleteUser(u);
  }
}

async function main() {
  await seed();
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  try {
    // ---------------------------------------------------------------- owner
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
    await login(page, `${TAG}owner@example.test`);

    await step("owner: 'Công việc' menu + pending list shows both proposals", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/tasks?view=pending`);
      await settle(page);
      expect(await page.getByRole("heading", { level: 2, name: "Việc cần xác nhận" }).isVisible(), "heading");
      expect((await page.getByRole("link", { name: "Việc của tôi" }).count()) > 0, "sidebar item");
      const body = await page.locator("main").last().innerText();
      expect(body.includes("xác nhận công nợ NCC Hưng Thịnh"), "task 1 listed");
      expect(body.includes("Ai phụ trách xử lý lô hàng ABC"), "task 2 listed");
      expect(body.includes("Chờ xác nhận"), "status label");
      await shot(page, "06-pending-list");
    });

    await step("owner: detail shows source message, evidence, no reminders yet", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/tasks/${ids.task}`);
      await settle(page);
      const body = await page.locator("main").last().innerText();
      expect(body.includes("CHƯA được xác nhận"), "pending callout");
      expect(body.includes("Tin nhắn nguồn"), "sources card");
      expect(body.includes("Chưa có lịch nhắc"), "no reminders before confirmation");
      expect(body.includes("E2E staff"), "assignee resolved through the verified link");
      await shot(page, "06-detail-pending");
    });

    await step("owner: confirm with a deadline → accepted, 3 reminders planned", async () => {
      await page.getByRole("button", { name: "Xác nhận" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const d = new Date(Date.now() + 2 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
      await dialog.locator('input[type="datetime-local"]').fill(`${d}T16:30`);
      await dialog.getByRole("button", { name: "Xác nhận" }).click();
      await page.getByText("Đã nhận").first().waitFor({ timeout: 30_000 });
      await settle(page);
      const body = await page.locator("main").last().innerText();
      expect(body.includes("Trước 24 giờ") && body.includes("Trước 1 giờ") && body.includes("Quá hạn"), "DAY / HOUR / OVERDUE rows");
      const n = (await db.from("ai_reminder_schedules").select("id").eq("task_id", ids.task).eq("status", "pending")).data!.length;
      expect(n === 3, `3 pending occurrences (got ${n})`);
      await shot(page, "06-detail-confirmed");
    });

    await step("owner: preferences save", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/tasks/preferences`);
      await settle(page);
      await page.getByLabel(/Bản tin 08:00/).uncheck();
      await page.getByRole("button", { name: "Lưu cài đặt" }).click();
      await page.getByText("Đã lưu cài đặt nhắc việc.").waitFor({ timeout: 20_000 });
      const p = (await db.from("ai_reminder_preferences").select("morning_enabled").eq("user_id", ids.owner).single()).data!;
      expect(p.morning_enabled === false, "stored");
    });

    await step("owner: reminder history + health page renders", async () => {
      await page.goto(`${BASE}/apps/zalo/personal/tasks/reminders`);
      await settle(page);
      expect(await page.getByRole("heading", { level: 2, name: "Lịch sử nhắc việc" }).isVisible(), "heading");
      await shot(page, "06-reminders");
    });

    await step("mobile 390px: task list has no horizontal page overflow", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${BASE}/apps/zalo/personal/tasks`);
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow <= 1, `overflow ${overflow}px`);
      await shot(page, "06-mobile-list");
    });
    await ctx.close();

    // ---------------------------------------------------------------- assignee (staff, read grant, linked)
    const sctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const sp = await sctx.newPage();
    await login(sp, `${TAG}staff@example.test`);
    await step("assignee: sees the task in 'Việc của tôi', may progress / complete, may NOT confirm / cancel", async () => {
      await sp.goto(`${BASE}/apps/zalo/personal/tasks?view=mine`);
      await settle(sp);
      expect((await sp.locator("main").last().innerText()).includes("xác nhận công nợ"), "listed as mine");
      await sp.goto(`${BASE}/apps/zalo/personal/tasks/${ids.task}`);
      await settle(sp);
      expect(await sp.getByRole("button", { name: "Cập nhật tiến độ" }).isVisible(), "progress action");
      expect(await sp.getByRole("button", { name: "Hoàn thành" }).isVisible(), "complete action");
      expect((await sp.getByRole("button", { name: "Hủy việc" }).count()) === 0, "no cancel");
      expect((await sp.getByRole("button", { name: "Chỉnh sửa" }).count()) === 0, "no edit");
    });
    await step("assignee: progress 50% → Đang làm", async () => {
      await sp.getByRole("button", { name: "Cập nhật tiến độ" }).click();
      const dialog = sp.getByRole("dialog");
      await dialog.locator('input[type="number"]').fill("50");
      await dialog.getByRole("button", { name: "Lưu tiến độ" }).click();
      await sp.getByText("Đang làm").first().waitFor({ timeout: 30_000 });
    });
    await step("assignee: mention notification in the inbox (no message text), mark all read", async () => {
      await sp.goto(`${BASE}/apps/zalo/personal/notifications`);
      await settle(sp);
      const body = await sp.locator("main").last().innerText();
      expect(body.includes("Bạn được nhắc tên trong nhóm Kho E2E"), "mention notification");
      expect(!body.includes("Hưng Thịnh"), "no group message text in the inbox");
      await shot(sp, "06-inbox");
      await sp.getByRole("button", { name: "Đánh dấu đã đọc tất cả" }).click();
      await sp.getByText("Đã đọc hết").waitFor({ timeout: 20_000 });
    });
    await step("assignee: API refuses a manager action (403)", async () => {
      const rev = (await db.from("ai_tasks").select("revision").eq("id", ids.task).single()).data!.revision;
      const res = await sp.request.post(`${BASE}/api/zalo-personal/tasks/${ids.task}/actions`, { data: { action: "cancel", revision: rev } });
      expect(res.status() === 403, `status ${res.status()}`);
    });
    await sctx.close();

    // ---------------------------------------------------------------- outsider (staff, no grant)
    const octx = await browser.newContext();
    const op = await octx.newPage();
    await login(op, `${TAG}outsider@example.test`);
    await step("outsider: task page and API never reveal the task", async () => {
      await op.goto(`${BASE}/apps/zalo/personal/tasks/${ids.task}`);
      await settle(op);
      expect(!(await op.locator("body").innerText()).includes("công nợ NCC Hưng Thịnh"), "no title leak");
      const res = await op.request.get(`${BASE}/api/zalo-personal/tasks/${ids.task}`);
      expect(res.status() === 404, `api status ${res.status()}`);
      const list = await op.request.get(`${BASE}/api/zalo-personal/tasks`);
      const j = (await list.json()) as { data?: { rows?: unknown[] } };
      expect(list.status() !== 200 || (j.data?.rows ?? []).length === 0, "empty list");
    });
    await octx.close();

    await step("anonymous: task API → 401", async () => {
      const a = await browser.newContext();
      const r = await a.request.get(`${BASE}/api/zalo-personal/tasks`);
      expect(r.status() === 401, `status ${r.status()}`);
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
