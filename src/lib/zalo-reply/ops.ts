// ============================================================
// PHASE 07 — OPS-07 health evaluation. Pure (no I/O): the inputs come from
// zp_ops_snapshot (00081). A connection is NEVER "healthy" just because a
// process runs: it needs a fresh heartbeat AND an authenticated session AND
// an active listener, and nothing pending that a person must look at.
//
//   stopped                  connection switched off by its owner
//   unknown                  never reported (no worker state yet)
//   authentication_required  Zalo refused / kicked the session (manual check needed)
//   disconnected             heartbeat stale or listener down
//   degraded                 running, but something needs attention (reasons)
//   healthy                  everything above is fine
// Reasons are short codes (stored in zalo_personal_ops_state, shown with REASON_LABEL).
// ============================================================

export const HEALTH_STATES = ["healthy", "degraded", "disconnected", "authentication_required", "stopped", "unknown"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/** Worker heartbeat every 60 s (ZP_HEARTBEAT_INTERVAL_MS): 3 missed → disconnected. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;
/** The reply cron runs every minute: 5 minutes without a tick = the backend scheduler is not running. */
export const TICK_STALE_MS = 5 * 60_000;
export const OUTBOX_BACKLOG = 100;

/** Worker error categories that only a person can resolve (QR login / phone check). */
const AUTH_ERRORS = new Set(["session_rejected", "no_session", "session_unreadable", "kicked_by_server", "kicked_duplicate_connection", "auth_failed"]);

export interface SnapshotConnection {
  id: string;
  key: string;
  status: string;
  directMessageMode: string;
  accountBound: boolean;
  lastHeartbeatAt: string | null;
  lastErrorCategory: string | null;
  sync: {
    sessionState: string;
    listenerState: string;
    lastHeartbeatAt: string | null;
    lastMessageReceivedAt: string | null;
    lastDeliveryOkAt: string | null;
    lastIngestedAt: string | null;
    outboxDepth: number | null;
    deadLetters: number | null;
    lastErrorCategory: string | null;
    workerVersion: string | null;
  } | null;
  settings: { replyMode: string; sendEnabled: boolean; autoDirect: string; autoGroups: boolean; sendPaused: boolean; pausedReason: string | null; dailySendLimit: number } | null;
  lastScanAt: string | null;
  lastInboundAt: string | null;
  outbound: { pendingApproval: number; queued: number; sending: number; unknown: number; failed24h: number; sentToday: number; remindersQueued: number; lastSentAt: string | null } | null;
  groups: { total: number; mentionOnly: number; interactive: number; allowlisted: number } | null;
  directAllowlisted: number;
  linkedUsers: number;
  ops: { state: string; since: string; notifiedState: string | null; notifiedAt: string | null } | null;
}

export interface OpsContext {
  now: Date;
  /** PERSONAL_REPLY_ENABLED (the reply cron is expected to tick) */
  replyEnabled: boolean;
  lastTickAt: string | null;
  lastTickStatus: string | null;
}

const age = (now: Date, iso: string | null) => (iso ? now.getTime() - Date.parse(iso) : Number.POSITIVE_INFINITY);

export function classifyConnection(c: SnapshotConnection, ctx: OpsContext): { state: HealthState; reasons: string[] } {
  if (c.status !== "active") return { state: "stopped", reasons: ["connection_disabled"] };
  const s = c.sync;
  if (!s) return { state: "unknown", reasons: [c.accountBound ? "no_worker_state" : "never_connected"] };

  const listenerUp = s.listenerState === "active";
  const authError = AUTH_ERRORS.has(s.lastErrorCategory ?? "") || AUTH_ERRORS.has(c.lastErrorCategory ?? "");
  if (!listenerUp && (s.sessionState === "rejected" || s.sessionState === "unauthenticated" || authError)) {
    return { state: "authentication_required", reasons: [s.lastErrorCategory ?? c.lastErrorCategory ?? `session_${s.sessionState}`].map(code) };
  }
  if (age(ctx.now, s.lastHeartbeatAt ?? c.lastHeartbeatAt) > HEARTBEAT_STALE_MS) return { state: "disconnected", reasons: ["heartbeat_stale"] };
  if (!listenerUp) {
    if (s.listenerState === "connecting" || s.listenerState === "reconnecting") return { state: "degraded", reasons: [`listener_${s.listenerState}`] };
    return { state: "disconnected", reasons: [`listener_${code(s.listenerState)}`] };
  }

  const reasons: string[] = [];
  if ((s.deadLetters ?? 0) > 0) reasons.push("outbox_dead_letters");
  if ((s.outboxDepth ?? 0) >= OUTBOX_BACKLOG) reasons.push("outbox_backlog");
  if (c.settings?.sendPaused) reasons.push("send_paused");
  if ((c.outbound?.unknown ?? 0) > 0) reasons.push("delivery_unknown");
  if ((c.outbound?.failed24h ?? 0) > 0) reasons.push("send_failed_24h");
  if (ctx.replyEnabled && c.settings && c.settings.replyMode !== "disabled") {
    if (age(ctx.now, ctx.lastTickAt) > TICK_STALE_MS) reasons.push("reply_tick_stale");
    else if (ctx.lastTickStatus === "error") reasons.push("reply_tick_error");
  }
  return reasons.length ? { state: "degraded", reasons } : { state: "healthy", reasons: [] };
}

const code = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);

