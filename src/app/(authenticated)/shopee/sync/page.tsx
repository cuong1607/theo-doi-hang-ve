import { AlertTriangle, FlaskConical } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { listShops } from "@/lib/channels/core/queries";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { getQueueCounts, getSyncStatuses, listRecentSyncJobs } from "@/lib/channels/core/sync-status-queries";
import { getShopeeConfig } from "@/lib/channels/shopee/config";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { fmtDate } from "../shared";
import { BackfillButton, JobActionButtons, SyncNowButton } from "./sync-buttons";
import { JobStatusBadge, SYNC_MODE_LABELS, SYNC_TYPE_LABELS, SyncFreshness } from "./sync-status";

export const dynamic = "force-dynamic";
// Server actions on this page kick the worker after responding (after()).
export const maxDuration = 60;

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

const fmtDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} phút`);

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
  const [statuses, jobs, queue] = await Promise.all([getSyncStatuses(shops.map((s) => s.id)), listRecentSyncJobs({}, 30), getQueueCounts()]);
  const shopName = new Map(shops.map((s) => [s.id, s.shopName]));
  const config = getSyncConfig();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Đồng bộ Shopee</h2>
        <p className="text-muted-foreground">
          Đồng bộ chạy nền theo hàng đợi: trang chỉ đọc dữ liệu đã lưu, nút &quot;Đồng bộ ngay&quot; chỉ thêm yêu cầu vào hàng đợi.
        </p>
      </div>

      {modeConfig.mode === "fixture" ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          Đang sử dụng dữ liệu fixture/test. Shopee production API chưa được kích hoạt.
        </p>
      ) : liveProblem || modeConfig.problem ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Chưa kết nối API Shopee. {modeConfig.problem ?? liveProblem}
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Đang chờ" value={queue.pending} />
        <Stat label="Đang chạy" value={queue.running} />
        <Stat label="Chờ thử lại" value={queue.retry} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Shop ({shops.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {shops.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có shop Shopee nào. Kết nối shop ở trang Tích hợp Shopee.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shop</TableHead>
                  <TableHead>Đơn hàng</TableHead>
                  <TableHead>Sản phẩm</TableHead>
                  <TableHead>Tài chính (escrow)</TableHead>
                  {(canSync || canManage) && <TableHead className="text-right">Thao tác</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shops.map((shop) => {
                  const usable = shop.isActive && shop.dataSource === modeConfig.mode && !liveProblem && !modeConfig.problem;
                  return (
                    <TableRow key={shop.id} className="align-top">
                      <TableCell className="whitespace-nowrap">
                        <p className="font-medium">{shop.shopName}</p>
                        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <Badge variant={shop.dataSource === "fixture" ? "secondary" : "outline"}>{shop.dataSource === "fixture" ? "FIXTURE" : "LIVE"}</Badge>#{shop.externalShopId}
                        </p>
                        {!shop.isActive && <p className="text-xs text-destructive">Đang tạm ngưng</p>}
                      </TableCell>
                      <TableCell>
                        <SyncFreshness status={statuses.get(`${shop.id}|order`)} canSeeErrors={canManage} />
                      </TableCell>
                      <TableCell>
                        <SyncFreshness status={statuses.get(`${shop.id}|product`)} canSeeErrors={canManage} />
                      </TableCell>
                      <TableCell>
                        <SyncFreshness status={statuses.get(`${shop.id}|escrow`)} canSeeErrors={canManage} />
                      </TableCell>
                      {(canSync || canManage) && (
                        <TableCell>
                          <div className="flex flex-col items-end gap-2">
                            {canSync && <SyncNowButton shopId={shop.id} syncType="order" label="Đồng bộ đơn ngay" disabled={!usable} />}
                            {canSync && <SyncNowButton shopId={shop.id} syncType="product" label="Đồng bộ sản phẩm ngay" disabled={!usable} />}
                            {canSync && <SyncNowButton shopId={shop.id} syncType="escrow" label="Đồng bộ tài chính" disabled={!usable} />}
                            {canManage && <BackfillButton shopId={shop.id} syncType="order" days={30} label="Backfill đơn 30 ngày" disabled={!usable} />}
                            {canManage && <BackfillButton shopId={shop.id} syncType="product" label="Quét toàn bộ sản phẩm" disabled={!usable} />}
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
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có job đồng bộ nào.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tạo lúc</TableHead>
                  <TableHead>Shop</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-right">Bản ghi</TableHead>
                  <TableHead className="text-right">API</TableHead>
                  <TableHead className="text-right">Bỏ qua (không đổi)</TableHead>
                  <TableHead className="text-right">Thời gian chạy</TableHead>
                  <TableHead>Lỗi</TableHead>
                  {canManage && <TableHead className="text-right">Thao tác</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id} className="align-top">
                    <TableCell className="whitespace-nowrap text-xs">{fmtDate(job.createdAt)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{shopName.get(job.shopId) ?? job.shopId.slice(0, 8)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {SYNC_TYPE_LABELS[job.syncType] ?? job.syncType} · {SYNC_MODE_LABELS[job.mode] ?? job.mode}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      <JobStatusBadge job={job} />
                      <p className="mt-1 text-muted-foreground">
                        lượt {job.attemptCount}/{job.maxAttempts}
                        {job.status === "retry" && job.nextAttemptAt ? ` · lúc ${fmtDate(job.nextAttemptAt)}` : ""}
                      </p>
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      quét {job.recordsFetched} · mới {job.recordsCreated} · cập nhật {job.recordsUpdated}
                      {job.recordsFailed ? <span className="text-destructive"> · lỗi {job.recordsFailed}</span> : null}
                    </TableCell>
                    <TableCell className="text-right text-xs" title={Object.entries(job.apiCallsByName).map(([k, v]) => `${k}: ${v}`).join("\n")}>
                      {job.apiCalls}
                      {job.rateLimitHits ? <span className="text-destructive"> ({job.rateLimitHits} rate-limit)</span> : null}
                    </TableCell>
                    <TableCell className="text-right text-xs">{job.detailsSkippedUnchanged}</TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {fmtDuration(job.durationMs)}
                      {job.slices > 1 ? ` · ${job.slices} lượt chạy` : ""}
                    </TableCell>
                    <TableCell className="max-w-[260px] text-xs text-destructive">
                      {job.errorCode ? (
                        <>
                          {job.errorCode}
                          {canManage && job.errorMessage ? <span className="block break-words text-muted-foreground">{job.errorMessage}</span> : null}
                        </>
                      ) : null}
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

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Cấu hình đồng bộ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Job chạy đồng thời: <b>{config.globalWorkers}</b> · chi tiết đơn song song: <b>{config.orderDetailConcurrency}</b> · chi tiết sản phẩm song song:{" "}
              <b>{config.productDetailConcurrency}</b> · tối đa <b>{config.maxSliceApiCalls}</b> lệnh API / lượt chạy · đơn mỗi <b>{config.orderIntervalMinutes}</b> phút · sản phẩm
              mỗi <b>{config.productIntervalMinutes}</b> phút · TTL đơn đang xử lý <b>{config.activeOrderTtlMinutes}</b> phút.
            </p>
            {config.warnings.map((w) => (
              <p key={w} className="text-destructive">
                {w}
              </p>
            ))}
            <p className="text-muted-foreground">
              Lịch chạy định kỳ cần một bộ hẹn giờ gọi <code>/api/internal/shopee/sync-scheduler</code> (xem docs/shopee-sync-operations.md). Nếu chưa cấu hình, đồng bộ chỉ chạy khi bấm &quot;Đồng bộ ngay&quot;.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
