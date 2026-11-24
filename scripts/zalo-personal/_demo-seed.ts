// TEMPORARY — demo data for viewing the Phase 03 dashboard on the LOCAL Supabase only.
import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { encryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { workerSecretContext } from "../../src/lib/zalo-personal/config.ts";
import { generateWorkerSecret } from "../../src/lib/zalo-personal/signing.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url)) throw new Error("LOCAL Supabase only");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const key = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
const PASSWORD = "Demo-123456";

async function user(email: string, role: "admin" | "staff", name: string): Promise<string> {
  const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
  let id = list.users.find((u) => u.email === email)?.id;
  if (!id) {
    const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser ${error?.message}`);
    id = data.user.id;
  }
  await db.from("profiles").update({ role, is_active: true, full_name: name }).eq("id", id);
  return id;
}

async function wipe(connectionKey: string) {
  const { data } = await db.from("zalo_personal_connections").select("id").eq("connection_key", connectionKey).maybeSingle();
  if (!data) return;
  for (const t of ["zalo_personal_audit_log", "zalo_personal_access_grants", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) {
    const { error } = await db.from(t).delete().eq("connection_id", data.id);
    if (error) throw new Error(`wipe ${t}: ${error.message}`);
  }
  await db.from("zalo_personal_connections").delete().eq("id", data.id);
}

async function connection(connectionKey: string, owner: string, _label: string) {
  await wipe(connectionKey);
  const { data: c, error } = await db.from("zalo_personal_connections").insert({ connection_key: connectionKey, owner_user_id: owner }).select("id").single();
  if (error) throw new Error(`connection ${error.message}`);
  const workerId = randomUUID();
  const { error: we } = await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: `${connectionKey}-win`, connection_id: c.id, secret_encrypted: encryptSecret(generateWorkerSecret(), key, workerSecretContext(workerId)) });
  if (we) throw new Error(`worker ${we.message}`);
  return { id: c.id as string, workerId };
}

let n = 0;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function ev(p: { type: "group" | "user"; conv: string; sender: string; text: string | null; at: number; messageType?: string; isSelf?: boolean; mentionsSelf?: boolean; mentions?: unknown[]; kind?: string }) {
  n++;
  const kind = p.kind ?? "message";
  return {
    eventKey: createHash("sha256").update(`demo-${n}-${p.conv}-${Date.now()}`).digest("hex"),
    kind,
    conversationType: p.type,
    conversationId: p.conv,
    externalMessageId: kind === "message" ? `demo${Date.now()}${n}` : null,
    senderId: kind === "message" ? p.sender : null,
    messageType: kind === "message" ? (p.messageType ?? "text") : null,
    text: p.text,
    textLength: p.text?.length ?? 0,
    mentions: p.mentions ?? [],
    mentionsSelf: p.mentionsSelf ?? false,
    isSelf: p.isSelf ?? false,
    subtype: null,
    sentAt: minutesAgo(p.at),
    receivedAt: minutesAgo(p.at),
  };
}

async function ingest(workerId: string, account: string, events: ReturnType<typeof ev>[]) {
  for (let i = 0; i < events.length; i += 25) {
    const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: account, p_events: events.slice(i, i + 25) });
    if (error) throw new Error(`ingest ${error.message}`);
    if (data && data.ok === false) throw new Error(`ingest ${JSON.stringify(data)}`);
  }
}

async function heartbeat(workerId: string, account: string | null, state: Record<string, unknown>) {
  const { data, error } = await db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: account, p_state: state });
  if (error) throw new Error(`heartbeat ${error.message}`);
  if (data && data.ok === false) throw new Error(`heartbeat ${JSON.stringify(data)}`);
}

async function groupId(connectionId: string, ext: string): Promise<string> {
  const { data, error } = await db.from("zalo_personal_groups").select("id").eq("connection_id", connectionId).eq("external_group_id", ext).single();
  if (error) throw new Error(`group ${error.message}`);
  return data.id;
}

async function main() {
  const owner = await user("chushop@theodoihangve.local", "admin", "Chủ shop (demo)");
  const staff = await user("nhanvien@theodoihangve.local", "staff", "Nhân viên kho (demo)");

  // ---------------- connection 1: healthy
  const ACC1 = "8400000000000000001";
  const c1 = await connection("demo-shop", owner, "Zalo Shop Chăn Ga");
  await heartbeat(c1.workerId, ACC1, { sessionState: "authenticated", listenerState: "active", outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0 });

  const G_KHO = "2600000000000000001";
  const G_NCC = "2600000000000000002";
  const G_GD = "2600000000000000003";
  await ingest(c1.workerId, ACC1, [
    ev({ type: "group", conv: G_KHO, sender: "1", text: null, at: 600, kind: "group_discovery" }),
    ev({ type: "group", conv: G_NCC, sender: "1", text: null, at: 600, kind: "group_discovery" }),
    ev({ type: "group", conv: G_GD, sender: "1", text: null, at: 600, kind: "group_discovery" }),
  ]);
  const gKho = await groupId(c1.id, G_KHO);
  const gNcc = await groupId(c1.id, G_NCC);
  const gGd = await groupId(c1.id, G_GD);
  await db.from("zalo_personal_groups").update({ display_name: "Kho Bắc Ninh" }).eq("id", gKho);
  await db.from("zalo_personal_groups").update({ display_name: "NCC vải cotton" }).eq("id", gNcc);
  await db.from("zalo_personal_groups").update({ display_name: "Gia đình" }).eq("id", gGd);

  for (const [g, mode, note] of [
    [gKho, "monitor", "Đã thông báo trong nhóm ngày 20/11, mọi người đồng ý"],
    [gNcc, "mention_only", "NCC đồng ý qua tin nhắn"],
  ] as const) {
    await db.rpc("zp_update_group", { p_actor: owner, p_connection_id: c1.id, p_group_id: g, p_action: "grant_consent", p_mode: null, p_note: note });
    await db.rpc("zp_update_group", { p_actor: owner, p_connection_id: c1.id, p_group_id: g, p_action: "set_mode", p_mode: mode, p_note: null });
  }

  const people = ["3000000000000000011", "3000000000000000012", "3000000000000000013"];
  const lines = [
    "Hôm nay kho nhận 3 kiện vải từ NCC, đã kiểm đủ số lượng.",
    "Bộ chăn ga 1m8 màu xám còn 12 bộ, cần gọi thêm hàng.",
    "Đơn Shopee #2411 khách đổi size, mình xử lý chiều nay nhé.",
    "Ok anh, em ghi nhận rồi.",
    "Mai 9h có xe tới lấy hàng hoàn.",
    "Ai cầm chìa khoá kho 2 vậy?",
    "Em đây ạ, lát em mang qua.",
    "Nhớ chụp ảnh kiện hàng trước khi mở nhé.",
  ];
  const kho: ReturnType<typeof ev>[] = [];
  for (let i = 0; i < 45; i++) kho.push(ev({ type: "group", conv: G_KHO, sender: people[i % 3]!, text: `${lines[i % lines.length]}`, at: 45 * 30 - i * 30 }));
  kho.push(ev({ type: "group", conv: G_KHO, sender: people[0]!, text: null, at: 20, messageType: "image" }));
  kho.push(ev({ type: "group", conv: G_KHO, sender: people[1]!, text: null, at: 15, messageType: "sticker" }));
  kho.push(ev({ type: "group", conv: G_KHO, sender: people[2]!, text: '<b>thử</b> <script>alert("x")</script> — HTML hiển thị dạng chữ', at: 10 }));
  kho.push(ev({ type: "group", conv: G_KHO, sender: ACC1, text: "Cảm ơn cả nhà, mình xem rồi.", at: 5, isSelf: true }));
  await ingest(c1.workerId, ACC1, kho);

  await ingest(c1.workerId, ACC1, [
    ev({ type: "group", conv: G_NCC, sender: "3000000000000000021", text: "Giá vải tuần này không đổi.", at: 200 }), // not a mention → dropped
    ev({ type: "group", conv: G_NCC, sender: "3000000000000000021", text: "@Shop bên mình lấy thêm 200m không ạ?", at: 120, mentionsSelf: true, mentions: [{ uid: ACC1, pos: 0, len: 5, kind: "user" }] }),
    ev({ type: "group", conv: G_NCC, sender: "3000000000000000022", text: "@Shop hoá đơn tháng 11 em gửi file rồi nhé", at: 60, mentionsSelf: true, mentions: [{ uid: ACC1, pos: 0, len: 5, kind: "user" }] }),
  ]);

  // 1-1 chats: metadata only (default policy)
  await ingest(c1.workerId, ACC1, [
    ev({ type: "user", conv: "3000000000000000031", sender: "3000000000000000031", text: null, at: 90 }),
    ev({ type: "user", conv: "3000000000000000031", sender: ACC1, text: null, at: 85, isSelf: true }),
    ev({ type: "user", conv: "3000000000000000032", sender: "3000000000000000032", text: null, at: 30, messageType: "image" }),
  ]);
  await heartbeat(c1.workerId, ACC1, { sessionState: "authenticated", listenerState: "active", outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastMessageReceivedAt: minutesAgo(5), lastDeliveryOkAt: minutesAgo(1) });

  // grant staff read access on connection 1
  await db.rpc("zp_grant_access", { p_actor: owner, p_connection_id: c1.id, p_grantee: staff, p_scope: "connection", p_conversation_id: null, p_level: "read", p_note: "Xem nhóm kho" });

  // ---------------- connection 2: worker online but session expired, plus a dead letter
  const ACC2 = "8400000000000000002";
  const c2 = await connection("demo-ca-nhan", owner, "Zalo cá nhân");
  await heartbeat(c2.workerId, ACC2, { sessionState: "authenticated", listenerState: "active", outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0 });
  await heartbeat(c2.workerId, ACC2, { sessionState: "rejected", listenerState: "error", outboxDepth: 3, deadLetterCount: 1, outboxFullDrops: 0, lastErrorCategory: "session_expired" });

  process.stdout.write(`done. login: chushop@theodoihangve.local / ${PASSWORD} (owner) — nhanvien@theodoihangve.local / ${PASSWORD} (staff, read grant)\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
