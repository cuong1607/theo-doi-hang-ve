"use client";

import { Eye, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  deleteNotificationSettingAction,
  deleteWindowScopeAction,
  previewNotificationAction,
  saveDefaultReceiverAction,
  saveNotificationSettingAction,
  saveOperationSettingsAction,
  saveWindowScopeAction,
} from "../actions";

const SELECT = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
type Option = { value: string; label: string };

// ------------------------------------------------------------ windows

type WindowRow = { key: string; id: string | null; name: string; startTime: string; endTime: string; enabled: boolean };
let seq = 0;
const newKey = () => `w${++seq}`;

export function WindowScopeEditor({
  shopId,
  carrier,
  title,
  initial,
  deletable,
}: {
  shopId: string | null;
  carrier: string | null;
  title: string;
  initial: Array<{ id: string; name: string; startTime: string; endTime: string; enabled: boolean }>;
  deletable: boolean;
}) {
  const [rows, setRows] = useState<WindowRow[]>(() => (initial.length > 0 ? initial.map((w) => ({ key: newKey(), ...w })) : [{ key: newKey(), id: null, name: "Ca sáng", startTime: "08:00", endTime: "11:59", enabled: true }]));
  const save = useAsyncAction({ refresh: true });
  const del = useAsyncAction({ refresh: true });
  const patch = (key: string, p: Partial<WindowRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="window-scope">
      <p className="text-sm font-medium">{title}</p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2">
            <Input value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} aria-label="Tên ca" maxLength={60} />
            <Input type="time" value={r.startTime} onChange={(e) => patch(r.key, { startTime: e.target.value })} aria-label="Từ giờ" className="w-28" />
            <Input type="time" value={r.endTime} onChange={(e) => patch(r.key, { endTime: e.target.value })} aria-label="Đến giờ" className="w-28" />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.key, { enabled: e.target.checked })} /> Bật
            </label>
            <Button variant="ghost" size="icon-sm" aria-label="Xoá ca" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, { key: newKey(), id: null, name: `Ca ${rs.length + 1}`, startTime: "", endTime: "", enabled: true }])}>
          <Plus /> Thêm ca
        </Button>
        <LoadingButton size="sm" loading={save.pending} icon={<Save />} onClick={() => save.run(() => saveWindowScopeAction({ shopId, carrier, windows: rows.map(({ id, name, startTime, endTime, enabled }) => ({ id, name, startTime, endTime, enabled })) }))}>
          Lưu ca giao
        </LoadingButton>
        {deletable && (
          <LoadingButton size="sm" variant="destructive" loading={del.pending} icon={<Trash2 />} onClick={() => del.run(() => deleteWindowScopeAction({ shopId, carrier }))}>
            Xoá nhóm
          </LoadingButton>
        )}
      </div>
    </div>
  );
}

