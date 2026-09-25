"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { formatCurrency } from "@/lib/format";
import { PAYMENT_STATUS_BADGE_VARIANT, PAYMENT_STATUS_LABELS } from "@/lib/debt/status";
import type { InvoiceDebtRow } from "@/lib/debt/invoice-debt";
import { createPayment, type PaymentFormState } from "@/lib/payments/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const initialPaymentState: PaymentFormState = { status: "idle" };

const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  business_household: "Hộ kinh doanh",
  company: "Công ty",
};

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function todayLocalDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Selection state lives entirely client-side, scoped to the current page's
// rows — it intentionally resets on filter/page navigation rather than
// persisting selection across server-rendered pages. canPay=false (viewer
// role) renders the same table read-only: no checkboxes, no payment button.
export function DebtInvoiceSelection({ rows, canPay }: { rows: InvoiceDebtRow[]; canPay: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Map<string, InvoiceDebtRow>>(new Map());
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);

  // The "just paid" success banner is derived from URL params (via
  // useSearchParams), not client state set on success — a client-side flag
  // would be wiped out by the loading.tsx Suspense fallback that the
  // navigation below swaps in while the page's fresh data loads (that
  // fallback replaces this whole component's rendered tree, so any of its
  // local state doesn't survive the trip). Reading from the URL instead
  // survives that remount because it's re-derived fresh every render.
  const paidCount = searchParams.get("paidCount");
  const paidTotal = searchParams.get("paidTotal");

  const selectedRows = [...selected.values()];
  const lockedSupplierId = selectedRows[0]?.supplier_id ?? null;
  const lockedSupplierLabel = selectedRows[0]
    ? `${selectedRows[0].supplier_code} — ${selectedRows[0].supplier_name}`
    : null;
  const selectedTotal = selectedRows.reduce((sum, r) => sum + r.remaining_amount, 0);

  function dismissPaidBanner() {
    if (!paidCount && !paidTotal) return;
    const qp = new URLSearchParams(searchParams.toString());
    qp.delete("paidCount");
    qp.delete("paidTotal");
    const qs = qp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function toggle(row: InvoiceDebtRow, checked: boolean) {
    dismissPaidBanner();

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

  function openConfirm() {
    setDialogKey((k) => k + 1); // remount PaymentConfirmDialog with fresh action state
    setConfirmOpen(true);
  }

  function handlePaid(count: number, total: number) {
    setSelected(new Map());
    setWarning(null);
    setConfirmOpen(false);
    const qp = new URLSearchParams(searchParams.toString());
    qp.delete("page");
    qp.set("paidCount", String(count));
    qp.set("paidTotal", String(total));
    router.push(`${pathname}?${qp.toString()}`);
  }

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Không có hóa đơn nào phù hợp.</p>;
  }

  return (
    <div className="space-y-3">
      {paidCount && paidTotal && (
        <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span>
            Đã lưu thanh toán {paidCount} hóa đơn, tổng {formatCurrency(Number(paidTotal))}.
          </span>
        </div>
      )}

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
              {canPay && <TableHead className="w-10">Chọn</TableHead>}
              <TableHead>Số HĐ</TableHead>
              <TableHead>Ngày HĐ</TableHead>
              <TableHead>NCC</TableHead>
              <TableHead>Loại NCC</TableHead>
              <TableHead>Tạm tính</TableHead>
              <TableHead>Chiết khấu</TableHead>
              <TableHead>VAT</TableHead>
              <TableHead>Tổng phải trả</TableHead>
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
                  {canPay && (
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
                  )}
                  <TableCell className="font-medium">{row.invoice_no}</TableCell>
                  <TableCell>{formatDateVN(row.invoice_date)}</TableCell>
                  <TableCell>
                    {row.supplier_code} — {row.supplier_name}
                  </TableCell>
                  <TableCell>{SUPPLIER_TYPE_LABELS[row.supplier_type] ?? row.supplier_type}</TableCell>
                  <TableCell>{formatCurrency(row.subtotal)}</TableCell>
                  <TableCell>{formatCurrency(row.discount_amount)}</TableCell>
                  <TableCell>{formatCurrency(row.vat_amount)}</TableCell>
                  <TableCell className="font-medium">{formatCurrency(row.final_amount)}</TableCell>
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

      {canPay && selectedRows.length > 0 && (
        <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-lg">
          <div>
            <p className="text-sm">
              <span className="font-medium">{selectedRows.length} hóa đơn đã chọn</span>
              <span className="text-muted-foreground"> · {lockedSupplierLabel}</span>
            </p>
            <p className="text-lg font-bold">{formatCurrency(selectedTotal)}</p>
            <p className="text-xs text-muted-foreground">Tổng tiền thanh toán dự kiến</p>
          </div>
          <Button onClick={openConfirm}>Thanh toán các hóa đơn đã chọn</Button>
        </div>
      )}

      {canPay && confirmOpen && (
        <PaymentConfirmDialog
          key={dialogKey}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          supplierLabel={lockedSupplierLabel ?? ""}
          supplierId={lockedSupplierId ?? ""}
          rows={selectedRows}
          onPaid={handlePaid}
        />
      )}
    </div>
  );
}

function PaymentConfirmDialog({
  open,
  onOpenChange,
  supplierLabel,
  supplierId,
  rows,
  onPaid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierLabel: string;
  supplierId: string;
  rows: InvoiceDebtRow[];
  onPaid: (count: number, total: number) => void;
}) {
  const [state, submitPayment, isPending] = useActionState(createPayment, initialPaymentState);
  const [paymentDate, setPaymentDate] = useState(todayLocalDateString());
  const [note, setNote] = useState("");

  const total = rows.reduce((sum, r) => sum + r.remaining_amount, 0);

  useEffect(() => {
    if (state.status === "success" && state.payment) {
      onPaid(state.payment.invoiceCount, state.payment.totalAmount);
    }
    // onPaid is intentionally not in deps — it's stable-enough per render
    // and including it would re-fire this on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function handleConfirm() {
    startTransition(() => {
      submitPayment({
        supplierId,
        paymentDate,
        note,
        invoiceIds: rows.map((r) => r.invoice_id),
      });
    });
  }

  // Ignore close attempts (X button, overlay click, Esc) while the action is
  // in flight — the payment RPC has already been sent at that point, so
  // unmounting this dialog would only stop the client from seeing the
  // result (no success banner, selection not cleared, page not refreshed)
  // while the payment still gets created server-side. The explicit "Hủy"
  // button already disables itself the same way.
  function handleOpenChange(next: boolean) {
    if (isPending) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>Xác nhận thanh toán</DialogTitle>
          <DialogDescription>
            Thanh toán FULL số còn nợ của {rows.length} hóa đơn đã chọn — chưa hỗ trợ nhập số tiền tùy chỉnh.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Nhà cung cấp</p>
              <p className="font-medium">{supplierLabel}</p>
            </div>
            <div className="space-y-1">
              <label htmlFor="paymentDate" className="text-xs font-medium text-muted-foreground">
                Ngày thanh toán
              </label>
              <Input
                id="paymentDate"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.invoice_id} className="border-b last:border-0">
                    <td className="px-2.5 py-1.5">{r.invoice_no}</td>
                    <td className="px-2.5 py-1.5 text-right font-medium">
                      {formatCurrency(r.remaining_amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
            <span className="text-sm font-medium">Tổng thanh toán</span>
            <span className="text-base font-bold">{formatCurrency(total)}</span>
          </div>

          <div className="space-y-1">
            <label htmlFor="paymentNote" className="text-xs font-medium text-muted-foreground">
              Ghi chú
            </label>
            <Input id="paymentNote" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </div>

          {state.status === "error" && state.message && (
            <p className="text-sm text-destructive">{state.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Hủy
          </Button>
          <Button onClick={handleConfirm} disabled={isPending || total <= 0}>
            {isPending ? "Đang lưu..." : "Xác nhận thanh toán"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
