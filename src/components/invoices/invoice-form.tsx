"use client";

import { startTransition, useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { getSupplierProducts, type SupplierProduct } from "@/lib/products/actions";
import { createInvoice, type InvoiceFormState } from "@/lib/invoices/actions";
import { calculateInvoiceFinancials, type SupplierType } from "@/lib/invoices/financials";

import { InvoiceItemRow } from "./invoice-item-row";

const initialState: InvoiceFormState = { status: "idle" };

const DISCOUNT_TYPE_OPTIONS = [
  { label: "Không áp dụng", value: "none" },
  { label: "Phần trăm (%)", value: "percent" },
  { label: "Số tiền cố định", value: "fixed_amount" },
];

export type InvoiceItemState = {
  key: number;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  unitPrice: string;
  quantity: string;
};

export type InvoiceSupplierOption = {
  id: string;
  code: string;
  name: string;
  supplier_type: SupplierType;
};

function todayLocalDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function emptyItem(key: number): InvoiceItemState {
  return { key, productId: "", sku: "", name: "", unit: "", unitPrice: "", quantity: "" };
}

export function InvoiceForm({ suppliers }: { suppliers: InvoiceSupplierOption[] }) {
  const router = useRouter();
  const nextKeyRef = useRef(1);

  const [invoiceDate, setInvoiceDate] = useState(todayLocalDateString());
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<InvoiceItemState[]>([]);

  // "none" is a UI-only sentinel for "no discount" — never sent as-is.
  const [discountType, setDiscountType] = useState("none");
  const [discountValue, setDiscountValue] = useState("");
  const [vatRate, setVatRate] = useState("8");

  const selectedSupplier = suppliers.find((s) => s.id === supplierId);

  const [availableProducts, setAvailableProducts] = useState<SupplierProduct[]>([]);
  const [loadingProducts, startLoadingProducts] = useTransition();

  const [state, submitInvoice, isPending] = useActionState(createInvoice, initialState);

  const [initialSnapshot] = useState(() => JSON.stringify({ invoiceDate, supplierId, invoiceNo, note, items }));
  const isDirty =
    JSON.stringify({ invoiceDate, supplierId, invoiceNo, note, items }) !== initialSnapshot;

  // Warn on tab close/refresh when there's unsaved data, same as receipts —
  // in-app navigation relies on the explicit "Hủy" button's confirm instead,
  // since App Router has no built-in navigation-block hook.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty) return;
      e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    startLoadingProducts(async () => {
      const result = await getSupplierProducts(supplierId);
      if (cancelled) return;
      setAvailableProducts(result.status === "success" ? result.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  // Switching supplier invalidates the previously loaded product list — per
  // spec, never silently keep a now-invalid item, so warn and clear rather
  // than guessing which rows are still valid.
  function handleSupplierChange(value: string) {
    if (items.length > 0) {
      const confirmed = window.confirm(
        "Đổi nhà cung cấp sẽ xóa danh sách sản phẩm hiện tại vì có thể không thuộc nhà cung cấp mới. Bạn có chắc muốn tiếp tục?"
      );
      if (!confirmed) return;
    }
    setSupplierId(value);
    setAvailableProducts([]);
    setItems([]);
    setDiscountType("none");
    setDiscountValue("");
    setVatRate("8");
  }

  useEffect(() => {
    if (state.status === "success" && state.invoice) {
      router.push(`/invoices/${state.invoice.id}`);
    }
  }, [state, router]);

  const usedProductIds = useMemo(() => new Set(items.map((i) => i.productId).filter(Boolean)), [items]);

  const totalQuantity = useMemo(
    () => items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
    [items]
  );

  // Client-side preview only, using the very same formula the server will
  // apply — but the server always recomputes independently from its own
  // supplier_type lookup and never trusts this result. See
  // src/lib/invoices/financials.ts.
  const financialsPreview = useMemo(() => {
    if (!selectedSupplier || items.length === 0) return null;
    return calculateInvoiceFinancials({
      supplierType: selectedSupplier.supplier_type,
      items: items.map((item) => ({
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.unitPrice) || 0,
      })),
      discountType: discountType === "none" ? null : (discountType as "percent" | "fixed_amount"),
      discountValue: discountType === "none" ? null : Number(discountValue) || 0,
      vatRate: selectedSupplier.supplier_type === "company" ? Number(vatRate) || 0 : null,
    });
  }, [selectedSupplier, items, discountType, discountValue, vatRate]);

  function handleAddItem() {
    setItems((prev) => [...prev, emptyItem(nextKeyRef.current++)]);
  }

  function handleItemChange(key: number, patch: Partial<InvoiceItemState>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function handleRemoveItem(key: number) {
    setItems((prev) => prev.filter((item) => item.key !== key));
  }

  function handleCancel() {
    if (isDirty && !window.confirm("Dữ liệu chưa lưu sẽ bị mất. Bạn có chắc muốn rời trang?")) {
      return;
    }
    router.push("/invoices");
  }

  const hasEmptyProductRow = items.some((item) => !item.productId);
  const canSubmit =
    !!invoiceDate &&
    !!supplierId &&
    !!invoiceNo.trim() &&
    items.length > 0 &&
    !hasEmptyProductRow &&
    !!financialsPreview?.ok;

  function handleSubmit() {
    // useActionState's dispatch must run inside a transition when invoked
    // outside a <form action>, otherwise `isPending` won't track it.
    startTransition(() => {
      submitInvoice({
        supplierId,
        invoiceNo,
        invoiceDate,
        note,
        discountType: discountType === "none" ? null : (discountType as "percent" | "fixed_amount"),
        discountValue: discountType === "none" ? null : Number(discountValue) || 0,
        vatRate: selectedSupplier?.supplier_type === "company" ? Number(vatRate) || 0 : null,
        items: items.map((item) => ({
          productId: item.productId,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
        })),
      });
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Thông tin hóa đơn</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="supplierId" className="text-sm font-medium">
              Nhà cung cấp *
            </label>
            <Select
              value={supplierId || null}
              onValueChange={(value) => handleSupplierChange(String(value))}
              items={suppliers.map((s) => ({ label: `${s.code} — ${s.name}`, value: s.id }))}
            >
              <SelectTrigger id="supplierId" className="w-full">
                <SelectValue placeholder="Chọn nhà cung cấp" />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state.fieldErrors?.supplierId && (
              <p className="text-xs text-destructive">{state.fieldErrors.supplierId[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="invoiceNo" className="text-sm font-medium">
              Số hóa đơn *
            </label>
            <Input
              id="invoiceNo"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              maxLength={100}
              required
            />
            {state.fieldErrors?.invoiceNo && (
              <p className="text-xs text-destructive">{state.fieldErrors.invoiceNo[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="invoiceDate" className="text-sm font-medium">
              Ngày hóa đơn *
            </label>
            <Input
              id="invoiceDate"
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
            <label htmlFor="note" className="text-sm font-medium">
              Ghi chú
            </label>
            <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Danh sách hàng hóa</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddItem}
            disabled={!supplierId || loadingProducts}
          >
            <Plus className="mr-2 size-4" />
            Thêm dòng
          </Button>
        </CardHeader>
        <CardContent>
          {!supplierId ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Vui lòng chọn nhà cung cấp trước.
            </p>
          ) : loadingProducts ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Đang tải sản phẩm...</p>
          ) : availableProducts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nhà cung cấp này chưa có sản phẩm đang hoạt động.
            </p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Chưa có dòng nào. Bấm &quot;Thêm dòng&quot; để bắt đầu.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Tên hàng</TableHead>
                  <TableHead>Đơn vị</TableHead>
                  <TableHead>Đơn giá</TableHead>
                  <TableHead>SL hóa đơn</TableHead>
                  <TableHead>Thành tiền</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const rowProducts = availableProducts.filter(
                    (p) => p.id === item.productId || !usedProductIds.has(p.id)
                  );
                  return (
                    <InvoiceItemRow
                      key={item.key}
                      item={item}
                      availableProducts={rowProducts}
                      onChange={(patch) => handleItemChange(item.key, patch)}
                      onRemove={() => handleRemoveItem(item.key)}
                    />
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selectedSupplier?.supplier_type === "business_household" && (
        <Card>
          <CardHeader>
            <CardTitle>Chiết khấu</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <label htmlFor="discountType" className="text-sm font-medium">
                Loại chiết khấu
              </label>
              <Select
                value={discountType}
                onValueChange={(value) => setDiscountType(String(value))}
                items={DISCOUNT_TYPE_OPTIONS}
              >
                <SelectTrigger id="discountType" className="w-full">
                  <SelectValue placeholder="Không áp dụng" />
                </SelectTrigger>
                <SelectContent>
                  {DISCOUNT_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {discountType !== "none" && (
              <div className="space-y-1.5">
                <label htmlFor="discountValue" className="text-sm font-medium">
                  Giá trị chiết khấu {discountType === "percent" ? "(%)" : "(VNĐ)"} *
                </label>
                <Input
                  id="discountValue"
                  type="number"
                  min={0}
                  max={discountType === "percent" ? 100 : undefined}
                  step="0.01"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                />
                {state.fieldErrors?.discountValue && (
                  <p className="text-xs text-destructive">{state.fieldErrors.discountValue[0]}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {selectedSupplier?.supplier_type === "company" && (
        <Card>
          <CardHeader>
            <CardTitle>VAT</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <label htmlFor="vatRate" className="text-sm font-medium">
                VAT (%)
              </label>
              <Input
                id="vatRate"
                type="number"
                min={0}
                step="0.01"
                value={vatRate}
                onChange={(e) => setVatRate(e.target.value)}
              />
              {state.fieldErrors?.vatRate && (
                <p className="text-xs text-destructive">{state.fieldErrors.vatRate[0]}</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Tổng hợp</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <SummaryField label="Tổng SL" value={String(totalQuantity)} />
          <SummaryField
            label="Tạm tính"
            value={formatCurrency(financialsPreview?.ok ? financialsPreview.data.subtotal : 0)}
          />
          <SummaryField
            label="Chiết khấu"
            value={formatCurrency(financialsPreview?.ok ? financialsPreview.data.discountAmount : 0)}
          />
          <SummaryField
            label="VAT"
            value={formatCurrency(financialsPreview?.ok ? financialsPreview.data.vatAmount : 0)}
          />
          <SummaryField
            label="Thành tiền"
            value={formatCurrency(financialsPreview?.ok ? financialsPreview.data.finalAmount : 0)}
            strong
          />
          {financialsPreview && !financialsPreview.ok && (
            <p className="col-span-full text-xs text-destructive">{financialsPreview.error}</p>
          )}
        </CardContent>
      </Card>

      {state.status === "error" && state.message && (
        <p className="text-sm text-destructive">{state.message}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={handleCancel} disabled={isPending}>
          Hủy
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={!canSubmit || isPending}>
          {isPending ? "Đang lưu..." : "Lưu hóa đơn"}
        </Button>
      </div>
    </div>
  );
}

function SummaryField({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p className={strong ? "text-base font-semibold" : "font-medium"}>{value}</p>
    </div>
  );
}