export function NewWindowScope({ shops, carriers }: { shops: Option[]; carriers: string[] }) {
  const [shopId, setShopId] = useState("");
  const [carrier, setCarrier] = useState("");
  const [open, setOpen] = useState(false);
  if (open && (shopId || carrier.trim())) {
    return (
      <WindowScopeEditor
        shopId={shopId || null}
        carrier={carrier.trim() || null}
        title={`Mới: ${[carrier.trim() || "mọi ĐVVC", shops.find((s) => s.value === shopId)?.label ?? "mọi shop"].join(" · ")}`}
        initial={[]}
        deletable={false}
      />
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed p-3">
      <label className="space-y-1 text-xs">
        <span>Đơn vị vận chuyển</span>
        <Input list="carrier-options" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="VD: SPX Express" className="w-48" />
        <datalist id="carrier-options">
          {carriers.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      {shops.length > 1 && (
        <label className="space-y-1 text-xs">
          <span>Shop</span>
          <select className={SELECT} value={shopId} onChange={(e) => setShopId(e.target.value)}>
            <option value="">Mọi shop</option>
            {shops.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button variant="outline" size="sm" disabled={!shopId && !carrier.trim()} onClick={() => setOpen(true)}>
        <Plus /> Tạo ca riêng
      </Button>
    </div>
  );
}

// ------------------------------------------------------------ receivers + thresholds

export function ReceiverSelect({ operationType, label, value, users }: { operationType: "customer_return" | "failed_delivery_return"; label: string; value: string | null; users: Option[] }) {
  const { run, pending } = useAsyncAction({ refresh: true });
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <select className={SELECT} defaultValue={value ?? ""} disabled={pending} onChange={(e) => run(() => saveDefaultReceiverAction({ operationType, userId: e.target.value || null }))}>
        <option value="">— Chưa chọn —</option>
        {users.map((u) => (
          <option key={u.value} value={u.value}>
            {u.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function OperationSettingsForm({ initial }: { initial: { confirmationEnabled: boolean; confirmAttentionHours: number; stuckTransitDays: number; trackingMissingHours: number; syncStaleWarnMinutes: number; trackingLookbackDays: number } }) {
  const [v, setV] = useState(initial);
  const { run, pending } = useAsyncAction({ refresh: true });
  const num = (k: keyof typeof v, label: string, unit: string) => (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <Input type="number" value={String(v[k])} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} className="w-24" />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.confirmationEnabled} onChange={(e) => setV({ ...v, confirmationEnabled: e.target.checked })} /> Bật nút “Đã nhận” và cảnh báo “đã giao — chưa xác nhận”
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {num("confirmAttentionHours", "Cảnh báo khi đã giao nhưng chưa xác nhận sau", "giờ")}
        {num("stuckTransitDays", "Cảnh báo kẹt đường hoàn sau", "ngày")}
        {num("trackingMissingHours", "Cảnh báo Hoàn Hủy chưa có mã vận đơn sau", "giờ")}
        {num("syncStaleWarnMinutes", "Cảnh báo dữ liệu cũ sau", "phút")}
        {num("trackingLookbackDays", "Theo dõi vận chuyển cho đơn trong", "ngày gần nhất")}
      </div>
      <LoadingButton size="sm" loading={pending} icon={<Save />} onClick={() => run(() => saveOperationSettingsAction(v))}>
        Lưu ngưỡng
      </LoadingButton>
    </div>
  );
}

// ------------------------------------------------------------ notifications

export interface NotificationFormValue {
  id: string | null;
  shopId: string | null;
  name: string;
  enabled: boolean;
  carrierFilter: string | null;
  operationTypeFilter: "customer_return" | "failed_delivery_return" | null;
  includeDelta: boolean;
  includeDetail: boolean;
  presyncMinutes: number;
  slots: string[];
}

export function NotificationSettingForm({ initial, shops, carriers }: { initial: NotificationFormValue; shops: Option[]; carriers: string[] }) {
  const [v, setV] = useState(initial);
  const [slotText, setSlotText] = useState(initial.slots.join(", "));
  const [preview, setPreview] = useState<string | null>(null);
  const save = useAsyncAction({ refresh: true });
  const del = useAsyncAction({ refresh: true });
  const pre = useAsyncAction();
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="notification-setting">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span>Tên</span>
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Giờ gửi trong ngày (cách nhau dấu phẩy)</span>
          <Input value={slotText} onChange={(e) => setSlotText(e.target.value)} placeholder="10:30, 14:30, 18:30" aria-label="Giờ gửi" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Đơn vị vận chuyển</span>
          <Input list="notif-carrier-options" value={v.carrierFilter ?? ""} onChange={(e) => setV({ ...v, carrierFilter: e.target.value || null })} placeholder="Mọi ĐVVC" />
          <datalist id="notif-carrier-options">
            {carriers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Loại hoàn</span>
          <select className={SELECT} value={v.operationTypeFilter ?? ""} onChange={(e) => setV({ ...v, operationTypeFilter: (e.target.value || null) as NotificationFormValue["operationTypeFilter"] })}>
            <option value="">Hoàn Trả + Hoàn Hủy</option>
            <option value="customer_return">Chỉ Hoàn Trả</option>
            <option value="failed_delivery_return">Chỉ Hoàn Hủy</option>
          </select>
        </label>
        {shops.length > 1 && (
          <label className="block space-y-1 text-sm">
            <span>Shop</span>
            <select className={SELECT} value={v.shopId ?? ""} onChange={(e) => setV({ ...v, shopId: e.target.value || null })}>
              <option value="">Mọi shop</option>
              {shops.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block space-y-1 text-sm">
          <span>Đồng bộ trước giờ gửi</span>
          <span className="flex items-center gap-2">
            <Input type="number" value={String(v.presyncMinutes)} onChange={(e) => setV({ ...v, presyncMinutes: Number(e.target.value) })} className="w-20" /> <span className="text-xs text-muted-foreground">phút</span>
          </span>
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Bật gửi tự động (Zalo)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.includeDelta} onChange={(e) => setV({ ...v, includeDelta: e.target.checked })} /> Kèm số mới từ lần trước
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.includeDetail} onChange={(e) => setV({ ...v, includeDetail: e.target.checked })} /> Kèm vài mã đơn mới
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <LoadingButton size="sm" loading={save.pending} icon={<Save />} onClick={() => save.run(() => saveNotificationSettingAction({ ...v, slots: slotText.split(/[,;\s]+/).filter(Boolean) }))}>
          Lưu thông báo
        </LoadingButton>
        {v.id && (
          <>
            <LoadingButton
              size="sm"
              variant="outline"
              loading={pre.pending}
              icon={<Eye />}
              onClick={async () => {
                const r = await pre.run(() => previewNotificationAction(v.id!));
                setPreview(r && r.ok ? ((r as { preview?: string }).preview ?? null) : null);
              }}
            >
              Xem trước nội dung
            </LoadingButton>
            <LoadingButton size="sm" variant="destructive" loading={del.pending} icon={<Trash2 />} onClick={() => del.run(() => deleteNotificationSettingAction(v.id!))}>
              Xoá
            </LoadingButton>
          </>
        )}
      </div>
      {preview && <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap" data-testid="notification-preview">{preview}</pre>}
    </div>
  );
}
