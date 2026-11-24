// ZALO PERSONAL Phase 03 — worker health badge + explanation (server-safe, no client JS).
import { Callout } from "@/components/patterns/callout";
import { StatusBadge } from "@/components/patterns/status-badge";
import { formatDuration } from "@/lib/ui/format";
import { HEALTH_LABEL, HEALTH_TONE, SITUATION_TEXT, type WorkerHealth } from "@/lib/zalo-personal/dashboard/status";

export function HealthBadge({ health }: { health: WorkerHealth }) {
  return (
    <StatusBadge tone={HEALTH_TONE[health.health]} title={SITUATION_TEXT[health.situation].title}>
      {HEALTH_LABEL[health.health]}
    </StatusBadge>
  );
}

export function HeartbeatAge({ health }: { health: WorkerHealth }) {
  if (health.heartbeatAgeMs === null) return <span className="text-muted-foreground">chưa có heartbeat</span>;
  return <span className="tabular-nums">{formatDuration(health.heartbeatAgeMs)} trước</span>;
}

export function SituationCallout({ health }: { health: WorkerHealth }) {
  const text = SITUATION_TEXT[health.situation];
  const tone = health.health === "connected" ? "success" : health.health === "degraded" || health.health === "unknown" ? "warning" : health.health === "disabled" ? "info" : "danger";
  return (
    <Callout tone={tone} title={text.title}>
      {text.action || null}
    </Callout>
  );
}

/** Session / listener raw states → Vietnamese (worker-reported enums only). */
export const SESSION_LABEL: Record<string, string> = { unknown: "Chưa rõ", authenticated: "Đã đăng nhập", unauthenticated: "Chưa đăng nhập", rejected: "Bị từ chối / hết hạn" };
export const LISTENER_LABEL: Record<string, string> = { unknown: "Chưa rõ", active: "Đang nhận tin", connecting: "Đang kết nối", reconnecting: "Đang kết nối lại", inactive: "Đã dừng", error: "Lỗi" };
