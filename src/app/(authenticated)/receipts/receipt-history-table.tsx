"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FilePlus2 } from "lucide-react";

import type { DailyGroup } from "@/lib/receipts/history";
import { MIXED_SUPPLIER_MESSAGE } from "@/lib/invoices/receipt-days";
import { formatCurrency } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { CreateInvoiceFromReceiptsDialog } from "./create-invoice-from-receipts-dialog";

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function groupKey(g: DailyGroup) {
  return `${g.receipt_date}|${g.supplier_id}`;
}

// Selection only spans the rows currently rendered (this page of the
// current filters). The parent keys this component by the filter/page
// query string, so changing filters or page starts a fresh selection.
export function ReceiptHistoryTable({
  groups,
  canCreateInvoice,
}: {
  groups: DailyGroup[];
  canCreateInvoice: boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);

  const selectedGroups = useMemo(
    () => groups.filter((g) => selectedKeys.has(groupKey(g))),
    [groups, selectedKeys]
  );
  // The first picked row fixes the supplier for the whole selection.
  const selectedSupplierId = selectedGroups[0]?.supplier_id ?? null;
  const selectedSupplierLabel = selectedGroups[0]
    ? `${selectedGroups[0].supplier_code} — ${selectedGroups[0].supplier_name}`
    : "";

  function disabledReason(g: DailyGroup): string | null {
    if (g.linked_invoice_id) return `Ngày này đã được lập hóa đơn ${g.linked_invoice_no ?? ""}.`;
    if (selectedSupplierId && g.supplier_id !== selectedSupplierId) return MIXED_SUPPLIER_MESSAGE;
    return null;
  }

  // "Select all" = every still-selectable visible row of the selected
  // supplier; with nothing selected yet it only works when all selectable
  // visible rows already share one supplier (never mixes suppliers).
  const selectableForAll = useMemo(() => {
    const open = groups.filter((g) => !g.linked_invoice_id);
    const supplierId = selectedSupplierId ?? open[0]?.supplier_id ?? null;
    if (!supplierId) return [];
    if (!selectedSupplierId && open.some((g) => g.supplier_id !== supplierId)) return [];
    return open.filter((g) => g.supplier_id === supplierId);
  }, [groups, selectedSupplierId]);
  const allSelected =
    selectableForAll.length > 0 && selectableForAll.every((g) => selectedKeys.has(groupKey(g)));

  function toggle(g: DailyGroup, checked: boolean) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(groupKey(g));
      else next.delete(groupKey(g));
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedKeys(checked ? new Set(selectableForAll.map(groupKey)) : new Set());
  }

  const selectedDates = selectedGroups.map((g) => g.receipt_date).sort();

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {canCreateInvoice && (
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Chọn tất cả ngày có thể lập hóa đơn"
                  className="size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                  checked={allSelected}
                  disabled={selectableForAll.length === 0}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </TableHead>
            )}
            <TableHead>Ngày</TableHead>
            <TableHead>Nhà cung cấp</TableHead>
            <TableHead>Số SKU</TableHead>
            <TableHead>Tổng SL giao</TableHead>
            <TableHead>Tổng SL nhận</TableHead>
            <TableHead>Chênh lệch</TableHead>
            <TableHead>Tổng tiền</TableHead>
            <TableHead>VAT 8%</TableHead>
            <TableHead>Tổng sau VAT</TableHead>
            <TableHead>Trạng thái HĐ</TableHead>
            <TableHead className="text-right">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g) => {
            const vat = Math.round(g.total_line_total * 0.08 * 100) / 100;
            const grandTotal = Math.round(g.total_line_total * 1.08 * 100) / 100;
            const key = groupKey(g);
            const reason = disabledReason(g);
            const checked = selectedKeys.has(key);
            return (
              <TableRow key={key} data-state={checked ? "selected" : undefined}>
                {canCreateInvoice && (
                  <TableCell>
                    {reason ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="inline-flex" />}>
                          <input
                            type="checkbox"
                            aria-label={`Chọn ngày ${formatDateVN(g.receipt_date)} — ${g.supplier_name}`}
                            className="size-4 cursor-not-allowed accent-primary opacity-40"
                            checked={false}
                            disabled
                            readOnly
                          />
                        </TooltipTrigger>
                        <TooltipContent>{reason}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`Chọn ngày ${formatDateVN(g.receipt_date)} — ${g.supplier_name}`}
                        className="size-4 cursor-pointer accent-primary"
                        checked={checked}
                        onChange={(e) => toggle(g, e.target.checked)}
                      />
                    )}
                  </TableCell>
                )}
                <TableCell className="font-medium">{formatDateVN(g.receipt_date)}</TableCell>
                <TableCell>
                  {g.supplier_code} — {g.supplier_name}
                </TableCell>
                <TableCell>{g.sku_count}</TableCell>
                <TableCell>{g.total_delivered_qty}</TableCell>
                <TableCell>{g.total_received_qty}</TableCell>
                <TableCell className={g.total_difference_qty < 0 ? "text-destructive" : undefined}>
                  {g.total_difference_qty}
                </TableCell>
                <TableCell>{formatCurrency(g.total_line_total)}</TableCell>
                <TableCell>{formatCurrency(vat)}</TableCell>
                <TableCell className="font-medium">{formatCurrency(grandTotal)}</TableCell>
                <TableCell>
                  {g.linked_invoice_id ? (
                    <Badge variant="default" render={<Link href={`/invoices/${g.linked_invoice_id}`} />}>
                      Đã lập HĐ · {g.linked_invoice_no}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Chưa lập HĐ</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={`/receipts/daily/${g.receipt_date}/${g.supplier_id}`} />}
                  >
                    Xem
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {canCreateInvoice && selectedGroups.length > 0 && (
        <div className="sticky bottom-3 z-20 mt-4 flex flex-col gap-2 rounded-xl border bg-popover p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            <span className="font-medium">Đã chọn: {selectedGroups.length} ngày</span>
            <span className="text-muted-foreground"> · {selectedSupplierLabel}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedKeys(new Set())}>
              Bỏ chọn
            </Button>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <FilePlus2 className="mr-2 size-4" />
              Tạo hóa đơn từ hàng đã chọn
            </Button>
          </div>
        </div>
      )}

      {canCreateInvoice && selectedSupplierId && (
        <CreateInvoiceFromReceiptsDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          supplierId={selectedSupplierId}
          receiptDates={selectedDates}
        />
      )}
    </>
  );
}
