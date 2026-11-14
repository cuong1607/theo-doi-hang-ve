import { AlertTriangle, Download, PackageCheck, Settings, Truck, Undo2 } from "lucide-react";
import Link from "next/link";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { listShops } from "@/lib/channels/core/queries";
import { attentionLabel, RETURN_OP_CANONICAL_STATUSES, RETURN_OP_STATUS_INFO, returnOpStatusInfo } from "@/lib/channels/shopee/return-logistics-status";
import { getTodayDateVN } from "@/lib/notifications/date-vn";
import { isReturnOperationType, RETURN_OPERATION_LABELS, type ReturnOperationType } from "@/lib/return-operations/classify";
import {
  getDailyReturnOperationsList,
  getDailyReturnOperationsSummary,
  getReturnOperationCounters,
  getReturnSyncFreshness,
  listReturnCarriers,
  loadDeliveryWindows,
  loadReturnOperationSettings,
  type ReturnOperationRow,
} from "@/lib/return-operations/queries";
import type { Breakdown, CarrierGroup, CountPair } from "@/lib/return-operations/summary";
import { displayDate, localTimeOf } from "@/lib/return-operations/time";
import { OUTSIDE_WINDOW_ID, OUTSIDE_WINDOW_LABEL } from "@/lib/return-operations/windows";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime, formatQuantity } from "@/lib/ui/format";
import { activeFilterCount, buildListHref, parsePage, parsePageSize } from "@/lib/ui/list-query";
import { AutoRefresh } from "@/components/patterns/auto-refresh";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { LastUpdated } from "@/components/patterns/last-updated";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader, SectionHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { OperationFilters, ReceiveButton, RefreshReturnsButton } from "./operation-controls";

export const dynamic = "force-dynamic";

type Params = { date?: string; shop?: string; carrier?: string; type?: string; window?: string; status?: string; q?: string; tab?: string; page?: string; size?: string };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN_CARRIER = "__none__";
const PATH = "/shopee/returns/operations";
type Tab = ReturnOperationType | "open";

const pair = (c: CountPair) => (
  <span className="tabular-nums">
    <span className="font-medium text-foreground">{c.orderCount}</span> đơn <span className="text-muted-foreground">|</span> {formatQuantity(c.itemQuantity)} SP
  </span>
);