// ------------------------------------------------------------------ periodic check (reply cron)

export interface OpsStore {
  allConnectionIds(): Promise<string[]>;
  opsSnapshot(connectionIds: string[]): Promise<Record<string, unknown>>;
  /** records the state; the DB decides whether the owner is alerted (state change, ≤ 1 per state / 6 h) */
  opsObserve(connectionId: string, state: string, reasons: string[]): Promise<boolean>;
}

export interface OpsSnapshot {
  now: string;
  control: { emergencyStop: boolean; lastTickAt: string | null; lastTickStatus: string | null } | null;
  connections: SnapshotConnection[];
  ai: AiSnapshot | null;
  reminders: { health: ReminderSnapshot | null; zaloDeliveries24h: Record<string, number> } | null;
}

/** Runs after every reply cron tick: classify each connection, record it, alert on changes. */
export async function runOpsCheck(store: OpsStore, opts: { now: Date; replyEnabled: boolean }): Promise<{ checked: number; notified: number; states: Record<string, number> }> {
  const ids = await store.allConnectionIds();
  if (!ids.length) return { checked: 0, notified: 0, states: {} };
  const snap = (await store.opsSnapshot(ids)) as unknown as OpsSnapshot;
  const ctx: OpsContext = { now: opts.now, replyEnabled: opts.replyEnabled, lastTickAt: snap.control?.lastTickAt ?? null, lastTickStatus: snap.control?.lastTickStatus ?? null };
  let notified = 0;
  const states: Record<string, number> = {};
  for (const c of snap.connections ?? []) {
    const h = classifyConnection(c, ctx);
    states[h.state] = (states[h.state] ?? 0) + 1;
    if (await store.opsObserve(c.id, h.state, h.reasons).catch(() => false)) notified++;
  }
  return { checked: snap.connections?.length ?? 0, notified, states };
}

// ------------------------------------------------------------------ AI + reminders

export interface AiSnapshot {
  requests24h: number;
  completed24h: number;
  quotaErrors24h: number;
  otherErrors24h: number;
  refused24h: number;
  inputTokens24h: number;
  outputTokens24h: number;
  providers: string[];
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastErrorReason: string | null;
}
export type AiHealth = "unconfigured" | "fake" | "quota_limited" | "failing" | "ok" | "idle";

