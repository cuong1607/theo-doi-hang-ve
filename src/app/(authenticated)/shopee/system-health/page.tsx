import { Activity, AlertTriangle, Clock, Database, ListTodo, Server, Timer } from "lucide-react";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/session";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { getSystemHealth, SHOP_HEALTH_INFO, type ComponentStatus, type DomainFreshness } from "@/lib/channels/core/system-health";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";
import { AutoRefresh } from "@/components/patterns/auto-refresh";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { GlobalRepairButtons, ShopRepairButtons } from "./health-controls";

export const dynamic = "force-dynamic";

const COMPONENT_TONE: Record<ComponentStatus, "success" | "warning" | "danger"> = { healthy: "success", degraded: "warning", unhealthy: "danger" };
const COMPONENT_LABEL: Record<ComponentStatus, string> = { healthy: "Ổn định", degraded: "Có lỗi", unhealthy: "Không chạy" };
const CONNECTION_LABEL: Record<string, string> = { connected: "Đã kết nối", error: "Lỗi gần đây", expired: "Hết hạn", revoked: "Bị thu hồi", disconnected: "Chưa kết nối" };

function ago(min: number | null): string {
  if (min === null) return "chưa có";
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} giờ ${min % 60} phút`;
  return `${Math.floor(min / 1440)} ngày`;
}

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function DomainCell({ d }: { d: DomainFreshness }) {
  const tone = d.status === "ok" ? "text-success-text" : d.status === "stale" ? "text-danger-text" : "text-muted-foreground";
  return (
    <TableCell className="text-xs whitespace-nowrap" title={`${d.label}: lần cuối ${d.lastSyncedAt ? formatDateTime(d.lastSyncedAt) : "chưa có"} · mục tiêu ≤ ${d.sloMinutes} phút`}>
      <span className={`font-medium tabular-nums ${tone}`}>{d.status === "disabled" ? "tắt" : d.status === "never" ? "chưa có" : ago(d.ageMinutes)}</span>
      {(d.pending > 0 || d.running > 0 || d.retrying > 0) && (
        <span className="block text-[11px] text-muted-foreground">
          {d.running > 0 ? "đang chạy" : d.retrying > 0 ? `thử lại${d.lastErrorCode ? ` (${d.lastErrorCode})` : ""}` : "đang chờ"}
        </span>
      )}
      {d.failed24h > 0 && <span className="block text-[11px] text-danger-text">{d.failed24h} lỗi/24h</span>}
    </TableCell>
  );
}

export default async function SystemHealthPage() {
  await requirePermission("channel:manage");
  const config = getSyncConfig();
  const { mode } = getShopeeProviderMode();
  const h = await getSystemHealth(createAdminClient(), config, { providerMode: mode });
  const domains = h.shops[0]?.domains ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Sức khoẻ hệ thống Shopee"
        description="Trạng thái vận hành thật của scheduler, worker, hàng đợi và từng shop. Mọi thao tác ở đây đều đi qua hàng đợi như lịch tự động."
        actions={<GlobalRepairButtons />}
        meta={
          <>
            <span>Cập nhật lúc {formatDateTime(h.generatedAt)}</span>
            <AutoRefresh active intervalMs={30_000} />
            <Link href="/shopee/sync" className="text-primary underline-offset-4 hover:underline">
              Bảng job đồng bộ →
            </Link>
          </>
        }
      />

      {h.alerts.length > 0 ? (
        <div className="space-y-2">
          {h.alerts.map((a, i) => (
            <Callout key={`${a.code}-${a.shopId ?? ""}-${i}`} tone={a.level === "danger" ? "danger" : a.level === "warning" ? "warning" : "info"}>
              {a.message}
            </Callout>
          ))}
        </div>
      ) : (
        <Callout tone="success">Không có cảnh báo — scheduler, worker, hàng đợi và các shop đều trong ngưỡng.</Callout>
      )}

      <MetricGrid>
        <MetricCard label="Scheduler" icon={Timer} tone={COMPONENT_TONE[h.scheduler.status]} value={COMPONENT_LABEL[h.scheduler.status]} hint={`lần cuối ${ago(h.scheduler.ageMinutes)}${h.scheduler.ageMinutes !== null && h.scheduler.ageMinutes >= 1 ? " trước" : ""}`} />
        <MetricCard label="Worker" icon={Server} tone={COMPONENT_TONE[h.worker.status]} value={COMPONENT_LABEL[h.worker.status]} hint={`lần cuối ${ago(h.worker.ageMinutes)}${h.worker.ageMinutes !== null && h.worker.ageMinutes >= 1 ? " trước" : ""}`} />
        <MetricCard label="Hàng đợi" icon={ListTodo} value={`${h.queue.pending + h.queue.retrying} chờ · ${h.queue.running} chạy`} hint={h.queue.retrying > 0 ? `${h.queue.retrying} đang chờ thử lại` : "đang xử lý bình thường"} />
        <MetricCard label="Job chờ lâu nhất" icon={Clock} tone={h.queue.oldestDueMinutes !== null && h.queue.oldestDueMinutes > config.oldestPendingWarnMinutes ? "warning" : "neutral"} value={h.queue.oldestDueMinutes === null ? "—" : ago(h.queue.oldestDueMinutes)} hint={`ngưỡng cảnh báo ${config.oldestPendingWarnMinutes} phút`} />
        <MetricCard label="Job 24 giờ" icon={Activity} tone={h.queue.failed24h > 0 ? "warning" : "neutral"} value={`${h.queue.succeeded24h} xong`} hint={`${h.queue.failed24h} thất bại · ${h.queue.staleRunning} treo`} />
        <MetricCard label="Giới hạn API" icon={AlertTriangle} tone={h.rateLimit.coolingDown ? "warning" : "neutral"} value={h.rateLimit.coolingDown ? "Đang giảm tải" : "Bình thường"} hint={h.rateLimit.lastAt ? `lần cuối ${formatDateTime(h.rateLimit.lastAt)}` : "chưa bị giới hạn"} />
      </MetricGrid>

      <Card>
        <CardHeader>
          <CardTitle>Từng shop</CardTitle>
          <CardDescription>
            Thời gian từ lần đồng bộ xong gần nhất; đỏ = vượt mục tiêu (SLO, cấu hình bằng SHOPEE_SLO_&lt;LOẠI&gt;_MINUTES). Tối đa {config.maxRunningPerShop} job/shop và {config.globalWorkers} job toàn hệ thống chạy cùng lúc; shop mới chạy ưu tiên thấp hơn shop đang ổn định.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {h.shops.length === 0 ? (
            <EmptyState title="Chưa có shop Shopee nào." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shop</TableHead>
                  <TableHead>Kết nối</TableHead>
                  {domains.map((d) => (
                    <TableHead key={d.type} className="whitespace-nowrap">
                      {d.label}
                      <span className="block text-[11px] font-normal text-muted-foreground">≤ {d.sloMinutes} phút</span>
                    </TableHead>
                  ))}
                  <TableHead className="text-right">API 24h</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.shops.map((s) => {
                  const info = SHOP_HEALTH_INFO[s.health];
                  return (
                    <TableRow key={s.id} className="align-top">
                      <TableCell className="min-w-44 max-w-56 whitespace-normal">
                        <span className="font-medium break-all">{s.name}</span>
                        <span className="mt-1 block">
                          <StatusBadge tone={info.tone} icon={false}>
                            {info.label}
                          </StatusBadge>
                        </span>
                        {(s.pending > 0 || s.running > 0) && <span className="block text-[11px] text-muted-foreground">{s.pending} chờ · {s.running} chạy</span>}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {CONNECTION_LABEL[s.connectionStatus ?? "disconnected"] ?? s.connectionStatus}
                        {s.tokenExpiresAt && <span className="block text-[11px] text-muted-foreground">token tới {formatDateTime(s.tokenExpiresAt).slice(-5)}</span>}
                        {s.health === "needs_reauth" && (
                          <Link href="/settings/shopee" className="block text-[11px] text-primary underline-offset-4 hover:underline">
                            Kết nối lại →
                          </Link>
                        )}
                        {s.pausedUntil && new Date(s.pausedUntil) > new Date(h.generatedAt) && <span className="block text-[11px] text-warning-text">chờ tới {formatDateTime(s.pausedUntil).slice(-5)}</span>}
                      </TableCell>
                      {s.domains.map((d) => (
                        <DomainCell key={d.type} d={d} />
                      ))}
                      <TableCell className="text-right tabular-nums">{s.apiCalls24h.toLocaleString("vi-VN")}</TableCell>
                      <TableCell>
                        <ShopRepairButtons shopId={s.id} syncEnabled={s.syncEnabled} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>API Shopee 24 giờ</CardTitle>
            <CardDescription>Số lần gọi và độ trễ theo endpoint (db_checkpoint = một lượt ghi Supabase).</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {h.api.length === 0 ? (
              <EmptyState title="Chưa có lần gọi nào trong 24 giờ." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Endpoint</TableHead>
                    <TableHead className="text-right">Lần gọi</TableHead>
                    <TableHead className="text-right">TB (ms)</TableHead>
                    <TableHead className="text-right">p95 (ms)</TableHead>
                    <TableHead className="text-right">Max (ms)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.api.map((a) => (
                    <TableRow key={a.endpoint}>
                      <TableCell className="font-mono text-xs">{a.endpoint}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.endpoint === "db_checkpoint" ? "—" : a.calls.toLocaleString("vi-VN")}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.avgMs ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.p95Ms ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.maxMs ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database aria-hidden="true" className="size-4" /> Dung lượng dữ liệu
            </CardTitle>
            <CardDescription>
              Ước tính. Tự dọn: snapshot thô cũ hơn {config.snapshotRetentionDays} ngày (tài chính / trả hàng {config.financialSnapshotRetentionDays} ngày, luôn giữ bản mới nhất), log thành công {config.logSuccessRetentionDays} ngày, log lỗi {config.logFailureRetentionDays} ngày. Không bao giờ xoá dữ liệu đơn / tài chính / trả hàng / payout / giá vốn.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bảng</TableHead>
                  <TableHead className="text-right">Dòng (≈)</TableHead>
                  <TableHead className="text-right">Dung lượng</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.tables.map((t) => (
                  <TableRow key={t.table}>
                    <TableCell className="font-mono text-xs">{t.table}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.approxRows.toLocaleString("vi-VN")}</TableCell>
                    <TableCell className="text-right tabular-nums">{bytes(t.totalBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