export default async function ReturnOperationsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const auth = await requirePermission("channel:view");
  const role = auth.profile.role;
  const params = await searchParams;
  const today = getTodayDateVN();
  const date = params.date && DATE.test(params.date) ? params.date : today;
  const shopId = params.shop && params.shop !== "all" ? params.shop : null;
  const carrier = !params.carrier || params.carrier === "all" ? null : params.carrier === UNKNOWN_CARRIER ? "" : params.carrier;
  const typeFilter = isReturnOperationType(params.type) ? params.type : null;
  const windowFilter = params.window && params.window !== "all" ? params.window : null;
  const status = params.status && params.status !== "all" ? params.status : null;
  const tab: Tab = params.tab === "open" ? "open" : isReturnOperationType(params.tab) ? params.tab : (typeFilter ?? "customer_return");
  const pageSize = parsePageSize(params.size);
  const page = parsePage(params.page);

  const db = createAdminClient();
  const shops = (await listShops()).filter((s) => s.channel === "shopee");
  const scopeShopIds = shopId ? [shopId] : shops.filter((s) => s.isActive).map((s) => s.id);
  const [settings, windows, carriers] = await Promise.all([loadReturnOperationSettings(db), loadDeliveryWindows(db), listReturnCarriers(db)]);
  const listType: ReturnOperationType | null = tab === "open" ? typeFilter : tab;
  const [summary, list, counters, freshness, activeJobs] = await Promise.all([
    getDailyReturnOperationsSummary(db, { date, shopId, carrier, operationType: typeFilter, deliveryWindowId: windowFilter }, { scopeShopIds, windows }),
    getDailyReturnOperationsList(db, { date, shopId, carrier, operationType: listType, deliveryWindowId: windowFilter, status, search: params.q, view: tab === "open" ? "open" : "delivered", page, pageSize }),
    getReturnOperationCounters(db, date, shopId),
    getReturnSyncFreshness(db, scopeShopIds, settings.syncStaleWarnMinutes),
    db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("sync_type", ["return", "return_logistics", "failed_delivery"]).in("status", ["pending", "running", "retry"]).in("shop_id", scopeShopIds.length ? scopeShopIds : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  const people = await profileNames(db, list.rows);
  const syncing = (activeJobs.count ?? 0) > 0;
  const stale = freshness.filter((f) => f.stale);
  const query: Record<string, string | undefined> = { date: params.date, shop: params.shop, carrier: params.carrier, type: params.type, window: params.window, status: params.status, q: params.q, tab: params.tab, size: params.size };
  const filtered = activeFilterCount(query, ["shop", "carrier", "type", "window", "status", "q"]) > 0;
  const exportHref = buildListHref("/api/shopee/returns/operations/export", { ...query, tab }, {});
  const canSync = hasPermission(role, "channel:sync");
  const canReceive = hasPermission(role, "return:receive") && settings.confirmationEnabled;

  const windowOptions = [
    { label: "Mọi ca giao", value: "all" },
    ...windows.filter((w) => w.enabled).map((w) => ({ value: w.id, label: `${w.name} ${w.startTime}–${w.endTime}${w.carrier ? ` · ${w.carrier}` : ""}${w.shopId ? ` · ${shops.find((s) => s.id === w.shopId)?.shopName ?? "shop"}` : ""}` })),
    { label: OUTSIDE_WINDOW_LABEL, value: OUTSIDE_WINDOW_ID },
  ];
  const statusOptions = [
    { label: "Mọi trạng thái", value: "all" },
    { label: "Chưa xác nhận nhận", value: "unconfirmed" },
    { label: "Đã xác nhận nhận", value: "confirmed" },
    { label: "Cần chú ý", value: "attention" },
    ...RETURN_OP_CANONICAL_STATUSES.map((s) => ({ value: s, label: RETURN_OP_STATUS_INFO[s].label })),
  ];
  const carrierOptions = [{ label: "Mọi ĐVVC", value: "all" }, ...carriers.map((c) => ({ label: c, value: c })), { label: "Không rõ ĐVVC", value: UNKNOWN_CARRIER }];
  const tabCount: Record<Tab, number> = { customer_return: summary.customerReturn.orderCount, failed_delivery_return: summary.failedDeliveryReturn.orderCount, open: counters.open };

  return (
    <PageContainer>
      <PageHeader
        title={`Hàng hoàn đã giao — ${displayDate(date)}`}
        description="Đơn hoàn mà hãng vận chuyển báo đã giao thành công về shop, tính theo thời điểm giao (giờ Việt Nam). Chỉ theo dõi vận hành — không nhập kho, không đổi giá vốn hay lợi nhuận."
        actions={
          <>
            {hasPermission(role, "channel:manage") && (
              <Link href={`${PATH}/settings`} className={buttonVariants({ variant: "outline" })}>
                <Settings aria-hidden="true" /> Cấu hình
              </Link>
            )}
            <a href={exportHref} className={buttonVariants({ variant: "outline" })}>
              <Download aria-hidden="true" /> Xuất Excel
            </a>
            {canSync && <RefreshReturnsButton shopId={shopId} date={date} active={syncing} />}
          </>
        }
        meta={
          <>
            {freshness.map((f) => (
              <LastUpdated key={f.syncType} subject={f.label} at={f.lastSyncedAt} syncing={syncing} />
            ))}
            <AutoRefresh active={syncing} intervalMs={5_000} />
          </>
        }
      />

      {stale.length > 0 && (
        <Callout tone="warning" title="Dữ liệu có thể chưa mới">
          {stale.map((f) => (f.ageMinutes === null ? `${f.label}: chưa đồng bộ lần nào.` : `${f.label}: chưa được đồng bộ trong ${f.ageMinutes} phút.`)).join(" ")}
          {canSync && " Bấm “Làm mới dữ liệu hoàn” để đồng bộ ngay."}
        </Callout>
      )}

      <Card>
        <CardContent className="pt-6">
          <OperationFilters
            query={{ ...query, date }}
            shops={[{ label: "Mọi shop", value: "all" }, ...shops.map((s) => ({ label: s.shopName, value: s.id }))]}
            carriers={carrierOptions}
            windows={windowOptions}
            statuses={statusOptions}
            showWindow={tab !== "open"}
          />
        </CardContent>
      </Card>

      <MetricGrid>
        <MetricCard label="Hoàn Trả" icon={Undo2} value={summary.customerReturn.orderCount} hint={`${formatQuantity(summary.customerReturn.itemQuantity)} SP · khách trả hàng`} />
        <MetricCard label="Hoàn Hủy" icon={Truck} value={summary.failedDeliveryReturn.orderCount} hint={`${formatQuantity(summary.failedDeliveryReturn.itemQuantity)} SP · giao không thành công`} />
        <MetricCard label="Tổng đã giao về" icon={PackageCheck} value={summary.total.orderCount} hint={`${formatQuantity(summary.total.itemQuantity)} SP`} />
        <MetricCard label="Đang hoàn về" value={<Link href={buildListHref(PATH, query, { tab: "open", page: undefined })} className="underline-offset-4 hover:underline">{counters.open}</Link>} hint="chưa giao về shop (mọi ngày)" />
        <MetricCard label="Cần chú ý" tone={counters.attention > 0 ? "warning" : "neutral"} icon={AlertTriangle} value={<Link href={buildListHref(PATH, query, { tab: "open", status: "attention", page: undefined })} className="underline-offset-4 hover:underline">{counters.attention}</Link>} hint="kẹt / lỗi / chưa xác nhận" />
        {settings.confirmationEnabled && <MetricCard label="Chưa xác nhận nhận" tone={counters.unconfirmedToday > 0 ? "warning" : "neutral"} value={counters.unconfirmedToday} hint={`trong ngày ${displayDate(date)}`} />}
      </MetricGrid>

      <section className="space-y-3">
        <SectionHeader title="Theo đơn vị vận chuyển và ca giao" description="Tổng ngày = cộng các ca + nhóm ngoài ca; mỗi đơn chỉ thuộc đúng một ca theo giờ giao thành công." />
        {summary.carrierGroups.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <EmptyState icon={PackageCheck} variant={filtered ? "no-results" : "no-data"} title={filtered ? "Không có đơn hoàn phù hợp bộ lọc." : `Chưa có đơn hoàn nào được giao về shop ngày ${displayDate(date)}.`} description={date === today ? "Số liệu tự cập nhật mỗi 10–15 phút." : undefined} />
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {summary.carrierGroups.map((g) => (
              <CarrierCard key={g.label} group={g} query={query} highlight={date === today ? localTimeOf(new Date()).slice(0, 5) : null} />
            ))}
          </div>
        )}
        {summary.carrierGroups.length > 1 && (
          <Card size="sm">
            <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="font-semibold">TỔNG NGÀY</span>
              <span>Hoàn Trả: {pair(summary.customerReturn)}</span>
              <span>Hoàn Hủy: {pair(summary.failedDeliveryReturn)}</span>
              <span className="font-medium">Tổng: {pair(summary.total)}</span>
            </CardContent>
          </Card>
        )}
      </section>

      <Card>
        <CardHeader>
          <nav aria-label="Danh sách" className="flex flex-wrap gap-1 border-b">
            {(["customer_return", "failed_delivery_return", "open"] as const).map((t) => (
              <Link
                key={t}
                href={buildListHref(PATH, query, { tab: t, page: undefined, ...(t === "open" ? { window: undefined } : {}) })}
                aria-current={tab === t ? "page" : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t === "open" ? "Đang hoàn về" : RETURN_OPERATION_LABELS[t]} <span className="tabular-nums text-muted-foreground">({tabCount[t]})</span>
              </Link>
            ))}
          </nav>
        </CardHeader>
        <CardContent className="space-y-4">
          {list.rows.length === 0 ? (
            <EmptyState
              icon={tab === "failed_delivery_return" ? Truck : Undo2}
              variant={filtered ? "no-results" : "no-data"}
              title={tab === "open" ? "Không có đơn nào đang hoàn về." : `Không có ${RETURN_OPERATION_LABELS[tab]} nào giao về ngày ${displayDate(date)}${filtered ? " khớp bộ lọc" : ""}.`}
            />
          ) : (
            <>
              <OperationTable rows={list.rows} tab={tab} canReceive={canReceive} people={people} showShop={shops.length > 1} />
              <DataTablePagination pathname={PATH} query={{ ...query, tab }} page={page} pageSize={pageSize} total={list.total} />
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

function BreakdownCells({ b, strong = false }: { b: Breakdown; strong?: boolean }) {
  return (
    <>
      <TableCell className="text-right whitespace-nowrap">{pair(b.customerReturn)}</TableCell>
      <TableCell className="text-right whitespace-nowrap">{pair(b.failedDeliveryReturn)}</TableCell>
      <TableCell className={`text-right whitespace-nowrap ${strong ? "font-semibold" : "font-medium"}`}>{pair(b.total)}</TableCell>
    </>
  );
}

function CarrierCard({ group, query, highlight }: { group: CarrierGroup; query: Record<string, string | undefined>; highlight: string | null }) {
  const carrierParam = group.carrier ?? UNKNOWN_CARRIER;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck aria-hidden="true" className="size-4 text-muted-foreground" />
          <Link href={buildListHref(PATH, query, { carrier: carrierParam, page: undefined })} className="underline-offset-4 hover:underline">
            {group.label}
          </Link>
        </CardTitle>
        <span className="text-sm text-muted-foreground">{pair(group.total)}</span>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ca giao</TableHead>
              <TableHead className="text-right">Hoàn Trả</TableHead>
              <TableHead className="text-right">Hoàn Hủy</TableHead>
              <TableHead className="text-right">Tổng</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.deliveryWindows.map((w) => {
              const current = highlight !== null && w.startTime !== null && w.endTime !== null && highlight >= w.startTime && highlight <= w.endTime;
              return (
                <TableRow key={w.windowId} className={w.isOutside ? "text-muted-foreground" : undefined}>
                  <TableCell>
                    <Link href={buildListHref(PATH, query, { carrier: carrierParam, window: w.windowId, page: undefined })} className="font-medium underline-offset-4 hover:underline">
                      {w.name}
                    </Link>
                    {w.startTime && (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {w.startTime}–{w.endTime}
                        {current && " · đang diễn ra"}
                      </span>
                    )}
                  </TableCell>
                  <BreakdownCells b={w} />
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">TỔNG NGÀY</TableCell>
              <BreakdownCells b={group} strong />
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

async function profileNames(db: ReturnType<typeof createAdminClient>, rows: ReturnOperationRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => [r.assignedReceiverId, r.receivedConfirmedBy]).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const { data } = await db.from("profiles").select("id, full_name").in("id", ids);
  return new Map((data ?? []).map((p) => [p.id as string, (p.full_name as string | null) ?? "—"]));
}

function OperationTable({ rows, tab, canReceive, people, showShop }: { rows: ReturnOperationRow[]; tab: Tab; canReceive: boolean; people: Map<string, string>; showShop: boolean }) {
  const customer = tab === "customer_return";
  const open = tab === "open";
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{open ? "Cập nhật" : "Giờ giao thành công"}</TableHead>
            {open && <TableHead>Loại</TableHead>}
            <TableHead>Mã đơn</TableHead>
            {(customer || open) && <TableHead>Mã đơn hoàn</TableHead>}
            <TableHead>{customer ? "Mã vận đơn hoàn" : "Mã vận đơn"}</TableHead>
            {showShop && <TableHead>Shop</TableHead>}
            <TableHead>Sản phẩm</TableHead>
            <TableHead>Phân loại</TableHead>
            {/* <TableHead>SKU</TableHead> */}
            <TableHead className="text-right">{customer ? "SL hoàn" : "SL"}</TableHead>
            <TableHead>ĐVVC</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead>Nhận hàng</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const st = returnOpStatusInfo(r.canonicalStatus);
            const [first, ...rest] = r.items;
            const tracking = r.operationType === "customer_return" ? (r.rtsTrackingNumber ?? r.trackingNumber) : r.trackingNumber;
            return (
              <TableRow key={r.id} className="align-top">
                <TableCell className="whitespace-nowrap text-xs tabular-nums">
                  {open ? formatDateTime(r.lastStatusAt ?? r.lastSyncedAt) : r.deliveredToSellerAt ? formatDateTime(r.deliveredToSellerAt).slice(-5) : "—"}
                  {r.deliveredAtSource === "status_update_time" && <span className="block text-[11px] text-muted-foreground" title="Không có sự kiện giao chi tiết — dùng thời điểm cập nhật trạng thái">≈ theo trạng thái</span>}
                </TableCell>
                {open && <TableCell className="text-xs whitespace-nowrap">{RETURN_OPERATION_LABELS[r.operationType]}</TableCell>}
                <TableCell className="font-mono text-xs">
                  <Link href={`/shopee/orders/${r.channelOrderId}`} className="text-primary underline-offset-4 hover:underline">
                    {r.externalOrderSn}
                  </Link>
                </TableCell>
                {(customer || open) && (
                  <TableCell className="font-mono text-xs">
                    {r.returnId ? (
                      <Link href={`/shopee/returns/${r.returnId}`} className="underline-offset-4 hover:underline">
                        {r.returnSn}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="font-mono text-xs">{tracking ?? <span className="text-muted-foreground">chưa có</span>}</TableCell>
                {showShop && <TableCell className="max-w-28 truncate text-xs">{r.shopName}</TableCell>}
                <TableCell className="max-w-56 text-xs">
                  {first ? <span className="line-clamp-2">{first.name}</span> : <span className="text-muted-foreground">—</span>}
                  {rest.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-primary">+{rest.length} sản phẩm khác</summary>
                      <ul className="mt-1 space-y-1">
                        {rest.map((it, i) => (
                          <li key={i} className="border-l pl-2">
                            {it.name}
                            <span className="block text-muted-foreground">
                              {[it.model, it.sku].filter(Boolean).join(" · ") || "—"} · SL {formatQuantity(it.quantity)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </TableCell>
                <TableCell className="max-w-32 text-xs">{first?.model ?? "—"}</TableCell>
                {/* <TableCell className="font-mono text-xs">{first?.sku ?? "—"}</TableCell> */}
                <TableCell className="text-right tabular-nums">
                  {formatQuantity(r.itemQuantity)}
                  {rest.length > 0 && <span className="block text-[11px] text-muted-foreground">{r.items.length} dòng</span>}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">{r.carrier ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge tone={st.tone} icon={false}>
                    {st.label}
                  </StatusBadge>
                  {r.needsAttention && <span className="mt-1 block text-[11px] text-warning-text">{attentionLabel(r.attentionReason)}</span>}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {r.receivedConfirmedAt ? (
                    <span className="text-success-text">
                      Đã nhận {formatDateTime(r.receivedConfirmedAt).slice(-5)}
                      {r.receivedConfirmedBy && <span className="block text-muted-foreground">{people.get(r.receivedConfirmedBy)}</span>}
                    </span>
                  ) : r.assignedReceiverId ? (
                    <span className="text-muted-foreground">Phụ trách: {people.get(r.assignedReceiverId)}</span>
                  ) : null}
                  {canReceive && <div className="mt-1"><ReceiveButton operationId={r.id} confirmed={!!r.receivedConfirmedAt} /></div>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
