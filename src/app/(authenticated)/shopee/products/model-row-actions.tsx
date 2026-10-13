"use client";

import { useEffect, useState, useTransition } from "react";
import { Info, Link2, MoreHorizontal, Unlink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

import { changeUsedChannelModelMappingAction, mapChannelModelAction, searchInternalProductsAction, unmapChannelModelAction } from "./actions";

/** Serializable subset of the listing row needed by the dialogs (no secrets exist on it). */
export type ModelRowView = {
  channelModelId: string;
  shopName: string;
  externalItemId: string;
  externalModelId: string;
  isSynthetic: boolean;
  itemName: string;
  modelName: string | null;
  itemSku: string | null;
  modelSku: string | null;
  itemStatus: string | null;
  modelStatus: string | null;
  isKit: boolean | null;
  priceText: string;
  availableStock: string | null;
  reservedStock: string | null;
  lastSyncedText: string;
  removed: boolean;
  internalSku: string | null;
  internalProductName: string | null;
  mappingLabel: string;
  /** Order lines already resolved through this unit (> 0 → unmap blocked, remap needs a reason). */
  orderItemCount: number;
};

type ProductOption = { id: string; sku: string; name: string; isActive: boolean };

function MapDialog({ row, open, onOpenChange }: { row: ModelRowView; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [term, setTerm] = useState(row.modelSku ?? row.itemSku ?? "");
  const [options, setOptions] = useState<ProductOption[]>([]);
  const [selected, setSelected] = useState<ProductOption | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Already mapped AND used by orders → only the audited, reason-required flow (admin).
  const controlled = row.orderItemCount > 0 && row.internalSku !== null;

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(async () => setOptions(term.trim() ? await searchInternalProductsAction(term) : []), 250);
    return () => clearTimeout(handle);
  }, [term, open]);

  function save() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      const res = controlled
        ? await changeUsedChannelModelMappingAction({ channelModelId: row.channelModelId, internalProductId: selected.id, reason })
        : await mapChannelModelAction({ channelModelId: row.channelModelId, internalProductId: selected.id });
      if (res.ok) onOpenChange(false);
      else setError(res.message);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ghép SKU nội bộ</DialogTitle>
          <DialogDescription>
            {row.itemName}
            {row.modelName ? ` — ${row.modelName}` : ""} (SKU Shopee: {row.modelSku ?? row.itemSku ?? "trống"})
          </DialogDescription>
        </DialogHeader>
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Tìm theo SKU hoặc tên sản phẩm nội bộ..." autoFocus />
        <div className="max-h-64 overflow-y-auto rounded-md border">
          {options.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{term.trim() ? "Không có sản phẩm phù hợp." : "Nhập từ khóa để tìm."}</p>
          ) : (
            options.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p)}
                className={`flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent ${selected?.id === p.id ? "bg-accent" : ""}`}
              >
                <span>
                  <span className="font-medium">{p.sku}</span> — {p.name}
                </span>
                {!p.isActive && <Badge variant="secondary">Ngừng HĐ</Badge>}
              </button>
            ))
          )}
        </div>
        {controlled && (
          <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p>
              Đã có {row.orderItemCount} dòng đơn hàng dùng mapping hiện tại ({row.internalSku}). Đổi mapping chỉ áp dụng cho đơn mới —
              đơn cũ giữ nguyên SKU đã ghi. Bắt buộc ghi lý do (được lưu lịch sử).
            </p>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do điều chỉnh (tối thiểu 5 ký tự)" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Hủy
          </Button>
          <Button onClick={save} disabled={!selected || pending || (controlled && reason.trim().length < 5)}>
            {pending ? "Đang lưu..." : selected ? `Ghép với ${selected.sku}` : "Chọn sản phẩm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailDialog({ row, open, onOpenChange }: { row: ModelRowView; open: boolean; onOpenChange: (v: boolean) => void }) {
  const fields: Array<[string, string]> = [
    ["Shop", row.shopName],
    ["item_id", row.externalItemId],
    ["model_id", row.isSynthetic ? "NO_MODEL (nội bộ — sản phẩm không có biến thể)" : row.externalModelId],
    ["Tên sản phẩm", row.itemName],
    ["Tên biến thể", row.modelName ?? "—"],
    ["SKU sản phẩm", row.itemSku ?? "—"],
    ["SKU biến thể", row.isSynthetic ? "—" : row.modelSku ?? "—"],
    ["Trạng thái Shopee", `${row.itemStatus ?? "—"}${row.modelStatus && !row.isSynthetic ? ` / ${row.modelStatus}` : ""}${row.removed ? " · đã gỡ khỏi Shopee" : ""}`],
    ["Combo / kit", row.isKit == null ? "—" : row.isKit ? "Có" : "Không"],
    ["Giá bán Shopee", row.priceText],
    ["Tồn Shopee (khả dụng / giữ chỗ)", `${row.availableStock ?? "—"} / ${row.reservedStock ?? "—"}`],
    ["Đồng bộ lần cuối", row.lastSyncedText],
    ["SKU nội bộ", row.internalSku ? `${row.internalSku} — ${row.internalProductName ?? ""}` : "Chưa ghép"],
    ["Trạng thái ghép", row.mappingLabel],
    ["Dòng đơn hàng dùng mapping", row.orderItemCount > 0 ? `${row.orderItemCount} (khóa bỏ ghép)` : "0"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Chi tiết biến thể Shopee</DialogTitle>
          <DialogDescription>Giá và tồn kho Shopee chỉ để tham khảo — không phải giá vốn hay tồn kho nội bộ.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[170px_1fr] gap-x-3 gap-y-1.5 text-sm">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

export function ModelRowActions({ row, canMap, canManage }: { row: ModelRowView; canMap: boolean; canManage: boolean }) {
  const usedByOrders = row.orderItemCount > 0 && row.internalSku !== null;
  // Remapping a unit used by orders is an audited admin-only adjustment.
  const canChangeMapping = canMap && (!usedByOrders || canManage);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapKey, setMapKey] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function unmap() {
    setError(null);
    startTransition(async () => {
      const res = await unmapChannelModelAction(row.channelModelId);
      if (res.ok) setConfirmOpen(false);
      else setError(res.message);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
          <MoreHorizontal />
          <span className="sr-only">Thao tác</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDetailOpen(true)}>
            <Info /> Chi tiết
          </DropdownMenuItem>
          {canChangeMapping && (
            <DropdownMenuItem
              onClick={() => {
                setMapKey((k) => k + 1);
                setMapOpen(true);
              }}
            >
              <Link2 /> {usedByOrders ? "Điều chỉnh mapping (có lý do)" : row.internalSku ? "Đổi SKU nội bộ" : "Ghép SKU nội bộ"}
            </DropdownMenuItem>
          )}
          {canMap && row.internalSku && !usedByOrders && (
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
              <Unlink /> Bỏ ghép
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DetailDialog row={row} open={detailOpen} onOpenChange={setDetailOpen} />
      {canChangeMapping && <MapDialog key={mapKey} row={row} open={mapOpen} onOpenChange={setMapOpen} />}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bỏ ghép SKU?</DialogTitle>
            <DialogDescription>
              Biến thể &quot;{row.itemName}
              {row.modelName ? ` — ${row.modelName}` : ""}&quot; sẽ không còn gắn với {row.internalSku}.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={pending}>
              Hủy
            </Button>
            <Button variant="destructive" onClick={unmap} disabled={pending}>
              {pending ? "Đang xử lý..." : "Bỏ ghép"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
