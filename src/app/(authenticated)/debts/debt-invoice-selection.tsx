"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { formatCurrency } from "@/lib/format";
import { PAYMENT_STATUS_BADGE_VARIANT, PAYMENT_STATUS_LABELS } from "@/lib/debt/status";
import type { InvoiceDebtRow } from "@/lib/debt/invoice-debt";
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

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Selection state lives entirely client-side, scoped to the current page's
// rows — it intentionally resets on filter/page navigation rather than
// persisting selection across server-rendered pages. The "expected payment
// total" sum below is over the (small, user-clicked) selected set, not a
// stand-in for the overview cards — those always come from a server-side
// SQL aggregate over the full filtered set (see getDebtOverview).
export function DebtInvoiceSelection({ rows }: { rows: InvoiceDebtRow[] }) {
  const [selected, setSelected] = useState<Map<string, InvoiceDebtRow>>(new Map());
  const [warning, setWarning] = useState<string | null>(null);
  const [showSaveNotice, setShowSaveNotice] = useState(false);

  const selectedRows = [...selected.values()];
  const lockedSupplierId = selectedRows[0]?.supplier_id ?? null;
  const lockedSupplierLabel = selectedRows[0]
    ? `${selectedRows[0].supplier_code} — ${selectedRows[0].supplier_name}`
    : null;
  const selectedTotal = selectedRows.reduce((sum, r) => sum + r.remaining_amount, 0);

  function toggle(row: InvoiceDebtRow, checked: boolean) {
    setShowSaveNotice(false);

    if (!checked) {
      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(row.invoice_id);
        return next;
      });
      setWarning(null);
      return;
    }

    if (lockedSupplierId && row.supplier_id !== lockedSupplierId) {
      setWarning(
        `Chỉ được chọn các hóa đơn của cùng một nhà cung cấp trong một lần thanh toán. Bạn đang chọn hóa đơn của "${lockedSupplierLabel}" — bỏ chọn các hóa đơn đó trước nếu muốn thanh toán cho NCC khác.`
      );
      return;
    }

    setWarning(null);
    setSelected((prev) => new Map(prev).set(row.invoice_id, row));
  }

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Không có hóa đơn nào phù hợp.</p>;
  }

  return (
    <div className="space-y-3">
      {warning && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{warning}</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">Chọn</TableHead>
              <TableHead>Số HĐ</TableHead>
              <TableHead>Ngày HĐ</TableHead>
              <TableHead>NCC</TableHead>
              <TableHead>Giá trị HĐ</TableHead>
              <TableHead>Đã thanh toán</TableHead>
              <TableHead>Còn nợ</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead className="text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const selectable = row.remaining_amount > 0;
              const checked = selected.has(row.invoice_id);
              return (
                <TableRow key={row.invoice_id} data-state={checked ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Chọn hóa đơn ${row.invoice_no}`}
                      className="size-4 rounded border-border accent-primary disabled:cursor-not-allowed disabled:opacity-30"
                      checked={checked}
                      disabled={!selectable}
                      title={!selectable ? "Hóa đơn đã thanh toán đủ, không cần chọn" : undefined}
                      onChange={(e) => toggle(row, e.target.checked)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{row.invoice_no}</TableCell>
                  <TableCell>{formatDateVN(row.invoice_date)}</TableCell>
                  <TableCell>
                    {row.supplier_code} — {row.supplier_name}
                  </TableCell>
                  <TableCell>{formatCurrency(row.invoice_total)}</TableCell>
                  <TableCell>{formatCurrency(row.paid_amount)}</TableCell>
                  <TableCell className={row.remaining_amount > 0 ? "font-medium text-destructive" : undefined}>
                    {formatCurrency(row.remaining_amount)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={PAYMENT_STATUS_BADGE_VARIANT[row.payment_status]}>
                      {PAYMENT_STATUS_LABELS[row.payment_status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/invoices/${row.invoice_id}`} />}
                    >
                      Xem
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {selectedRows.length > 0 && (
        <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-lg">
          <div>
            <p className="text-sm">
              <span className="font-medium">{selectedRows.length} hóa đơn đã chọn</span>
              <span className="text-muted-foreground"> · {lockedSupplierLabel}</span>
            </p>
            <p className="text-lg font-bold">{formatCurrency(selectedTotal)}</p>
            <p className="text-xs text-muted-foreground">Tổng tiền thanh toán dự kiến</p>
          </div>
          <div className="flex items-center gap-3">
            {showSaveNotice && (
              <p className="max-w-56 text-xs text-muted-foreground">
                Tính năng lưu phiếu thanh toán sẽ hoàn thiện ở phase tiếp theo.
              </p>
            )}
            <Button onClick={() => setShowSaveNotice(true)}>Thanh toán các hóa đơn đã chọn</Button>
          </div>
        </div>
      )}
    </div>
  );
}
