// ============================================================
// ZALO PERSONAL Phase 03 — worker / connection health from the SEPARATE
// signals Phase 02 stores (pure, unit tested). Never concludes "Zalo is
// working" from the backend being up: the only proof of life is a recent
// heartbeat, and each signal is judged on its own:
//
//   heartbeat age          worker process online?            (server clock)
//   session_state          Zalo session authenticated?
//   listener_state         zca-js listener receiving?
//   outbox / dead letters  events reaching the backend?
//   last_error_category    worker-reported category (never a raw error)
//
//   health          meaning
//   connected       fresh heartbeat, logged in, listener active, delivery OK
//   degraded        online and logged in, but listener not active or delivery failing
//   auth_required   online but not logged in / session rejected / other account
//   unknown         never seen, or heartbeat stale (3–15 min): can't tell
//   disconnected    no heartbeat for > 15 min, or the worker reported it stopped
//   disabled        connection / worker switched off on the server
// ============================================================

export type Health = "connected" | "degraded" | "auth_required" | "unknown" | "disconnected" | "disabled";

export type Situation =
  | "ok"
  | "never_seen"
  | "heartbeat_stale"
  | "worker_offline"
  | "worker_stopped"
  | "not_logged_in"
  | "session_expired"
  | "account_mismatch"
  | "listener_not_active"
  | "listener_error"
  | "backend_not_receiving"
  | "connection_disabled"
  | "worker_revoked";

export interface SyncSignals {
  workerStatus: "active" | "revoked";
  lastHeartbeatAt: string | null;
  sessionState: "unknown" | "authenticated" | "unauthenticated" | "rejected";
  listenerState: "unknown" | "active" | "connecting" | "reconnecting" | "inactive" | "error";
  lastDeliveryOkAt: string | null;
  outboxDepth: number | null;
  deadLetterCount: number | null;
  outboxFullDrops: number | null;
  lastErrorCategory: string | null;
}

export interface WorkerHealth {
  health: Health;
  situation: Situation;
  heartbeatAgeMs: number | null;
}

export const HEARTBEAT_FRESH_MS = 3 * 60_000; // worker sends one every 60 s (+ on every state change)
export const HEARTBEAT_OFFLINE_MS = 15 * 60_000;
export const DELIVERY_STALE_MS = 5 * 60_000;

/** Categories the worker reports when the BACKEND does not take its events. */
const DELIVERY_ERRORS = new Set(["backend_unreachable", "rate_limited", "account_not_bound", "auth_failed"]);

const age = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now.getTime() - t) : null;
};

export function classifyWorker(s: SyncSignals, connection: { status: "active" | "disabled"; lastErrorCategory: string | null }, now: Date = new Date()): WorkerHealth {
  const heartbeatAgeMs = age(s.lastHeartbeatAt, now);
  const out = (health: Health, situation: Situation): WorkerHealth => ({ health, situation, heartbeatAgeMs });

  if (connection.status !== "active") return out("disabled", "connection_disabled");
  if (s.workerStatus !== "active") return out("disabled", "worker_revoked");
  if (connection.lastErrorCategory === "account_mismatch") return out("auth_required", "account_mismatch");
  if (heartbeatAgeMs === null) return out("unknown", "never_seen");
  if (heartbeatAgeMs > HEARTBEAT_OFFLINE_MS) return out("disconnected", "worker_offline");
  // the worker's final heartbeat on a clean stop says listener inactive
  if (s.listenerState === "inactive" && s.sessionState !== "unauthenticated" && s.sessionState !== "rejected") return out("disconnected", "worker_stopped");
  if (heartbeatAgeMs > HEARTBEAT_FRESH_MS) return out("unknown", "heartbeat_stale");

  // fresh heartbeat: the worker process is online
  if (s.sessionState === "rejected") return out("auth_required", "session_expired");
  if (s.sessionState === "unauthenticated" || (s.sessionState === "unknown" && s.listenerState !== "active")) return out("auth_required", "not_logged_in");
  if (s.listenerState === "error") return out("degraded", "listener_error");
  if (s.listenerState !== "active") return out("degraded", "listener_not_active");

  const deliveryAge = age(s.lastDeliveryOkAt, now);
  const backlog = (s.outboxDepth ?? 0) > 0 && (deliveryAge === null || deliveryAge > DELIVERY_STALE_MS);
  if ((s.lastErrorCategory && DELIVERY_ERRORS.has(s.lastErrorCategory)) || (s.deadLetterCount ?? 0) > 0 || backlog) return out("degraded", "backend_not_receiving");
  return out("connected", "ok");
}

