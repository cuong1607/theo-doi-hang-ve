"use client";

import { startTransition, useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  createInvoiceFromReceiptDays,
  getReceiptInvoicePreview,
  type CreateInvoiceFromReceiptsState,
  type ReceiptInvoicePreviewResult,
} from "@/lib/invoices/from-receipts-actions";
import { calculateInvoiceFinancials } from "@/lib/invoices/financials";
import { formatCurrency } from "@/lib/format";
import { InvoiceFinancialFields } from "@/components/invoices/invoice-financial-fields";
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

const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  business_household: "Hộ kinh doanh",
  company: "Công ty",
};

const initialState: CreateInvoiceFromReceiptsState = { status: "idle" };

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

export function CreateInvoiceFromReceiptsDialog({
  open,
  onOpenChange,
  supplierId,
  receiptDates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  receiptDates: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        {/* The body only mounts while open, so every opening re-runs the
            server preview and starts with fresh action state. */}
        {open && (
          <DialogBody supplierId={supplierId} receiptDates={receiptDates} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({
  supplierId,
  receiptDates,
  onClose,
}: {
  supplierId: string;
  receiptDates: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<ReceiptInvoicePreviewResult | null>(null);

  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(todayLocalDateString);
  const [note, setNote] = useState("");
  const [discountType, setDiscountType] = useState("none");
  const [discountValue, setDiscountValue] = useState("");
  const [vatRate, setVatRate] = useState("8");

  const [state, submit, isPending] = useActionState(createInvoiceFromReceiptDays, initialState);

  const datesKey = receiptDates.join(",");
  useEffect(() => {
    let cancelled = false;
    getReceiptInvoicePreview({ supplierId, receiptDates: datesKey.split(",") }).then((result) => {
      if (!cancelled) setPreview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [supplierId, datesKey]);

  useEffect(() => {
    if (state.status === "success" && state.invoice) {
      router.push(`/invoices/${state.invoice.id}`);
    }
  }, [state, router]);

  const draft = preview?.status === "success" ? preview.draft : null;
  const supplierType = draft?.supplier.supplier_type;

  // Live preview only — the server reloads the receipts and the supplier and
  // recomputes with the same calculateInvoiceFinancials before saving.
  const financials = useMemo(() => {
    if (!draft) return null;
    return calculateInvoiceFinancials({
      supplierType: draft.supplier.supplier_type,
      items: draft.lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })),
      discountType: discountType === "none" ? null : (discountType as "percent" | "fixed_amount"),
      discountValue: discountType === "none" ? null : Number(discountValue) || 0,
      vatRate: draft.supplier.supplier_type === "company" ? Number(vatRate) || 0 : null,
    });
  }, [draft, discountType, discountValue, vatRate]);

  const canSubmit = !!draft && !!invoiceNo.trim() && !!invoiceDate && !!financials?.ok && !isPending;

  function handleSubmit() {
    if (!draft) return;
    const household = supplierType === "business_household";
    startTransition(() => {
      submit({
        supplierId,
        receiptDates,
        invoiceNo,
        invoiceDate,
        note,
        discountType: household && discountType !== "none" ? (discountType as "percent" | "fixed_amount") : null,
        discountValue: household && discountType !== "none" ? Number(discountValue) || 0 : null,
        vatRate: supplierType === "company" ? Number(vatRate) || 0 : null,
      });
    });
  }

  function handleReload() {
    onClose();
    router.refresh();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8 text-lg font-semibold uppercase">Tạo hóa đơn từ hàng đã nhận</DialogTitle>
        <DialogDescription>
          Số lượng lấy từ SL nhận thực tế của đúng các ngày đã chọn (cả ca sáng và ca chiều). Không cần
          nhập lại từng sản phẩm.
        </DialogDescription>
      </DialogHeader>

      {!preview ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Đang tải dữ liệu hàng về...
        </div>
      ) : preview.status === "error" ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <AlertTriangle className="size-8 text-destructive" />
          <p className="font-medium">{preview.message}</p>
          <Button variant="outline" onClick={handleReload}>
            Tải lại dữ liệu
          </Button>
        </div>
      ) : (
        draft && (
          <div className="min-w-0 space-y-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-3">
              <Field label="Nhà cung cấp" value={`${draft.supplier.code} — ${draft.supplier.name}`} />
              <Field label="Loại NCC" value={SUPPLIER_TYPE_LABELS[draft.supplier.supplier_type] ?? "—"} />
              <Field label="Ngày hàng về đầu tiên" value={formatDateVN(draft.receiptStartDate)} />
              <div className="col-span-2 space-y-0.5 sm:col-span-3">
                <p className="text-muted-foreground">Các ngày hàng về đã chọn</p>
                <p className="font-medium">{draft.receiptDates.map(formatDateVN).join(", ")}</p>
              </div>
              <Field label="Tổng số ngày" value={String(draft.receiptDates.length)} />
              <Field label="Tổng SL nhận" value={String(draft.totalQuantity)} />
              <Field
                label="Tạm tính"
                value={formatCurrency(financials?.ok ? financials.data.subtotal : 0)}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label htmlFor="fromReceiptsInvoiceNo" className="text-sm font-medium">
                  Số hóa đơn *
                </label>
                <Input
                  id="fromReceiptsInvoiceNo"
                  value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                  maxLength={100}
                  autoFocus
                />
                {state.fieldErrors?.invoiceNo && (
                  <p className="text-xs text-destructive">{state.fieldErrors.invoiceNo[0]}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="fromReceiptsInvoiceDate" className="text-sm font-medium">
                  Ngày lập hóa đơn *
                </label>
                <Input
                  id="fromReceiptsInvoiceDate"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
                {state.fieldErrors?.invoiceDate && (
                  <p className="text-xs text-destructive">{state.fieldErrors.invoiceDate[0]}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="fromReceiptsNote" className="text-sm font-medium">
                  Ghi chú
                </label>
                <Input
                  id="fromReceiptsNote"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={1000}
                />
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {draft.supplier.supplier_type === "company" ? "VAT" : "Chiết khấu"}
              </p>
              <InvoiceFinancialFields
                supplierType={draft.supplier.supplier_type}
                discountType={discountType}
                onDiscountTypeChange={setDiscountType}
                discountValue={discountValue}
                onDiscountValueChange={setDiscountValue}
                vatRate={vatRate}
                onVatRateChange={setVatRate}
                fieldErrors={state.fieldErrors}
                className="grid grid-cols-1 gap-4 sm:grid-cols-3"
              />
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 bg-popover">
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Tên sản phẩm</TableHead>
                    <TableHead>ĐVT</TableHead>
                    <TableHead className="text-right">Đơn giá</TableHead>
                    <TableHead className="text-right">SL nhận</TableHead>
                    <TableHead className="text-right">Thành tiền</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draft.lines.map((l) => (
                    <TableRow key={`${l.product_id}-${l.unit_price}`}>
                      <TableCell className="font-medium">{l.sku}</TableCell>
                      <TableCell>{l.product_name}</TableCell>
                      <TableCell>{l.unit}</TableCell>
                      <TableCell className="text-right">{formatCurrency(Number(l.unit_price))}</TableCell>
                      <TableCell className="text-right">{l.quantity}</TableCell>
                      <TableCell className="text-right">{formatCurrency(Number(l.line_total))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="ml-auto grid w-full max-w-sm grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-muted-foreground">Tạm tính</span>
              <span className="text-right font-medium">
                {formatCurrency(financials?.ok ? financials.data.subtotal : 0)}
              </span>
              {draft.supplier.supplier_type === "company" ? (
                <>
                  <span className="text-muted-foreground">
                    VAT ({financials?.ok ? financials.data.vatRate : 0}%)
                  </span>
                  <span className="text-right font-medium">
                    {formatCurrency(financials?.ok ? financials.data.vatAmount : 0)}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">Chiết khấu</span>
                  <span className="text-right font-medium">
                    {formatCurrency(financials?.ok ? financials.data.discountAmount : 0)}
                  </span>
                </>
              )}
              <span className="font-medium">Tổng phải trả</span>
              <span className="text-right text-base font-semibold">
                {formatCurrency(financials?.ok ? financials.data.finalAmount : 0)}
              </span>
              {financials && !financials.ok && (
                <p className="col-span-2 text-xs text-destructive">{financials.error}</p>
              )}
            </div>

            {state.status === "error" && state.message && (
              <div className="flex flex-col gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
                <span>{state.message}</span>
                {state.stale && (
                  <Button variant="outline" size="sm" onClick={handleReload}>
                    Tải lại dữ liệu
                  </Button>
                )}
              </div>
            )}
          </div>
        )
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          Hủy
        </Button>
        {draft && (
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isPending ? "Đang lưu..." : "Lưu hóa đơn"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium break-words">{value}</p>
    </div>
  );
}
