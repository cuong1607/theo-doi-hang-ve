// ============================================================
// PHASE SHOPEE-9A: production health — one model for /shopee/system-health.
//
// Health is tracked per DOMAIN, never one "Shopee healthy" boolean:
//   scheduler   heartbeat (pg_cron → scheduler route, every minute)
//   worker      heartbeat (bursts started by the scheduler / clicks)
//   queue       pending / running / retry / failed, oldest DUE wait, stale leases
//   api         calls + latency per endpoint, rate-limit cooldown
//   per shop    connection (auth), sync switch / circuit breaker, freshness
//               of every sync type vs its SLO, queue, last errors
// Pure derivation (deriveComponentHealth / deriveFreshness / deriveShopHealth
// / deriveAlerts) is separate from the DB loader so it is unit-tested.
// DB client injected; no "server-only" marker (tests drive it).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SyncConfig } from "./sync-config.ts";
import { getHeartbeats, RATE_LIMIT_HEARTBEAT, SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT, type HeartbeatRow } from "./sync-heartbeat.ts";

export type ComponentStatus = "healthy" | "degraded" | "unhealthy";
export type FreshnessStatus = "ok" | "stale" | "never" | "disabled";
export type ShopHealth = "healthy" | "degraded" | "needs_reauth" | "sync_stale" | "failed" | "paused" | "initializing";

export const SHOP_HEALTH_INFO: Record<ShopHealth, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  healthy: { label: "Ổn định", tone: "success" },
  degraded: { label: "Có lỗi, đang tự thử lại", tone: "warning" },
  needs_reauth: { label: "Cần kết nối lại Shopee", tone: "danger" },
  sync_stale: { label: "Dữ liệu chậm", tone: "warning" },
  failed: { label: "Đồng bộ thất bại", tone: "danger" },
  paused: { label: "Đang tạm dừng", tone: "neutral" },
  initializing: { label: "Đang khởi tạo (shop mới)", tone: "info" },
};

/** Sync types shown per shop, in priority order, with their label. */
export const HEALTH_DOMAINS = [
  { type: "order", label: "Đơn hàng" },
  { type: "return", label: "Trả hàng" },
  { type: "return_logistics", label: "Vận chuyển Hoàn Trả" },
  { type: "failed_delivery", label: "Vận chuyển Hoàn Hủy" },
  { type: "escrow", label: "Tài chính" },
  { type: "income", label: "Giải ngân" },
  { type: "payout", label: "Payout" },
  { type: "product", label: "Sản phẩm" },
] as const;

/** Types without which a shop is not "ready" yet (onboarding). */
const CORE_TYPES = ["product", "order", "escrow"];
const REAUTH_STATUSES = new Set(["expired", "revoked", "disconnected"]);

const minutesSince = (iso: string | null | undefined, now: Date) => (iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000)) : null);

export interface ComponentHealth {
  status: ComponentStatus;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  ageMinutes: number | null;
  message: string;
  result: Record<string, unknown> | null;
}

