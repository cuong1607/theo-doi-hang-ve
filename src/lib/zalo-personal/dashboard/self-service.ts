// ============================================================
// ZALO PERSONAL — self-service setup from the dashboard (pure orchestration,
// unit tested). What scripts/zalo-personal/admin.ts does for an operator, a
// user with "zalo_personal:connect" can now do for THEIR OWN connection:
//
//   createConnection   owner = the caller (never another user)
//   issueWorker        a worker credential: the HMAC secret is generated and
//                      encrypted on the server (AAD = worker id) and returned
//                      ONCE in the response, never stored in clear / logged
//   revokeWorker       its requests are refused (403) from now on
//   setStatus          pause / resume: the server rejects the connection's events
//
// Zalo login (QR) stays on the Windows machine. Ownership is re-checked by the
// database functions (00076); every change is audited there.
// ============================================================
import { randomBytes } from "node:crypto";

import { hasPermission } from "../../auth/permissions.ts";
import { foldVi } from "../../ai-assistant/text.ts";
import { buildScope, type Actor } from "./access.ts";
import type { DashboardStore, Result } from "./service.ts";

export type SelfServiceFailure = { ok: false; error: string };

export interface SelfServiceStore {
  createConnection(actorId: string, key: string, directMode: "off" | "metadata"): Promise<{ ok: true; id: string; key: string } | SelfServiceFailure>;
  issueWorker(actorId: string, connectionId: string, workerId: string, workerKey: string, secretEncrypted: string): Promise<{ ok: true; id: string; workerKey: string } | SelfServiceFailure>;
  revokeWorker(actorId: string, connectionId: string, workerId: string): Promise<{ ok: true; changed: boolean } | SelfServiceFailure>;
  setConnectionStatus(actorId: string, connectionId: string, status: "active" | "disabled"): Promise<{ ok: true; changed: boolean } | SelfServiceFailure>;
}

export interface WorkerSecrets {
  generate(): string;
  /** encrypts with the app key, bound to the worker id */
  encrypt(secret: string, workerId: string): string;
  newId(): string;
}

export interface SelfServiceDeps {
  dashboard: DashboardStore;
  store: SelfServiceStore;
  secrets: WorkerSecrets;
}

export const canConnect = (role: Actor["role"]) => hasPermission(role, "zalo_personal:connect");

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = <T>(error: "forbidden" | "not_found" | "invalid_input" | "conflict" | "server_error", code: string, message: string): Result<T> => ({ ok: false, error, code, message });

const STORE_ERRORS: Record<string, { error: "forbidden" | "not_found" | "invalid_input" | "conflict"; message: string }> = {
  not_found: { error: "not_found", message: "Không tìm thấy kết nối của bạn." },
  actor_invalid: { error: "forbidden", message: "Tài khoản của bạn không được tạo kết nối Zalo." },
  invalid_key: { error: "invalid_input", message: "Tên kết nối chỉ gồm chữ thường không dấu, số, - và _ (tối đa 32 ký tự)." },
  invalid_direct_mode: { error: "invalid_input", message: "Chế độ tin 1-1 không hợp lệ." },
  limit_reached: { error: "conflict", message: "Đã đạt giới hạn (tối đa 3 kết nối mỗi người, 2 worker đang hoạt động mỗi kết nối)." },
  key_taken: { error: "conflict", message: "Tên này đã được dùng. Hãy chọn tên khác." },
  connection_paused: { error: "conflict", message: "Kết nối đang tạm dừng: bật lại trước khi cấp worker." },
  invalid_worker_key: { error: "invalid_input", message: "Mã worker không hợp lệ." },
  invalid_secret: { error: "invalid_input", message: "Không tạo được secret." },
  invalid_status: { error: "invalid_input", message: "Trạng thái không hợp lệ." },
};
const fromStore = <T>(code: string): Result<T> => {
  const m = STORE_ERRORS[code];
  return m ? fail(m.error, code, m.message) : fail("server_error", "server_error", "Không thực hiện được thao tác. Vui lòng thử lại.");
};

