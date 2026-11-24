// ============================================================
// ZALO PERSONAL Phase 04 — Vietnamese search benchmark (LOCAL Supabase only).
// Seeds a synthetic group conversation through the real Phase 02 ingest RPC,
// then compares, per query:
//   fts    zp_ai_search (folded full-text, 00075) with keywords(query)
//   ilike  Phase 03 style: raw text ILIKE '%query%' (accent-sensitive)
// against a ground truth computed in TS (folded phrase match). Reports
// recall@200, precision@20 and latency. Cleans up everything it created.
//
//   node --env-file=<local env> scripts/zalo-personal/ai-search-benchmark.ts [messages=3000]
// ============================================================
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { keywords, foldVi } from "../../src/lib/ai-assistant/text.ts";
import { encryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { workerSecretContext } from "../../src/lib/zalo-personal/config.ts";
import { generateWorkerSecret } from "../../src/lib/zalo-personal/signing.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url)) throw new Error("benchmark needs the LOCAL Supabase");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const N = Number(process.argv[2] ?? 3000);
const RUN = randomBytes(3).toString("hex");
const ACC = `88${Date.now()}`.slice(0, 18);
const GROUP = `28${Date.now()}`.slice(0, 19);

// deterministic pseudo-random
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;

const NAMES = ["anh Hùng", "chị Hằng", "anh Hưng", "Thịnh", "chị Trang", "Ngọc Ánh", "anh Đức", "Long"];
const PRODUCTS = ["vải cotton", "vải lụa", "chăn ga", "gối nằm", "đệm bông", "rèm cửa", "khăn tắm"];
const ACTIONS = ["đã về kho", "giao trễ 2 ngày", "chưa xác nhận số lượng", "tăng giá 5%", "hết hàng", "cần kiểm lại", "đã chốt đơn"];
const PLACES = ["kho Bắc Ninh", "kho Hà Đông", "xưởng Thủ Đức", "NCC Hưng Thịnh"];
const NOISE = ["ok", "dạ vâng", "em ghi nhận", "để em xem", "cảm ơn cả nhà", "chiều nay họp nhé", "👍"];

function sentence(): string {
  if (rnd() < 0.25) return pick(NOISE);
  let s = `${pick(NAMES)} báo ${pick(PRODUCTS)} ${pick(ACTIONS)} ở ${pick(PLACES)}`;
  const r = rnd();
  if (r < 0.2) s = foldVi(s); // typed without accents
  else if (r < 0.25) s = s.toUpperCase();
  else if (r < 0.3) s = s.normalize("NFD"); // decomposed input
  return s;
}

const QUERIES = ["vải lụa", "vai lua", "Vải LỤA", "chưa xác nhận", "chua xac nhan", "Ngọc Ánh", "Hưng Thịnh", "kho Bắc Ninh", "đệm bông", "giao trễ"];

const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

async function main() {
  const { data: u } = await db.auth.admin.createUser({ email: `zp4-bench-${RUN}@example.test`, password: `Pw-${RUN}-x9`, email_confirm: true });
  const userId = u.user!.id;
  const { data: c } = await db.from("zalo_personal_connections").insert({ connection_key: `bench-${RUN}`, owner_user_id: userId }).select("id").single();
  const connectionId = c!.id as string;
  const workerId = randomUUID();
  await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: `bench-w-${RUN}`, connection_id: connectionId, secret_encrypted: encryptSecret(generateWorkerSecret(), parseEncryptionKey(process.env.APP_ENCRYPTION_KEY), workerSecretContext(workerId)) });
  try {
    await db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: ACC, p_state: { sessionState: "authenticated", listenerState: "active", outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0 } });
    let k = 0;
    const ev = (text: string, at: number) => ({ eventKey: createHash("sha256").update(`b${RUN}${++k}`).digest("hex"), kind: "message", conversationType: "group", conversationId: GROUP, externalMessageId: `b${RUN}${k}`, senderId: "3000000000000000001", messageType: "text", text, textLength: text.length, mentions: [], mentionsSelf: false, isSelf: false, subtype: null, sentAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString() });
    await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: ACC, p_events: [ev("khởi tạo", Date.now() - 40 * 86_400_000)] });
    const { data: g } = await db.from("zalo_personal_groups").select("id").eq("connection_id", connectionId).eq("external_group_id", GROUP).single();
    await db.rpc("zp_update_group", { p_actor: userId, p_connection_id: connectionId, p_group_id: g!.id, p_action: "grant_consent", p_mode: null, p_note: "benchmark" });
    await db.rpc("zp_update_group", { p_actor: userId, p_connection_id: connectionId, p_group_id: g!.id, p_action: "set_mode", p_mode: "monitor", p_note: null });

    const corpus: string[] = [];
    const t0 = Date.now() - 30 * 86_400_000;
    const seedStart = Date.now();
    for (let i = 0; i < N; i += 25) {
      const batch = Array.from({ length: Math.min(25, N - i) }, (_, j) => {
        const s = sentence();
        corpus.push(s);
        return ev(s, t0 + (i + j) * 60_000);
      });
      const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: ACC, p_events: batch });
      if (error || data?.ok !== true) throw new Error(`ingest ${error?.message ?? JSON.stringify(data)}`);
    }
    process.stdout.write(`seeded ${corpus.length} messages in ${((Date.now() - seedStart) / 1000).toFixed(1)} s\n\n`);

    const from = new Date(t0 - 60_000).toISOString();
    const to = new Date().toISOString();
    process.stdout.write("| query | relevant | fts recall@200 | fts precision@20 | fts p50 ms | ilike recall | ilike p50 ms |\n|---|---|---|---|---|---|---|\n");
    for (const q of QUERIES) {
      const phrase = foldVi(q);
      const truth = new Set(corpus.map((s, i) => [s, i] as const).filter(([s]) => ` ${foldVi(s).replace(/[^a-z0-9]+/g, " ")} `.includes(` ${phrase} `)).map(([s]) => s));
      const terms = keywords(q).length ? keywords(q) : phrase.split(/\s+/);
      const ftsMs: number[] = [];
      let fts: Array<{ text_content: string }> = [];
      for (let r = 0; r < 10; r++) {
        const s = performance.now();
        const { data, error } = await db.rpc("zp_ai_search", { p_full: [connectionId], p_group: [], p_ids: [], p_conversation_ids: null, p_connection_id: null, p_type: null, p_sender: null, p_message_type: null, p_from: from, p_to: to, p_terms: terms, p_limit: 200 });
        ftsMs.push(performance.now() - s);
        if (error) throw new Error(error.message);
        fts = data;
      }
      const ilikeMs: number[] = [];
      let ilike: Array<{ text_content: string }> = [];
      for (let r = 0; r < 10; r++) {
        const s = performance.now();
        const { data, error } = await db.from("zalo_personal_messages").select("text_content").eq("connection_id", connectionId).ilike("text_content", `%${q}%`).limit(5000);
        ilikeMs.push(performance.now() - s);
        if (error) throw new Error(error.message);
        ilike = data;
      }
      const hit = (rows: Array<{ text_content: string }>) => rows.filter((r) => truth.has(r.text_content)).length;
      const top20 = fts.slice(0, 20);
      const relevantCount = corpus.filter((s) => truth.has(s)).length;
      const ftsRecall = relevantCount ? Math.min(1, hit(fts) / Math.min(relevantCount, 200)) : 1;
      const ilikeRecall = relevantCount ? hit(ilike) / relevantCount : 1;
      process.stdout.write(`| ${q} | ${relevantCount} | ${(ftsRecall * 100).toFixed(0)}% | ${top20.length ? ((hit(top20) / top20.length) * 100).toFixed(0) : "–"}% | ${pctl(ftsMs, 0.5).toFixed(0)} | ${(ilikeRecall * 100).toFixed(0)}% | ${pctl(ilikeMs, 0.5).toFixed(0)} |\n`);
    }
  } finally {
    for (const t of ["zalo_personal_audit_log", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", connectionId);
    await db.from("zalo_personal_connections").delete().eq("id", connectionId);
    await db.auth.admin.deleteUser(userId);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`ERROR ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