/** "18 phút" / "3 giờ 5 phút" / "2 ngày" — readable ages in messages. */
export function ageText(minutes: number): string {
  if (minutes < 60) return `${minutes} phút`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} giờ${minutes % 60 ? ` ${minutes % 60} phút` : ""}`;
  return `${Math.floor(minutes / 1440)} ngày`;
}

export function deriveComponentHealth(name: string, row: HeartbeatRow | null | undefined, warnAfterMinutes: number, now: Date): ComponentHealth {
  const age = minutesSince(row?.last_success_at, now);
  const base = { lastRunAt: row?.last_run_at ?? null, lastSuccessAt: row?.last_success_at ?? null, lastErrorAt: row?.last_error_at ?? null, lastError: row?.last_error ?? null, ageMinutes: age, result: row?.last_result ?? null };
  if (age === null) return { ...base, status: "unhealthy", message: `${name} chưa chạy thành công lần nào.` };
  if (age > warnAfterMinutes) return { ...base, status: "unhealthy", message: `${name} chưa chạy trong ${ageText(age)}.` };
  if (row?.last_error_at && new Date(row.last_error_at) > new Date(row.last_success_at!)) return { ...base, status: "degraded", message: `${name} vừa gặp lỗi: ${(row.last_error ?? "").slice(0, 120)}` };
  return { ...base, status: "healthy", message: `${name} chạy ${age === 0 ? "vừa xong" : `${age} phút trước`}.` };
}

export interface DomainFreshness {
  type: string;
  label: string;
  lastSyncedAt: string | null;
  ageMinutes: number | null;
  sloMinutes: number;
  status: FreshnessStatus;
  pending: number;
  running: number;
  retrying: number;
  failed24h: number;
  lastErrorCode: string | null;
}

export function deriveFreshness(input: { type: string; label: string; lastSyncedAt: string | null; sloMinutes: number; disabled: boolean; now: Date }): Pick<DomainFreshness, "type" | "label" | "lastSyncedAt" | "ageMinutes" | "sloMinutes" | "status"> {
  const age = minutesSince(input.lastSyncedAt, input.now);
  const status: FreshnessStatus = input.disabled ? "disabled" : age === null ? "never" : age > input.sloMinutes ? "stale" : "ok";
  return { type: input.type, label: input.label, lastSyncedAt: input.lastSyncedAt, ageMinutes: age, sloMinutes: input.sloMinutes, status };
}

export interface ShopHealthInput {
  connectionStatus: string | null;
  syncEnabled: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  domains: DomainFreshness[];
  now: Date;
}

export function deriveShopHealth(s: ShopHealthInput): ShopHealth {
  if (REAUTH_STATUSES.has(s.connectionStatus ?? "disconnected")) return "needs_reauth";
  if (!s.syncEnabled || (s.pausedUntil && new Date(s.pausedUntil) > s.now)) return "paused";
  const core = s.domains.filter((d) => CORE_TYPES.includes(d.type) && d.status !== "disabled");
  if (core.some((d) => d.status === "never")) return "initializing";
  if (s.domains.some((d) => d.status === "stale" && d.failed24h > 0 && d.pending + d.running + d.retrying === 0)) return "failed";
  if (s.domains.some((d) => d.status === "stale")) return "sync_stale";
  if (s.connectionStatus === "error" || s.domains.some((d) => d.retrying > 0 || d.failed24h > 0)) return "degraded";
  return "healthy";
}

export interface HealthAlert {
  level: "danger" | "warning" | "info";
  code: string;
  message: string;
  shopId?: string;
}

export interface ShopHealthRow {
  id: string;
  name: string;
  connectionStatus: string | null;
  tokenExpiresAt: string | null;
  lastApiCallAt: string | null;
  syncEnabled: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  consecutiveFailures: number;
  health: ShopHealth;
  domains: DomainFreshness[];
  pending: number;
  running: number;
  failed24h: number;
  apiCalls24h: number;
}

export interface SystemHealth {
  generatedAt: string;
  scheduler: ComponentHealth;
  worker: ComponentHealth;
  rateLimit: { lastAt: string | null; coolingDown: boolean };
  queue: { pending: number; running: number; retrying: number; staleRunning: number; failed24h: number; succeeded24h: number; oldestDueMinutes: number | null };
  autoSyncEnabled: boolean;
  disabledSyncTypes: string[];
  shops: ShopHealthRow[];
  api: Array<{ endpoint: string; calls: number; avgMs: number | null; p95Ms: number | null; maxMs: number | null }>;
  tables: Array<{ table: string; approxRows: number; totalBytes: number }>;
  alerts: HealthAlert[];
}

export function deriveAlerts(h: Omit<SystemHealth, "alerts" | "generatedAt" | "api" | "tables">, config: Pick<SyncConfig, "oldestPendingWarnMinutes">): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  if (!h.autoSyncEnabled) alerts.push({ level: "warning", code: "auto_sync_disabled", message: "Đồng bộ tự động đang TẮT (SHOPEE_AUTO_SYNC_ENABLED=false) — chỉ chạy job đã có / bấm tay." });
  if (h.scheduler.status === "unhealthy") alerts.push({ level: "danger", code: "scheduler_stale", message: `${h.scheduler.message} Kiểm tra pg_cron / Vault secret (runbook §1).` });
  if (h.worker.status === "unhealthy") alerts.push({ level: "danger", code: "worker_stale", message: `${h.worker.message} Kiểm tra log route sync-scheduler (runbook §2).` });
  if (h.queue.staleRunning > 0) alerts.push({ level: "warning", code: "stale_running", message: `${h.queue.staleRunning} job đang "chạy" nhưng không còn cập nhật — sẽ tự thu hồi ở tick kế tiếp.` });
  if (h.queue.oldestDueMinutes !== null && h.queue.oldestDueMinutes > config.oldestPendingWarnMinutes) alerts.push({ level: "warning", code: "old_pending", message: `Có job đã chờ ${h.queue.oldestDueMinutes} phút chưa được chạy (ngưỡng ${config.oldestPendingWarnMinutes} phút).` });
  if (h.rateLimit.coolingDown) alerts.push({ level: "warning", code: "rate_limited", message: "Shopee vừa giới hạn API — worker tạm giảm còn 1 luồng, sẽ tự thử lại." });
  if (h.queue.failed24h > 0) alerts.push({ level: "warning", code: "failed_jobs", message: `${h.queue.failed24h} job thất bại trong 24 giờ — xem bảng job / bấm "Thử lại".` });
  for (const s of h.shops) {
    if (s.health === "needs_reauth") alerts.push({ level: "danger", code: "needs_reauth", shopId: s.id, message: `${s.name}: cần kết nối lại Shopee (Cài đặt → Shopee).` });
    else if (s.pauseReason === "circuit_breaker" && s.pausedUntil) alerts.push({ level: "warning", code: "circuit_open", shopId: s.id, message: `${s.name}: lỗi Shopee ${s.consecutiveFailures} lần liên tiếp — tạm dừng tới ${new Date(s.pausedUntil).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" })}.` });
    else if (!s.syncEnabled) alerts.push({ level: "info", code: "shop_disabled", shopId: s.id, message: `${s.name}: đồng bộ tự động đang tắt.` });
    for (const d of s.domains) {
      if (d.status === "stale" && s.health !== "needs_reauth" && s.health !== "paused") {
        alerts.push({ level: d.type === "order" ? "danger" : "warning", code: `stale_${d.type}`, shopId: s.id, message: `${s.name}: ${d.label} chưa đồng bộ trong ${ageText(d.ageMinutes ?? 0)} (mục tiêu ≤ ${d.sloMinutes}).` });
      }
    }
  }
  return alerts;
}