/** Gemini availability from configuration + the last 24 h of booked calls. */
export function classifyAi(ai: AiSnapshot | null, cfg: { enabled: boolean; provider: string; apiKeyConfigured: boolean; modelValid: boolean }): AiHealth {
  if (!cfg.enabled) return "unconfigured";
  if (cfg.provider === "fake") return "fake";
  if (!cfg.apiKeyConfigured || !cfg.modelValid) return "unconfigured";
  if (!ai || ai.requests24h === 0) return "idle";
  const lastErrorAfterOk = ai.lastErrorAt !== null && (ai.lastOkAt === null || Date.parse(ai.lastErrorAt) > Date.parse(ai.lastOkAt));
  if (lastErrorAfterOk && ai.quotaErrors24h > 0 && ["quota_exceeded", "rate_limit", "budget_exceeded", "budget"].includes(ai.lastErrorReason ?? "")) return "quota_limited";
  if (lastErrorAfterOk) return "failing";
  return "ok";
}

export interface ReminderSnapshot {
  pendingDue: number;
  claimed: number;
  failed: number;
  lastOkAt: string | null;
}
export type ReminderHealth = "off" | "ok" | "behind" | "stale" | "failing";

export function classifyReminders(r: ReminderSnapshot | null, tasksEnabled: boolean, now: Date): ReminderHealth {
  if (!tasksEnabled) return "off";
  if (!r) return "stale";
  if (age(now, r.lastOkAt) > TICK_STALE_MS) return "stale";
  if (r.pendingDue > 0) return "behind";
  if (r.failed > 0) return "failing";
  return "ok";
}

export const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: "Hoạt động tốt",
  degraded: "Cần chú ý",
  disconnected: "Mất kết nối",
  authentication_required: "Cần đăng nhập lại",
  stopped: "Đã tắt",
  unknown: "Chưa rõ",
};

export const REASON_LABEL: Record<string, string> = {
  connection_disabled: "Kết nối đang tắt",
  never_connected: "Worker chưa từng kết nối",
  no_worker_state: "Chưa nhận được trạng thái từ worker",
  heartbeat_stale: "Quá 3 phút không có heartbeat (worker tắt / mất mạng)",
  session_rejected: "Zalo từ chối phiên đăng nhập",
  session_unauthenticated: "Phiên chưa đăng nhập",
  no_session: "Chưa có phiên đăng nhập",
  session_unreadable: "Không đọc được phiên đã lưu",
  kicked_by_server: "Zalo đã đá phiên này",
  kicked_duplicate_connection: "Tài khoản đang mở Zalo Web / listener khác",
  auth_failed: "Backend từ chối chữ ký của worker",
  listener_connecting: "Đang kết nối",
  listener_reconnecting: "Đang kết nối lại",
  listener_inactive: "Listener không chạy",
  listener_error: "Listener lỗi",
  listener_unknown: "Listener chưa rõ trạng thái",
  outbox_dead_letters: "Có sự kiện không gửi được về backend (dead letter)",
  outbox_backlog: "Hàng chờ gửi về backend tồn đọng",
  send_paused: "Đang tạm dừng gửi",
  delivery_unknown: "Có tin chưa rõ đã gửi (cần đối soát)",
  send_failed_24h: "Có tin gửi thất bại trong 24 giờ",
  reply_tick_stale: "Bộ xử lý trả lời (cron) không chạy",
  reply_tick_error: "Bộ xử lý trả lời báo lỗi",
};

export const AI_HEALTH_LABEL: Record<AiHealth, string> = {
  unconfigured: "Chưa cấu hình (thiếu khóa / model hoặc AI đang tắt)",
  fake: "AI giả (chỉ dùng thử)",
  quota_limited: "Hết hạn mức / bị giới hạn tốc độ",
  failing: "Lỗi ở lần gọi gần nhất",
  ok: "Hoạt động",
  idle: "Chưa có lần gọi nào trong 24 giờ",
};

export const REMINDER_HEALTH_LABEL: Record<ReminderHealth, string> = {
  off: "Đang tắt",
  ok: "Hoạt động",
  behind: "Có lần nhắc quá hạn chưa xử lý",
  stale: "Bộ lập lịch không chạy (quá 5 phút)",
  failing: "Có lần nhắc lỗi trong 24 giờ",
};
