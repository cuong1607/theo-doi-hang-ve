import { Activity, AlertTriangle, CalendarClock, Clock, FlaskConical, ListTodo, RefreshCw } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { listShops } from "@/lib/channels/core/queries";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import type { RunnableSyncType } from "@/lib/channels/core/sync-jobs";
import type { PendingDiagnosis } from "@/lib/channels/core/sync-diagnostics";
import { diagnoseJobView, getPendingDiagnosticsContext, getQueueCounts, getSyncHealth, getSyncStatuses, listRecentSyncJobs } from "@/lib/channels/core/sync-status-queries";
import { getOrdersSyncFrom } from "@/lib/channels/core/sync-settings";
import { devToolsEnabled } from "@/lib/dev-tools";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopeeConfig } from "@/lib/channels/shopee/config";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { formatDateTime, formatDuration } from "@/lib/ui/format";
import { AutoRefresh } from "@/components/patterns/auto-refresh";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { DevToolsPanel } from "./dev-tools-panel";
import { BackfillButton, JobActionButtons, SyncNowButton } from "./sync-buttons";
import { hasActiveSync, JobStatusBadge, SchedulerWarning, SYNC_MODE_LABELS, SYNC_TYPE_LABELS, SyncStatusCell } from "./sync-status";

export const dynamic = "force-dynamic";
// Server actions on this page kick the worker after responding (after()).
export const maxDuration = 60;

/** Matrix columns, in queue priority order (orders first). */
const MATRIX: Array<{ type: RunnableSyncType; label: string; button: string }> = [
  { type: "order", label: "Đơn hàng", button: "Đồng bộ đơn" },
  { type: "return", label: "Trả hàng", button: "Đồng bộ trả hàng" },
  { type: "return_logistics", label: "Vận chuyển Hoàn Trả", button: "Đồng bộ vận chuyển Hoàn Trả" },
  { type: "failed_delivery", label: "Vận chuyển Hoàn Hủy", button: "Đồng bộ vận chuyển Hoàn Hủy" },
  { type: "escrow", label: "Tài chính", button: "Đồng bộ tài chính" },
  { type: "income", label: "Giải ngân", button: "Đồng bộ giải ngân" },
  { type: "payout", label: "Payout", button: "Đồng bộ payout" },
  { type: "product", label: "Sản phẩm", button: "Đồng bộ sản phẩm" },
];