// ------------------------------------------------------------- loader

type ShopRow = { id: string; shop_name: string; data_source: string; is_active: boolean; shop_connections: Array<{ connection_status: string; access_token_expires_at: string | null; last_successful_api_call_at: string | null }> | { connection_status: string; access_token_expires_at: string | null; last_successful_api_call_at: string | null } | null };

export async function getSystemHealth(db: SupabaseClient, config: SyncConfig & { schedulerWarnAfterMinutes: number }, options: { now?: Date; providerMode?: string } = {}): Promise<SystemHealth> {
  const now = options.now ?? new Date();
  const [beats, queueRes, shopsRes, controlsRes, statesRes, apiRes, tableRes] = await Promise.all([
    getHeartbeats(db, [SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT, RATE_LIMIT_HEARTBEAT]),
    db.rpc("get_sync_queue_health", { p_stale_seconds: config.staleJobMinutes * 60 }),
    db.from("shops").select("id, shop_name, data_source, is_active, shop_connections(connection_status, access_token_expires_at, last_successful_api_call_at)").eq("channel", "shopee").order("shop_name"),
    db.from("channel_shop_sync_controls").select("shop_id, sync_enabled, paused_until, pause_reason, consecutive_failures"),
    db.from("channel_sync_states").select("shop_id, sync_type, last_success_at, metadata"),
    db.rpc("get_sync_api_stats", { p_hours: 24 }),
    db.rpc("get_channel_table_stats"),
  ]);
  for (const r of [queueRes, shopsRes, controlsRes, statesRes, apiRes, tableRes]) if (r.error) throw new Error(`Không đọc được tình trạng hệ thống: ${r.error.message}`);

  const queueRows = (queueRes.data ?? []) as Array<{ shop_id: string; sync_type: string; pending: number; running: number; retrying: number; oldest_due_seconds: number | null; stale_running: number; failed_24h: number; succeeded_24h: number; last_error_code: string | null }>;
  const controls = new Map(((controlsRes.data ?? []) as Array<{ shop_id: string; sync_enabled: boolean; paused_until: string | null; pause_reason: string | null; consecutive_failures: number }>).map((c) => [c.shop_id, c]));
  const states = (statesRes.data ?? []) as Array<{ shop_id: string; sync_type: string; last_success_at: string | null; metadata: Record<string, unknown> | null }>;
  const apiRows = (apiRes.data ?? []) as Array<{ shop_id: string; endpoint: string; calls: number; timed_calls: number; avg_ms: number | null; p95_ms: number | null; max_ms: number | null }>;

  const lastSynced = (shopId: string, type: string): string | null => {
    const s = states.find((x) => x.shop_id === shopId && x.sync_type === type);
    if (!s) return null;
    const finished = typeof s.metadata?.lastJobFinishedAt === "string" && (s.metadata.lastJobStatus === "success" || s.metadata.lastJobStatus === "partial") ? s.metadata.lastJobFinishedAt : null;
    const a = s.last_success_at ? new Date(s.last_success_at).getTime() : 0;
    const b = finished ? new Date(finished).getTime() : 0;
    return a || b ? new Date(Math.max(a, b)).toISOString() : null;
  };

  const shops: ShopHealthRow[] = ((shopsRes.data ?? []) as ShopRow[])
    .filter((s) => s.is_active && (!options.providerMode || s.data_source === options.providerMode) && (!config.shopAllowlist || config.shopAllowlist.includes(s.id)))
    .map((s) => {
      const conn = Array.isArray(s.shop_connections) ? s.shop_connections[0] : s.shop_connections;
      const ctl = controls.get(s.id);
      const domains: DomainFreshness[] = HEALTH_DOMAINS.map((d) => {
        const q = queueRows.find((r) => r.shop_id === s.id && r.sync_type === d.type);
        return {
          ...deriveFreshness({ type: d.type, label: d.label, lastSyncedAt: lastSynced(s.id, d.type), sloMinutes: config.sloMinutes[d.type] ?? 60, disabled: config.disabledSyncTypes.includes(d.type), now }),
          pending: q?.pending ?? 0,
          running: q?.running ?? 0,
          retrying: q?.retrying ?? 0,
          failed24h: q?.failed_24h ?? 0,
          lastErrorCode: q?.last_error_code ?? null,
        };
      });
      const syncEnabled = ctl?.sync_enabled ?? true;
      const row: ShopHealthRow = {
        id: s.id,
        name: s.shop_name,
        connectionStatus: s.data_source === "fixture" ? "connected" : (conn?.connection_status ?? null),
        tokenExpiresAt: conn?.access_token_expires_at ?? null,
        lastApiCallAt: conn?.last_successful_api_call_at ?? null,
        syncEnabled,
        pausedUntil: ctl?.paused_until ?? null,
        pauseReason: ctl?.pause_reason ?? null,
        consecutiveFailures: ctl?.consecutive_failures ?? 0,
        health: "healthy",
        domains,
        pending: domains.reduce((a, d) => a + d.pending + d.retrying, 0),
        running: domains.reduce((a, d) => a + d.running, 0),
        failed24h: domains.reduce((a, d) => a + d.failed24h, 0),
        apiCalls24h: apiRows.filter((r) => r.shop_id === s.id && r.endpoint !== "db_checkpoint").reduce((a, r) => a + Number(r.calls), 0),
      };
      row.health = deriveShopHealth({ connectionStatus: row.connectionStatus, syncEnabled, pausedUntil: row.pausedUntil, pauseReason: row.pauseReason, domains, now });
      return row;
    });

  const oldestDue = queueRows.reduce<number | null>((acc, r) => (r.oldest_due_seconds !== null && (acc === null || r.oldest_due_seconds > acc) ? r.oldest_due_seconds : acc), null);
  const rate = beats.get(RATE_LIMIT_HEARTBEAT);
  const byEndpoint = new Map<string, { calls: number; n: number; total: number; p95: number | null; max: number | null }>();
  for (const r of apiRows) {
    const e = byEndpoint.get(r.endpoint) ?? { calls: 0, n: 0, total: 0, p95: null, max: null };
    e.calls += Number(r.calls);
    e.n += Number(r.timed_calls);
    e.total += (r.avg_ms ?? 0) * Number(r.timed_calls);
    e.p95 = r.p95_ms === null ? e.p95 : Math.max(e.p95 ?? 0, r.p95_ms);
    e.max = r.max_ms === null ? e.max : Math.max(e.max ?? 0, r.max_ms);
    byEndpoint.set(r.endpoint, e);
  }

  const partial = {
    scheduler: deriveComponentHealth("Scheduler", beats.get(SCHEDULER_HEARTBEAT), config.schedulerWarnAfterMinutes, now),
    worker: deriveComponentHealth("Worker", beats.get(WORKER_HEARTBEAT), config.workerWarnAfterMinutes, now),
    rateLimit: { lastAt: rate?.last_error_at ?? null, coolingDown: !!rate?.last_error_at && now.getTime() - new Date(rate.last_error_at).getTime() < config.rateLimitCooldownMinutes * 60_000 },
    queue: {
      pending: queueRows.reduce((a, r) => a + r.pending, 0),
      running: queueRows.reduce((a, r) => a + r.running, 0),
      retrying: queueRows.reduce((a, r) => a + r.retrying, 0),
      staleRunning: queueRows.reduce((a, r) => a + r.stale_running, 0),
      failed24h: queueRows.reduce((a, r) => a + r.failed_24h, 0),
      succeeded24h: queueRows.reduce((a, r) => a + r.succeeded_24h, 0),
      oldestDueMinutes: oldestDue === null ? null : Math.floor(oldestDue / 60),
    },
    autoSyncEnabled: config.autoSyncEnabled,
    disabledSyncTypes: config.disabledSyncTypes,
    shops,
  };
  return {
    generatedAt: now.toISOString(),
    ...partial,
    api: [...byEndpoint.entries()].map(([endpoint, e]) => ({ endpoint, calls: e.calls, avgMs: e.n > 0 ? Math.round(e.total / e.n) : null, p95Ms: e.p95, maxMs: e.max })).sort((a, b) => b.calls - a.calls),
    tables: ((tableRes.data ?? []) as Array<{ table_name: string; approx_rows: number; total_bytes: number }>).map((t) => ({ table: t.table_name, approxRows: Number(t.approx_rows), totalBytes: Number(t.total_bytes) })),
    alerts: deriveAlerts(partial, config),
  };
}

/** SHOPEE-9A: per-shop sync switch (admin). Resume also clears a circuit-breaker cooldown. */
export async function setShopSyncEnabled(db: SupabaseClient, shopId: string, enabled: boolean, by: string | null): Promise<void> {
  const { error } = await db.from("channel_shop_sync_controls").upsert(
    { shop_id: shopId, sync_enabled: enabled, updated_by: by, ...(enabled ? { paused_until: null, pause_reason: null, consecutive_failures: 0 } : {}) },
    { onConflict: "shop_id" },
  );
  if (error) throw new Error(`Không lưu được trạng thái đồng bộ shop: ${error.message}`);
}
