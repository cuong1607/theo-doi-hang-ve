// ============================================================
// ZALO PERSONAL Phase 03 — HTTP smoke test of the dashboard against a RUNNING
// app (`next start` / `next dev`) wired to the LOCAL Supabase. Real session
// cookies (@supabase/ssr), real proxy, real pages and API routes. Creates its
// own users / connection / messages and removes them afterwards.
//
//   node --env-file=<local env> scripts/zalo-personal/dashboard-smoke.ts http://localhost:3125
//
// The app must run with ZALO_PERSONAL_DASHBOARD_ENABLED=true. Refuses a non-local
// Supabase URL. No real Zalo account involved. Prints one line per check.
// ============================================================
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

import { encryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { workerSecretContext } from "../../src/lib/zalo-personal/config.ts";
import { generateWorkerSecret } from "../../src/lib/zalo-personal/signing.ts";

const BASE = process.argv[2] ?? "http://localhost:3125";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url) || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("smoke test needs the LOCAL Supabase");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const RUN = randomBytes(3).toString("hex");
const PASSWORD = `Pw-${randomBytes(8).toString("hex")}`;
const ACCOUNT = `83${Date.now()}`.slice(0, 18);
const GROUP = `26${Date.now()}`.slice(0, 19);
const XSS = `<script>alert("smoke")</script><img src=x onerror=alert(2)>`;

let failures = 0;
/** Server redirect (307) or, once streaming started, the RSC redirect marker; never the protected data. */
const redirectsTo = (r: { status: number; location: string; text: string }, target: string) =>
  ([307, 308].includes(r.status) && r.location.includes(target)) || (r.status === 200 && r.text.includes(`NEXT_REDIRECT;replace;${target};`) && !r.text.includes("Tin nhắn nhận hôm nay") && !r.text.includes("smoke-"));
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}\n`);
};

const createdUsers: string[] = [];
let connectionId = "";

async function user(tag: string, role: "admin" | "staff" | "viewer"): Promise<{ id: string; cookie: string }> {
  const email = `zp3-smoke-${tag}-${RUN}@example.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  createdUsers.push(data.user.id);
  await db.from("profiles").update({ role, is_active: true, full_name: `Smoke ${tag}` }).eq("id", data.user.id);
  const jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(url, anonKey, { cookies: { getAll: () => jar, setAll: (c) => c.forEach(({ name, value }) => jar.push({ name, value })) } });
  const { error: se } = await ssr.auth.signInWithPassword({ email, password: PASSWORD });
  if (se) throw new Error(`signIn ${se.message}`);
  return { id: data.user.id, cookie: jar.map((c) => `${c.name}=${c.value}`).join("; ") };
}