export default async function ShopeeSyncPage() {
  const auth = await requirePermission("channel:view");
  const role = auth.profile.role;
  const canSync = hasPermission(role, "channel:sync");
  const canManage = hasPermission(role, "channel:manage");

  const modeConfig = getShopeeProviderMode();
  let liveProblem: string | null = null;
  if (modeConfig.mode === "live") {
    try {
      getShopeeConfig();
    } catch (err) {
      liveProblem = (err as Error).message;
    }
  }

  const shops = (await listShops()).filter((s) => s.channel === "shopee");
  const [statuses, jobs, queue, health, diagCtx, ordersFrom] = await Promise.all([
    getSyncStatuses(shops.map((s) => s.id)),
    listRecentSyncJobs({}, 30),
    getQueueCounts(),
    getSyncHealth(),
    getPendingDiagnosticsContext(),
    getOrdersSyncFrom(createAdminClient()),
  ]);
  const showDevTools = canManage && devToolsEnabled();
  const shopName = new Map(shops.map((s) => [s.id, s.shopName]));
  const config = getSyncConfig();
  const now = new Date();
  const syncing = hasActiveSync(statuses) || queue.running > 0;

  return (
    <PageContainer>
      <PageHeader
        title="Đồng bộ Shopee"
        description='Đơn hàng, tài chính và sản phẩm tự đồng bộ định kỳ (lịch chạy mỗi phút). Trang chỉ đọc dữ liệu đã lưu; "Đồng bộ ngay" chỉ đưa yêu cầu lên đầu hàng đợi — không cần bấm để dữ liệu tiếp tục cập nhật.'
        meta={<AutoRefresh active={syncing} />}
      />

      {canManage && <SchedulerWarning health={health} />}
      {modeConfig.mode === "fixture" ? (
        <Callout tone="info" icon={FlaskConical}>
          Đang sử dụng dữ liệu fixture/test. Shopee production API chưa được kích hoạt.
        </Callout>
      ) : liveProblem || modeConfig.problem ? (
        <Callout tone="danger" title="Chưa kết nối API Shopee.">
          {modeConfig.problem ?? liveProblem}
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Đang chờ" icon={ListTodo} value={queue.pending} hint="job trong hàng đợi" />
        <MetricCard label="Đang chạy" icon={Activity} value={queue.running} tone={queue.running > 0 ? "info" : "neutral"} hint={`tối đa ${config.globalWorkers} job cùng lúc`} />
        <MetricCard label="Chờ thử lại" icon={RefreshCw} value={queue.retry} tone={queue.retry > 0 ? "warning" : "neutral"} hint="tự chạy lại theo backoff" />
        <MetricCard
          label="Scheduler"
          icon={CalendarClock}
          value={
            <StatusBadge tone={health.schedulerStale ? "warning" : "success"} className="h-6 text-sm">
              {health.schedulerStale ? "Có thể đang dừng" : "Đang hoạt động"}
            </StatusBadge>
          }
          hint={
            <>
              Chạy gần nhất: {health.scheduler?.last_run_at ? formatDateTime(health.scheduler.last_run_at) : "chưa từng chạy"}
              <br />
              Worker: {health.worker?.last_success_at ? formatDateTime(health.worker.last_success_at) : "chưa chạy"}
              {canManage && health.scheduler?.last_error && health.scheduler.last_error_at && (!health.scheduler.last_success_at || health.scheduler.last_error_at > health.scheduler.last_success_at) ? (
                <span className="block text-danger-text">Lỗi: {health.scheduler.last_error}</span>
              ) : null}
            </>
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Trạng thái theo shop</CardTitle>
          <CardDescription>Mỗi ô: trạng thái hiện tại, tiến độ, thời gian chạy, lần thành công gần nhất và lỗi gần nhất.</CardDescription>
        </CardHeader>
        <CardContent>
          {shops.length === 0 ? (
            <EmptyState title="Chưa có shop Shopee nào." description="Kết nối shop ở trang Tích hợp Shopee để bắt đầu đồng bộ." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shop</TableHead>
                  {MATRIX.map((m) => (
                    <TableHead key={m.type}>{m.label}</TableHead>
                  ))}
                  {canManage && <TableHead className="text-right">Khác</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shops.map((shop) => {
                  const usable = shop.isActive && shop.dataSource === modeConfig.mode && !liveProblem && !modeConfig.problem;
                  return (
                    <TableRow key={shop.id} className="align-top hover:bg-transparent">
                      <TableCell className="whitespace-nowrap">
                        <p className="font-medium">{shop.shopName}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <StatusBadge tone={shop.dataSource === "fixture" ? "info" : "neutral"} icon={false}>
                            {shop.dataSource === "fixture" ? "FIXTURE" : "LIVE"}
                          </StatusBadge>
                          #{shop.externalShopId}
                        </p>
                        {!shop.isActive && <p className="mt-1 text-xs text-warning-text">Đang tạm ngưng</p>}
                      </TableCell>
                      {MATRIX.map((m) => (
                        <TableCell key={m.type} className="whitespace-normal">
                          <SyncStatusCell
                            status={statuses.get(`${shop.id}|${m.type}`)}
                            canSeeErrors={canManage}
                            now={now}
                            action={canSync ? <SyncNowButton shopId={shop.id} syncType={m.type} label="Đồng bộ ngay" variant="outline" disabled={!usable} /> : undefined}
                          />
                        </TableCell>
                      ))}
                      {canManage && (
                        <TableCell>
                          <div className="flex flex-col items-end gap-2">
                            <BackfillButton shopId={shop.id} syncType="order" days={30} label="Backfill đơn 30 ngày" disabled={!usable} />
                            <BackfillButton shopId={shop.id} syncType="product" label="Quét toàn bộ sản phẩm" disabled={!usable} />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job gần đây</CardTitle>
          <CardDescription>30 job mới nhất trên mọi shop. Di chuột lên số lệnh API để xem từng loại.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <EmptyState icon={Clock} title="Chưa có job đồng bộ nào." description="Lịch tự động sẽ tạo job đầu tiên trong vài phút, hoặc bấm “Đồng bộ ngay”." />
          ) : (
            <Table stickyHeader>
              <TableHeader>
                <TableRow>
                  <TableHead>Tạo lúc</TableHead>
                  <TableHead>Shop</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-right">Bản ghi</TableHead>
                  <TableHead className="text-right">Lệnh API</TableHead>
                  <TableHead className="text-right">Bỏ qua (không đổi)</TableHead>
                  <TableHead className="text-right">Thời gian chạy</TableHead>
                  <TableHead>Lỗi</TableHead>
                  {canManage && <TableHead className="text-right">Thao tác</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id} className="align-top">
                    <TableCell className="text-xs">{formatDateTime(job.createdAt)}</TableCell>
                    <TableCell className="max-w-40 truncate text-xs" title={shopName.get(job.shopId)}>
                      {shopName.get(job.shopId) ?? job.shopId.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {SYNC_TYPE_LABELS[job.syncType] ?? job.syncType} · {SYNC_MODE_LABELS[job.mode] ?? job.mode}
                    </TableCell>
                    <TableCell className="text-xs">
                      <JobStatusBadge job={job} />
                      <p className="mt-1 text-muted-foreground">
                        lần thử {job.attemptCount}/{job.maxAttempts}
                        {job.status === "retry" && job.nextAttemptAt ? ` · lúc ${formatDateTime(job.nextAttemptAt)}` : ""}
                        {job.continuationReason && job.status === "pending" ? ` · chạy tiếp (${job.continuationReason === "time_budget" ? "hết thời gian lượt" : "hết lượt gọi API"})` : ""}
                      </p>
                      <PendingReason diagnosis={diagnoseJobView(job, diagCtx)} />
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      quét {job.recordsFetched} · mới {job.recordsCreated} · cập nhật {job.recordsUpdated}
                      {job.recordsFailed ? <span className="text-warning-text"> · lỗi {job.recordsFailed}</span> : null}
                    </TableCell>
                    <TableCell className="text-right text-xs" title={Object.entries(job.apiCallsByName).map(([k, v]) => `${k}: ${v}`).join("\n") || undefined}>
                      {job.apiCalls}
                      {job.rateLimitHits ? (
                        <span className="text-warning-text">
                          {" "}
                          <AlertTriangle aria-hidden="true" className="inline size-3" /> {job.rateLimitHits} rate-limit
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right text-xs">{job.detailsSkippedUnchanged}</TableCell>
                    <TableCell className="text-right text-xs">
                      {formatDuration(job.durationMs)}
                      {job.slices > 1 ? ` · ${job.slices} lượt` : ""}
                    </TableCell>
                    <TableCell className="max-w-[260px] text-xs whitespace-normal">
                      {job.errorCode ? (
                        <span className="text-danger-text">
                          {job.errorCode}
                          {canManage && job.errorMessage ? <span className="block break-words text-muted-foreground">{job.errorMessage}</span> : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <JobActionButtons
                          jobId={job.id}
                          canRetry={job.status === "failed" || job.status === "cancelled"}
                          canCancel={(job.status === "pending" || job.status === "retry" || job.status === "running") && !job.cancelRequested}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showDevTools && <DevToolsPanel shops={shops.map((s) => ({ id: s.id, name: s.shopName }))} />}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Cấu hình đồng bộ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Chỉ đồng bộ đơn tạo từ: <b className="text-foreground">{ordersFrom ? formatDateTime(ordersFrom.toISOString()) : "mọi thời điểm"}</b>
              {ordersFrom ? " — đơn cũ hơn vẫn hiển thị nhưng không còn được cập nhật (đơn hàng và tài chính)." : ""}
            </p>
            <p>
              Nhịp tự động: đơn mỗi <b className="text-foreground">{config.orderIntervalMinutes}</b> phút · tài chính mỗi <b className="text-foreground">{config.escrowIntervalMinutes}</b> phút
              · sản phẩm mỗi <b className="text-foreground">{config.productIntervalMinutes}</b> phút · chồng lấn cửa sổ đơn <b className="text-foreground">{config.orderOverlapMinutes}</b> phút.
            </p>
            <p>
              Job chạy đồng thời: <b className="text-foreground">{config.globalWorkers}</b> · chi tiết đơn song song: <b className="text-foreground">{config.orderDetailConcurrency}</b> · chi
              tiết sản phẩm song song: <b className="text-foreground">{config.productDetailConcurrency}</b> · escrow song song: <b className="text-foreground">{config.escrowConcurrency}</b> · tối
              đa <b className="text-foreground">{config.maxSliceApiCalls}</b> lệnh API / lượt · mỗi lần worker chạy tối đa{" "}
              <b className="text-foreground">{Math.round(config.workerTimeBudgetMs / 1000)}</b> giây.
            </p>
            {config.warnings.map((w) => (
              <Callout key={w} tone="warning">
                {w}
              </Callout>
            ))}
            <p>
              Lịch chạy: Supabase pg_cron gọi <code className="rounded bg-muted px-1">/api/internal/shopee/sync-scheduler</code> mỗi phút; mỗi lần gọi tạo job đến hạn rồi xử lý hàng
              đợi trong giới hạn thời gian (xem docs/shopee-sync-operations.md).
            </p>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}

/** §14: why a pending / retry job has not run yet ("ready" = the next worker run takes it). */
function PendingReason({ diagnosis }: { diagnosis: PendingDiagnosis | null }) {
  if (!diagnosis) return null;
  const tone = diagnosis.reason === "ready" ? "text-muted-foreground" : diagnosis.reason === "waiting_next_attempt" || diagnosis.reason === "same_lane_running" || diagnosis.reason === "global_capacity" ? "text-info-text" : "text-warning-text";
  return (
    <p className={`mt-1 ${tone}`} title={diagnosis.reason}>
      {diagnosis.label}
      {diagnosis.detail && diagnosis.reason === "waiting_next_attempt" ? ` (${formatDateTime(diagnosis.detail)})` : diagnosis.detail ? ` — ${diagnosis.detail}` : ""}
    </p>
  );
}
