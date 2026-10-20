import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/session";
import { listShops } from "@/lib/channels/core/queries";
import { loadNotificationSettings } from "@/lib/return-operations/notifications";
import { listReturnCarriers, loadDeliveryWindows, loadReturnOperationSettings } from "@/lib/return-operations/queries";
import { displayDate } from "@/lib/return-operations/time";
import { normalizeCarrier, type DeliveryWindow } from "@/lib/return-operations/windows";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { NewWindowScope, NotificationSettingForm, OperationSettingsForm, ReceiverSelect, WindowScopeEditor } from "./settings-forms";

export const dynamic = "force-dynamic";

const RUN_TONE = { sent: "success", partial: "warning", failed: "danger", no_recipients: "warning", generating: "info" } as const;
const RUN_LABEL = { sent: "Đã gửi", partial: "Gửi một phần", failed: "Lỗi", no_recipients: "Không có người nhận", generating: "Đang tạo" } as const;

export default async function ReturnOperationSettingsPage() {
  await requirePermission("channel:manage");
  const db = createAdminClient();
  const [shops, windows, carriers, opSettings, notifications, assignments, users, runs] = await Promise.all([
    listShops().then((s) => s.filter((x) => x.channel === "shopee")),
    loadDeliveryWindows(db),
    listReturnCarriers(db),
    loadReturnOperationSettings(db),
    loadNotificationSettings(db),
    db.from("return_operation_assignments").select("operation_type, default_receiver_user_id").is("shop_id", null),
    db.from("profiles").select("id, full_name, role").eq("is_active", true).in("role", ["admin", "staff"]).order("full_name"),
    db.from("return_notification_runs").select("id, business_date, scheduled_time, generated_at, total_order_count, total_item_qty, new_order_count, status, error, recipients_sent, recipients_total").order("generated_at", { ascending: false }).limit(20),
  ]);
  const shopOptions = shops.map((s) => ({ value: s.id, label: s.shopName }));
  const userOptions = (users.data ?? []).map((u) => ({ value: u.id as string, label: (u.full_name as string | null) ?? (u.id as string).slice(0, 8) }));
  const receiverOf = (t: string) => ((assignments.data ?? []).find((a) => a.operation_type === t)?.default_receiver_user_id as string | null) ?? null;

  // one editor per (shop, carrier) scope
  const scopes = new Map<string, { shopId: string | null; carrier: string | null; windows: DeliveryWindow[] }>();
  for (const w of windows) {
    const key = `${w.shopId ?? "*"}|${normalizeCarrier(w.carrier)}`;
    const s = scopes.get(key) ?? { shopId: w.shopId, carrier: w.carrier, windows: [] };
    s.windows.push(w);
    scopes.set(key, s);
  }
  const scopeList = [...scopes.values()].sort((a, b) => Number(!!a.shopId) + Number(!!a.carrier) - (Number(!!b.shopId) + Number(!!b.carrier)));
  const scopeTitle = (s: { shopId: string | null; carrier: string | null }) =>
    !s.shopId && !s.carrier ? "Mặc định chung (mọi ĐVVC, mọi shop)" : [s.carrier ?? "Mọi ĐVVC", s.shopId ? (shops.find((x) => x.id === s.shopId)?.shopName ?? "shop") : "mọi shop"].join(" · ");

  return (
    <PageContainer>
      <PageHeader
        title="Cấu hình hàng hoàn"
        description="Ca giao, người phụ trách, ngưỡng cảnh báo và lịch thông báo Zalo cho trang Hàng hoàn đã giao."
        actions={
          <Link href="/shopee/returns/operations" className={buttonVariants({ variant: "outline" })}>
            <ArrowLeft aria-hidden="true" /> Về trang hàng hoàn
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Ca giao (đợt giao hàng hoàn trong ngày)</CardTitle>
          <CardDescription>
            Mỗi đơn hoàn thuộc đúng một ca theo giờ hãng vận chuyển báo giao thành công (tính cả phút cuối: 08:00–11:59 gồm tới 11:59:59). Ngoài mọi ca → “Khác / Ngoài ca”. Ưu tiên: ĐVVC + shop → ĐVVC → shop → mặc định chung. Đổi ca sẽ áp dụng cho cả số liệu các ngày cũ trên trang (lịch sử thông báo đã gửi giữ nguyên).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {scopeList.map((s) => (
            <WindowScopeEditor key={`${s.shopId ?? "*"}|${s.carrier ?? ""}`} shopId={s.shopId} carrier={s.carrier} title={scopeTitle(s)} initial={s.windows.map((w) => ({ id: w.id, name: w.name, startTime: w.startTime, endTime: w.endTime, enabled: w.enabled }))} deletable={!!(s.shopId || s.carrier)} />
          ))}
          <NewWindowScope shops={shopOptions} carriers={carriers} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Người phụ trách mặc định</CardTitle>
            <CardDescription>Gán cho đơn hoàn mới phát sinh (không đổi các đơn đã có).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ReceiverSelect operationType="customer_return" label="Hoàn Trả" value={receiverOf("customer_return")} users={userOptions} />
            <ReceiverSelect operationType="failed_delivery_return" label="Hoàn Hủy" value={receiverOf("failed_delivery_return")} users={userOptions} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Ngưỡng cảnh báo</CardTitle>
            <CardDescription>“Đã nhận” chỉ là xác nhận nội bộ — không nhập kho, không đổi giá vốn / lợi nhuận.</CardDescription>
          </CardHeader>
          <CardContent>
            <OperationSettingsForm initial={opSettings} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thông báo Zalo theo giờ</CardTitle>
          <CardDescription>
            Gửi tới người nhận đang bật ở Cài đặt → Thông báo. Trước mỗi giờ gửi, hệ thống tự đồng bộ dữ liệu hoàn. Số “mới từ lần trước” tính theo đúng danh sách đơn của lần gửi trước (không phải phép trừ số lượng); lần gửi đầu ngày ghi “Phát sinh từ đầu ngày”. Giờ đã qua quá 45 phút (ví dụ hệ thống ngừng) sẽ bỏ qua, không gửi bù.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {notifications.map((n) => (
            <NotificationSettingForm
              key={n.id}
              shops={shopOptions}
              carriers={carriers}
              initial={{ id: n.id, shopId: n.shopId, name: n.name, enabled: n.enabled, carrierFilter: n.carrierFilter, operationTypeFilter: n.operationTypeFilter, includeDelta: n.includeDelta, includeDetail: n.includeDetail, presyncMinutes: n.presyncMinutes, slots: n.schedules.map((s) => s.timeOfDay) }}
            />
          ))}
          <details open={notifications.length === 0}>
            <summary className="cursor-pointer text-sm font-medium text-primary">+ Thêm lịch thông báo</summary>
            <div className="mt-3">
              <NotificationSettingForm
                shops={shopOptions}
                carriers={carriers}
                initial={{ id: null, shopId: null, name: "Hàng hoàn đã giao", enabled: false, carrierFilter: null, operationTypeFilter: null, includeDelta: true, includeDetail: false, presyncMinutes: 10, slots: ["10:30", "14:30", "18:30"] }}
              />
            </div>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lịch sử thông báo</CardTitle>
          <CardDescription>20 lần gần nhất. Ảnh chụp số liệu tại lúc gửi — không bị sửa khi dữ liệu thay đổi sau đó.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {(runs.data ?? []).length === 0 ? (
            <EmptyState title="Chưa gửi thông báo nào." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày</TableHead>
                  <TableHead>Giờ</TableHead>
                  <TableHead className="text-right">Tổng đơn</TableHead>
                  <TableHead className="text-right">Mới</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Tạo lúc</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs.data ?? []).map((r) => (
                  <TableRow key={r.id as string}>
                    <TableCell>{displayDate(r.business_date as string)}</TableCell>
                    <TableCell className="tabular-nums">{String(r.scheduled_time).slice(0, 5)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.total_order_count as number}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.new_order_count === null ? "đầu ngày" : `+${r.new_order_count}`}</TableCell>
                    <TableCell>
                      <StatusBadge tone={RUN_TONE[r.status as keyof typeof RUN_TONE] ?? "neutral"} icon={false}>
                        {RUN_LABEL[r.status as keyof typeof RUN_LABEL] ?? String(r.status)}
                      </StatusBadge>
                      {r.recipients_total !== null && <span className="ml-1 text-xs text-muted-foreground">{r.recipients_sent as number}/{r.recipients_total as number}</span>}
                      {r.error && <span className="block text-xs text-danger-text">{String(r.error).slice(0, 120)}</span>}
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(r.generated_at as string)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
