// ============================================================
// ZALO PERSONAL Phase 02 — operator CLI (no dashboard in this phase).
//
//   node --env-file=.env.local scripts/zalo-personal/admin.ts <command> [--flags]
//
//   connection:create --key primary --owner <profile uuid | email> [--direct off|metadata|content]
//   worker:create     --connection primary --worker win-01      (prints the HMAC secret ONCE)
//   worker:revoke     --worker win-01
//   group:set         --connection primary --group <id> --mode disabled|monitor|mention_only
//                     [--consent-by <uuid | email>] [--note "…"] [--name "…"]
//   direct:set        --connection primary --mode off|metadata|content
//   status            --connection primary
//   messages:recent   --connection primary [--limit 10] [--show-text]
//
// Safety: refuses a non-local Supabase URL unless ZP_ADMIN_ALLOW_REMOTE=yes
// (production needs the owner's explicit approval). Uses the service-role
// key from the env; never prints it. The worker secret is generated here,
// stored encrypted (APP_ENCRYPTION_KEY, AAD = worker id) and shown once.
// ============================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { encryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { workerSecretContext } from "../../src/lib/zalo-personal/config.ts";
import { generateWorkerSecret, WORKER_KEY_PATTERN } from "../../src/lib/zalo-personal/signing.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const out = (line: string) => process.stdout.write(`${line}\n`);

function flags(argv: string[]): Record<string, string | true> {
  const f: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) f[a.slice(2)] = true;
    else {
      f[a.slice(2)] = next;
      i++;
    }
  }
  return f;
}