async function get(path: string, cookie?: string, init: RequestInit = {}) {
  const res = await fetch(new URL(path, BASE), { redirect: "manual", ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
  return { status: res.status, location: res.headers.get("location") ?? "", cors: res.headers.get("access-control-allow-origin"), text: await res.text() };
}

async function main() {
  const owner = await user("owner", "staff");
  const staff = await user("staff", "staff");
  const viewer = await user("viewer", "viewer");

  const { data: c, error } = await db.from("zalo_personal_connections").insert({ connection_key: `smoke-${RUN}`, owner_user_id: owner.id }).select("id").single();
  if (error) throw new Error(error.message);
  connectionId = c.id;
  const workerId = randomUUID();
  await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: `smoke-w-${RUN}`, connection_id: c.id, secret_encrypted: encryptSecret(generateWorkerSecret(), parseEncryptionKey(process.env.APP_ENCRYPTION_KEY), workerSecretContext(workerId)) });
  await db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: ACCOUNT, p_state: { sessionState: "authenticated", listenerState: "active", outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0 } });
  let n = 0;
  const ev = (text: string) => ({ eventKey: createHash("sha256").update(`smoke${RUN}${++n}`).digest("hex"), kind: "message", conversationType: "group", conversationId: GROUP, externalMessageId: `s${RUN}${n}`, senderId: "3000000000000000001", messageType: "text", text, textLength: text.length, mentions: [], mentionsSelf: false, isSelf: false, subtype: null, sentAt: new Date().toISOString(), receivedAt: new Date().toISOString() });
  await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: ACCOUNT, p_events: [ev("discover")] });
  const { data: g } = await db.from("zalo_personal_groups").select("id").eq("connection_id", c.id).eq("external_group_id", GROUP).single();
  await db.rpc("zp_update_group", { p_actor: owner.id, p_connection_id: c.id, p_group_id: g!.id, p_action: "grant_consent", p_mode: null, p_note: "smoke test" });
  await db.rpc("zp_update_group", { p_actor: owner.id, p_connection_id: c.id, p_group_id: g!.id, p_action: "set_mode", p_mode: "monitor", p_note: null });
  await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: ACCOUNT, p_events: [ev(XSS), ev("tin smoke bình thường")] });
  const { data: conv } = await db.from("zalo_personal_conversations").select("id").eq("connection_id", c.id).single();

  // ---------------------------------------------------------------- navigation + pages
  const hubOwner = await get("/apps", owner.cookie);
  check("hub (owner): 'Trợ lý Zalo AI' card shown", hubOwner.status === 200 && hubOwner.text.includes("Trợ lý Zalo AI"), String(hubOwner.status));
  const hubStaff = await get("/apps", staff.cookie);
  check("hub (staff without grant): card hidden", hubStaff.status === 200 && !hubStaff.text.includes("Trợ lý Zalo AI"));
  const hubViewer = await get("/apps", viewer.cookie);
  check("hub (viewer): card hidden", hubViewer.status === 200 && !hubViewer.text.includes("Trợ lý Zalo AI"));

  const overview = await get("/apps/zalo/personal", owner.cookie);
  check("overview page (owner) 200 with real metrics", overview.status === 200 && overview.text.includes("Tin nhắn nhận hôm nay") && overview.text.includes(`smoke-${RUN}`), String(overview.status));
  for (const p of ["connections", "groups", "conversations", "search", "sync"]) {
    const r = await get(`/apps/zalo/personal/${p}`, owner.cookie);
    check(`page /${p} (owner) 200`, r.status === 200, String(r.status));
  }
  const history = await get(`/apps/zalo/personal/conversations/${conv!.id}`, owner.cookie);
  check("history page 200", history.status === 200, String(history.status));
  check("XSS: raw <script> from the message is NOT in the HTML", !history.text.includes(`<script>alert("smoke")`) && !history.text.includes("onerror=alert(2)>"));
  check("XSS: the text is shown escaped", history.text.includes("&lt;script&gt;alert(&quot;smoke&quot;)&lt;/script&gt;") || history.text.includes("&lt;script&gt;alert(\"smoke\")&lt;/script&gt;"));
  const connPage = await get("/apps/zalo/personal/connections", owner.cookie);
  check("connections page: no secret / no full account id", !connPage.text.includes(ACCOUNT) && !/secret_encrypted|zps_[A-Za-z0-9_-]{20}/.test(connPage.text));
  check("connections page: no fake disconnect button (no command channel)", connPage.text.includes("không có nút ngắt kết nối"));

  const staffPage = await get("/apps/zalo/personal", staff.cookie);
  check("page (staff without grant) → /forbidden, no data in the HTML", redirectsTo(staffPage, "/forbidden"), `${staffPage.status} ${staffPage.location}`);
  const viewerPage = await get("/apps/zalo/personal/groups", viewer.cookie);
  check("page (viewer) → /forbidden, no data in the HTML", redirectsTo(viewerPage, "/forbidden"), `${viewerPage.status} ${viewerPage.location}`);
  const anonPage = await get("/apps/zalo/personal");
  check("page (no session) → /login", [307, 308].includes(anonPage.status) && anonPage.location.includes("/login"), `${anonPage.status} ${anonPage.location}`);

  // ---------------------------------------------------------------- API
  const anonApi = await get("/api/zalo-personal/overview");
  check("API no session → 401", anonApi.status === 401, String(anonApi.status));
  const viewerApi = await get("/api/zalo-personal/overview", viewer.cookie);
  check("API viewer → 403", viewerApi.status === 403, String(viewerApi.status));
  const staffApi = await get("/api/zalo-personal/overview", staff.cookie);
  check("API staff without grant → 403 structured", staffApi.status === 403 && JSON.parse(staffApi.text).error === "forbidden", staffApi.text);
  const ov = await get("/api/zalo-personal/overview", owner.cookie);
  check("API overview (owner) 200, no CORS header", ov.status === 200 && JSON.parse(ov.text).data.messagesToday === 2 && ov.cors === null, ov.text.slice(0, 200));
  const bad = await get("/api/zalo-personal/groups?size=500", owner.cookie);
  check("API invalid input → 400 with field issues", bad.status === 400 && JSON.parse(bad.text).error === "invalid_input", bad.text);
  const foreign = await get(`/api/zalo-personal/conversations/${randomUUID()}/messages`, owner.cookie);
  check("API unknown / foreign conversation → 404", foreign.status === 404, String(foreign.status));
  const staffMsgs = await get(`/api/zalo-personal/conversations/${conv!.id}/messages`, staff.cookie);
  check("API IDOR: staff reads owner's conversation by id → 403/404", staffMsgs.status === 403 || staffMsgs.status === 404, String(staffMsgs.status));
  const patch = (body: unknown, cookie = owner.cookie) => get(`/api/zalo-personal/groups/${g!.id}`, cookie, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const interactive = await patch({ action: "set_mode", mode: "interactive" });
  check("API PATCH interactive → 409 interactive_not_available", interactive.status === 409 && JSON.parse(interactive.text).error === "interactive_not_available", interactive.text);
  const staffPatch = await patch({ action: "set_mode", mode: "disabled" }, staff.cookie);
  check("API PATCH by staff without grant → 403", staffPatch.status === 403, String(staffPatch.status));
  const off = await patch({ action: "set_mode", mode: "disabled" });
  check("API PATCH owner turns monitoring off → 200 + audit row", off.status === 200 && (await db.from("zalo_personal_audit_log").select("id", { count: "exact", head: true }).eq("connection_id", c.id).eq("action", "group.mode_changed")).count === 2, off.text);
  const search = await get("/api/zalo-personal/messages/search", owner.cookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "smoke", from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) }) });
  check("API POST search (text in body) → results", search.status === 200 && JSON.parse(search.text).data.rows.length === 2, search.text.slice(0, 200));
  const getSearch = await get("/api/zalo-personal/messages/search?text=smoke", owner.cookie);
  check("API search via GET query string not offered (405)", getSearch.status === 405, String(getSearch.status));
  const grant = await get(`/api/zalo-personal/connections/${c.id}/access`, owner.cookie, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ granteeUserId: staff.id, scope: "connection", level: "read" }) });
  check("API grant read to staff → 200", grant.status === 200, grant.text);
  const staffNow = await get(`/api/zalo-personal/conversations/${conv!.id}/messages?limit=1`, staff.cookie);
  check("after grant: staff reads the group, 1 row + cursor", staffNow.status === 200 && JSON.parse(staffNow.text).data.rows.length === 1 && JSON.parse(staffNow.text).data.nextCursor !== null, staffNow.text.slice(0, 200));
  const hubStaff2 = await get("/apps", staff.cookie);
  check("after grant: card shown to staff", hubStaff2.text.includes("Trợ lý Zalo AI"));
  const all = [ov, search, staffNow, connPage].map((r) => r.text).join("\n");
  check("no secret / token / cookie value in any response", !all.includes(PASSWORD) && !/secret_encrypted|service_role|sb-[a-z0-9]+-auth-token/i.test(all));
}

async function cleanup() {
  if (connectionId) {
    for (const t of ["zalo_personal_audit_log", "zalo_personal_access_grants", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", connectionId);
    await db.from("zalo_personal_connections").delete().eq("id", connectionId);
  }
  for (const id of createdUsers) await db.auth.admin.deleteUser(id);
}

main()
  .catch((err: unknown) => {
    failures++;
    process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
  })
  .finally(async () => {
    await cleanup();
    process.stdout.write(failures ? `\n${failures} check(s) FAILED\n` : "\nall checks passed\n");
    process.exitCode = failures ? 1 : 0;
  });