/** "Shop chính" → "shop-chinh"; empty → "zalo". Always matches the DB key pattern. */
export function slugKey(name: string | undefined): string {
  const s = foldVi(name ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return s || "zalo";
}
const suffix = () => randomBytes(2).toString("hex");

async function ownsConnection(deps: SelfServiceDeps, actor: Actor, connectionId: string): Promise<boolean> {
  const { connections, grants } = await deps.dashboard.loadAccess(actor.userId);
  return buildScope(actor, connections, grants).connections.get(connectionId)?.owner === true;
}

export async function createConnection(deps: SelfServiceDeps, actor: Actor, input: { name?: string; directMode: "off" | "metadata" }): Promise<Result<{ id: string; key: string }>> {
  if (!canConnect(actor.role)) return fail("forbidden", "forbidden", "Bạn không có quyền tạo kết nối Zalo.");
  // a readable key from the name + a short random suffix (keys are global and unique)
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = `${slugKey(input.name)}-${suffix()}`;
    const r = await deps.store.createConnection(actor.userId, key, input.directMode);
    if (r.ok) return ok({ id: r.id, key: r.key });
    if (r.error !== "key_taken") return fromStore(r.error);
  }
  return fromStore("key_taken");
}

export interface IssuedWorker {
  workerKey: string;
  connectionKey: string;
  /** shown ONCE; never stored in clear, never logged */
  secret: string;
  envLines: string[];
}

export async function issueWorker(deps: SelfServiceDeps, actor: Actor, connectionId: string, ingestUrl: string): Promise<Result<IssuedWorker>> {
  if (!canConnect(actor.role)) return fail("forbidden", "forbidden", "Bạn không có quyền cấp worker.");
  if (!(await ownsConnection(deps, actor, connectionId))) return fromStore("not_found");
  const [conn] = await deps.dashboard.connections([connectionId]);
  if (!conn) return fromStore("not_found");
  const workerId = deps.secrets.newId();
  const workerKey = `${conn.connectionKey}-w${suffix()}`.slice(0, 48);
  const secret = deps.secrets.generate();
  const r = await deps.store.issueWorker(actor.userId, connectionId, workerId, workerKey, deps.secrets.encrypt(secret, workerId));
  if (!r.ok) return fromStore(r.error);
  return ok({
    workerKey: r.workerKey,
    connectionKey: conn.connectionKey,
    secret,
    envLines: [`ZP_CONNECTION_ID=${conn.connectionKey}`, `ZP_WORKER_KEY=${r.workerKey}`, `ZP_INGEST_URL=${ingestUrl}`, "ZP_INGEST_ENABLED=true"],
  });
}

export async function revokeWorker(deps: SelfServiceDeps, actor: Actor, connectionId: string, workerId: string): Promise<Result<{ changed: boolean }>> {
  if (!canConnect(actor.role)) return fail("forbidden", "forbidden", "Bạn không có quyền thu hồi worker.");
  const r = await deps.store.revokeWorker(actor.userId, connectionId, workerId);
  return r.ok ? ok({ changed: r.changed }) : fromStore(r.error);
}

export async function setConnectionStatus(deps: SelfServiceDeps, actor: Actor, connectionId: string, status: "active" | "disabled"): Promise<Result<{ changed: boolean }>> {
  if (!canConnect(actor.role)) return fail("forbidden", "forbidden", "Bạn không có quyền đổi trạng thái kết nối.");
  const r = await deps.store.setConnectionStatus(actor.userId, connectionId, status);
  return r.ok ? ok({ changed: r.changed }) : fromStore(r.error);
}

/**
 * Where the worker must send its events: this app's public origin. Only https
 * (or http on localhost for local tests) — mirrors the worker's own rule.
 */
export function ingestUrlFrom(origin: string): string | null {
  try {
    const u = new URL(origin);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "https:" || (local && u.protocol === "http:") ? u.origin : null;
  } catch {
    return null;
  }
}