function need(f: Record<string, string | true>, name: string): string {
  const v = f[name];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Thiếu --${name}`);
  return v.trim();
}

function db(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/.test(url);
  if (!local && process.env.ZP_ADMIN_ALLOW_REMOTE !== "yes") {
    throw new Error(`Từ chối: Supabase không phải local (${new URL(url).host}). Chỉ chạy lên production khi đã được phê duyệt, với ZP_ADMIN_ALLOW_REMOTE=yes.`);
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function resolveProfile(client: SupabaseClient, ref: string): Promise<string> {
  let id = ref;
  if (!UUID.test(ref)) {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`Không đọc được danh sách user (${error.code ?? "?"})`);
      const hit = data.users.find((u) => u.email?.toLowerCase() === ref.toLowerCase());
      if (hit) {
        id = hit.id;
        break;
      }
      if (data.users.length < 200) break;
    }
    if (!UUID.test(id)) throw new Error(`Không tìm thấy user ${ref}`);
  }
  const { data } = await client.from("profiles").select("id, is_active").eq("id", id).maybeSingle();
  if (!data) throw new Error("Profile không tồn tại.");
  if (!data.is_active) throw new Error("Profile đang bị khóa.");
  return id;
}

async function connectionId(client: SupabaseClient, key: string): Promise<string> {
  const { data, error } = await client.from("zalo_personal_connections").select("id").eq("connection_key", key).maybeSingle();
  if (error) throw new Error(`Lỗi đọc connection (${error.code ?? "?"})`);
  if (!data) throw new Error(`Connection "${key}" không tồn tại.`);
  return data.id as string;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const f = flags(rest);
  const client = db();

  switch (command) {
    case "connection:create": {
      const owner = await resolveProfile(client, need(f, "owner"));
      const direct = typeof f.direct === "string" ? f.direct : "metadata";
      const { data, error } = await client.from("zalo_personal_connections").insert({ connection_key: need(f, "key"), owner_user_id: owner, direct_message_mode: direct, created_by: owner }).select("id, connection_key").single();
      if (error) throw new Error(`Không tạo được connection (${error.code ?? "?"}: ${error.message})`);
      out(`Đã tạo connection "${data.connection_key}" (${data.id}), chủ sở hữu ${owner}, tin 1-1: ${direct}.`);
      return;
    }
    case "worker:create": {
      const workerKey = need(f, "worker");
      if (!WORKER_KEY_PATTERN.test(workerKey)) throw new Error("--worker: 3-48 ký tự a-z, 0-9, _ và -.");
      const connId = await connectionId(client, need(f, "connection"));
      const key = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
      // the id is generated first so the secret is encrypted with its final AAD
      const id = crypto.randomUUID();
      const secret = generateWorkerSecret();
      const { error } = await client.from("zalo_personal_workers").insert({ id, worker_key: workerKey, connection_id: connId, secret_encrypted: encryptSecret(secret, key, workerSecretContext(id)) });
      if (error) throw new Error(`Không tạo được worker (${error.code ?? "?"}: ${error.message})`);
      out(`Đã tạo worker "${workerKey}" cho connection ${f.connection}.`);
      out("");
      out("WORKER SECRET (chỉ hiển thị MỘT lần — không lưu vào Git, không gửi qua chat):");
      out(secret);
      out("");
      out("Nạp vào worker trên Windows (secret được bảo vệ bằng DPAPI, không nằm trong .env):");
      out("  cd services\\zalo-personal-worker; npm run ingest:set-secret   (dán secret khi được hỏi)");
      return;
    }
    case "worker:revoke": {
      const { data, error } = await client.from("zalo_personal_workers").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("worker_key", need(f, "worker")).eq("status", "active").select("worker_key");
      if (error) throw new Error(`Lỗi (${error.code ?? "?"})`);
      out(data?.length ? `Đã thu hồi worker ${f.worker}. Mọi request của nó từ giờ bị 403.` : "Không có worker đang hoạt động với key này.");
      return;
    }
    case "group:set": {
      const connId = await connectionId(client, need(f, "connection"));
      const groupId = need(f, "group");
      const mode = need(f, "mode");
      if (!["disabled", "monitor", "mention_only"].includes(mode)) throw new Error("--mode: disabled | monitor | mention_only (interactive cần phase gửi tin đã xác minh).");
      const nowIso = new Date().toISOString();
      const patch: Record<string, unknown> = { mode, mode_changed_at: nowIso };
      if (typeof f.name === "string") patch.display_name = f.name;
      if (mode !== "disabled") {
        if (typeof f["consent-by"] !== "string") throw new Error("Bật thu thập nội dung cần --consent-by <người xác nhận đã có sự đồng ý của nhóm>.");
        const by = await resolveProfile(client, f["consent-by"]);
        Object.assign(patch, { consent_status: "granted", consent_recorded_by: by, consent_recorded_at: nowIso, consent_note: typeof f.note === "string" ? f.note.slice(0, 500) : null, mode_changed_by: by });
      }
      // update an existing (discovered) group without rewriting how it was discovered; insert only when unknown
      const updated = await client.from("zalo_personal_groups").update(patch).eq("connection_id", connId).eq("external_group_id", groupId).select("external_group_id, mode, consent_status");
      if (updated.error) throw new Error(`Không cập nhật được nhóm (${updated.error.code ?? "?"}: ${updated.error.message})`);
      let row = updated.data?.[0];
      if (!row) {
        const inserted = await client.from("zalo_personal_groups").insert({ connection_id: connId, external_group_id: groupId, discovered_via: "admin", ...patch }).select("external_group_id, mode, consent_status").single();
        if (inserted.error) throw new Error(`Không tạo được nhóm (${inserted.error.code ?? "?"}: ${inserted.error.message})`);
        row = inserted.data;
      }
      out(`Nhóm ${row.external_group_id}: mode=${row.mode}, consent=${row.consent_status}.`);
      return;
    }
    case "direct:set": {
      const mode = need(f, "mode");
      const { error } = await client.from("zalo_personal_connections").update({ direct_message_mode: mode }).eq("id", await connectionId(client, need(f, "connection")));
      if (error) throw new Error(`Lỗi (${error.code ?? "?"}: ${error.message})`);
      out(`Tin 1-1 của connection ${f.connection}: ${mode}.`);
      return;
    }
    case "status": {
      const connId = await connectionId(client, need(f, "connection"));
      const [conn, workers, sync, groups, messages, events] = await Promise.all([
        client.from("zalo_personal_connections").select("connection_key, status, direct_message_mode, zalo_account_id, last_heartbeat_at, last_connected_at, last_error_category").eq("id", connId).single(),
        client.from("zalo_personal_workers").select("worker_key, status, last_seen_at").eq("connection_id", connId),
        client.from("zalo_personal_sync_state").select("*").eq("connection_id", connId),
        client.from("zalo_personal_groups").select("external_group_id, display_name, mode, consent_status, discovered_via, last_seen_at").eq("connection_id", connId),
        client.from("zalo_personal_messages").select("id", { count: "exact", head: true }).eq("connection_id", connId),
        client.from("zalo_personal_ingestion_events").select("outcome").eq("connection_id", connId).limit(5000),
      ]);
      const outcomes: Record<string, number> = {};
      for (const e of events.data ?? []) outcomes[e.outcome as string] = (outcomes[e.outcome as string] ?? 0) + 1;
      const account = conn.data?.zalo_account_id as string | null;
      out(JSON.stringify({ connection: { ...conn.data, zalo_account_id: account ? `…${account.slice(-4)}` : null }, workers: workers.data, syncState: sync.data, groups: groups.data, messagesStored: messages.count, ingestionOutcomes: outcomes }, null, 2));
      return;
    }
    case "messages:recent": {
      const connId = await connectionId(client, need(f, "connection"));
      const limit = Math.min(50, Number(f.limit ?? 10) || 10);
      const cols = `external_message_id, message_type, text_length, content_stored, is_self, mentions_self, sent_at, ingested_at, zalo_personal_conversations!inner(conversation_type, external_conversation_id)${f["show-text"] ? ", text_content" : ""}`;
      const { data, error } = await client.from("zalo_personal_messages").select(cols).eq("connection_id", connId).order("ingested_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`Lỗi (${error.code ?? "?"})`);
      out(JSON.stringify(data, null, 2));
      if (!f["show-text"]) out("(nội dung tin bị ẩn — thêm --show-text để xem trên máy của bạn)");
      return;
    }
    default:
      out("Lệnh: connection:create | worker:create | worker:revoke | group:set | direct:set | status | messages:recent");
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`Lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