/** Worst first: the connection shows its best worker, the overview its worst connection. */
const ORDER: Health[] = ["connected", "degraded", "auth_required", "unknown", "disconnected", "disabled"];

export function bestHealth(list: readonly WorkerHealth[]): WorkerHealth | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => ORDER.indexOf(a.health) - ORDER.indexOf(b.health) || (a.heartbeatAgeMs ?? Infinity) - (b.heartbeatAgeMs ?? Infinity))[0]!;
}

export const NO_WORKER: WorkerHealth = { health: "unknown", situation: "never_seen", heartbeatAgeMs: null };

export const HEALTH_LABEL: Record<Health, string> = {
  connected: "Đang kết nối",
  degraded: "Suy giảm",
  auth_required: "Cần đăng nhập",
  unknown: "Không rõ",
  disconnected: "Mất kết nối",
  disabled: "Đã tắt",
};

export const HEALTH_TONE: Record<Health, "success" | "warning" | "danger" | "info" | "neutral"> = {
  connected: "success",
  degraded: "warning",
  auth_required: "danger",
  unknown: "neutral",
  disconnected: "danger",
  disabled: "neutral",
};

/** Plain Vietnamese explanation + what to do on the Windows machine. No raw error text. */
export const SITUATION_TEXT: Record<Situation, { title: string; action: string }> = {
  ok: { title: "Worker online, Zalo đã đăng nhập, listener đang nhận tin và backend nhận sự kiện bình thường.", action: "" },
  never_seen: { title: "Chưa từng nhận heartbeat từ worker.", action: "Cấp worker (zalo-personal:admin worker:create), nạp secret trên máy Windows và bật ZP_INGEST_ENABLED." },
  heartbeat_stale: { title: "Heartbeat đã cũ (quá 3 phút): không xác định được trạng thái hiện tại.", action: "Kiểm tra máy Windows còn bật, còn mạng và worker còn chạy (npm run status)." },
  worker_offline: { title: "Worker offline: không có heartbeat hơn 15 phút.", action: "Khởi động lại worker trên máy Windows (npm run start trong services/zalo-personal-worker)." },
  worker_stopped: { title: "Worker đã dừng (heartbeat cuối báo listener ngừng hoạt động).", action: "Nếu không chủ động dừng: chạy npm run resume rồi npm run start trên máy Windows." },
  not_logged_in: { title: "Worker online nhưng Zalo chưa đăng nhập (hoặc đang chờ quét QR).", action: "Đăng nhập trên máy Windows: npm run login rồi quét QR bằng điện thoại. QR không bao giờ hiển thị trên dashboard." },
  session_expired: { title: "Phiên đăng nhập Zalo đã hết hạn hoặc bị Zalo từ chối.", action: "Đăng nhập lại trên máy Windows (npm run login). Nếu lặp lại, kiểm tra tài khoản trên điện thoại trước." },
  account_mismatch: { title: "Worker đang đăng nhập một tài khoản Zalo KHÁC tài khoản đã gắn với kết nối này.", action: "Đăng xuất worker (npm run logout) và đăng nhập đúng tài khoản. Sự kiện của tài khoản khác bị từ chối." },
  listener_not_active: { title: "Zalo đã đăng nhập nhưng listener chưa hoạt động (đang kết nối / kết nối lại).", action: "Thường tự hồi phục sau vài phút. Nếu kéo dài, xem log worker trên máy Windows." },
  listener_error: { title: "Listener gặp lỗi và đã ngừng nhận tin.", action: "Xem log worker trên máy Windows, rồi khởi động lại worker." },
  backend_not_receiving: { title: "Listener hoạt động nhưng sự kiện chưa tới được backend (outbox tồn đọng, dead-letter hoặc lỗi gửi).", action: "Kiểm tra ZP_INGEST_URL, mạng và secret của worker; xem số dead-letter bên dưới (npm run ingest:status)." },
  connection_disabled: { title: "Kết nối đã bị tắt trên server: mọi sự kiện bị từ chối.", action: "Bật lại bằng script quản trị nếu cần." },
  worker_revoked: { title: "Worker đã bị thu hồi: mọi request của nó bị từ chối (403).", action: "Cấp worker mới nếu cần (zalo-personal:admin worker:create)." },
};
