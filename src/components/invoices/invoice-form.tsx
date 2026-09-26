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
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { getSupplierProducts, type SupplierProduct } from "@/lib/products/actions";
import { createInvoice, updateInvoice, type InvoiceFormState } from "@/lib/invoices/actions";
import {
  calculateInvoiceFinancials,
  inferSnapshotSupplierType,
  type SupplierType,
} from "@/lib/invoices/financials";

import { InvoiceFinancialFields } from "./invoice-financial-fields";
import { InvoiceItemRow } from "./invoice-item-row";

const initialState: InvoiceFormState = { status: "idle" };

export type InvoiceItemState = {
  key: number;
  // Present only for a row that already existed on the invoice before this
  // edit session — sent back so updateInvoice can update it in place
  // instead of deleting + reinserting.
  id?: string;
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

export type ExistingInvoice = {
  id: string;
  supplierId: string;
  invoiceNo: string;
  invoiceDate: string;
  note: string;
  discountType: "percent" | "fixed_amount" | null;
  discountValue: number | null;
  vatRate: number;
  // from_receipts invoices (INV-FROM-RECEIPTS): supplier and items are
  // locked — only header fields and discount/VAT are editable.
  sourceType?: "manual" | "from_receipts";
  items: {
    id: string;
    productId: string;
    sku: string;
    name: string;
    unit: string;
    unitPrice: string;
    quantity: string;
  }[];
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

export function InvoiceForm({
  suppliers,
  invoice,
}: {
  suppliers: InvoiceSupplierOption[];
  invoice?: ExistingInvoice;
}) {
  const isEdit = !!invoice;
  const itemsLocked = invoice?.sourceType === "from_receipts";
  const router = useRouter();
  // Initial items (if any) are keyed by index — safe since this only runs
  // once at mount, before nextKeyRef has generated any keys of its own.
  const nextKeyRef = useRef((invoice?.items.length ?? 0) + 1);

  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? todayLocalDateString());
  const [supplierId, setSupplierId] = useState(invoice?.supplierId ?? "");
  const [invoiceNo, setInvoiceNo] = useState(invoice?.invoiceNo ?? "");
  const [note, setNote] = useState(invoice?.note ?? "");
  const [items, setItems] = useState<InvoiceItemState[]>(
    () =>
      invoice?.items.map((i, index) => ({
        key: index,
        id: i.id,
        productId: i.productId,
        sku: i.sku,
        name: i.name,
        unit: i.unit,
        unitPrice: i.unitPrice,
        quantity: i.quantity,
      })) ?? []
  );

  // "none" is a UI-only sentinel for "no discount" — never sent as-is.
  const [discountType, setDiscountType] = useState(invoice?.discountType ?? "none");
  const [discountValue, setDiscountValue] = useState(
    invoice?.discountValue != null ? String(invoice.discountValue) : ""
  );
  const [vatRate, setVatRate] = useState(invoice ? String(invoice.vatRate || 8) : "8");

  // Which financial block is showing right now. Create mode: unset until a
  // supplier is picked. Edit mode: inferred from the invoice's own snapshot
  // (see inferSnapshotType), NOT from suppliers.find(...).supplier_type —
  // that's the live/current type, which this must ignore until the user
  // actually changes the supplier.
  const [activeFinancialType, setActiveFinancialType] = useState<SupplierType | "">(() => {
    if (!invoice) return "";
    const currentType = suppliers.find((s) => s.id === invoice.supplierId)?.supplier_type;
    return inferSnapshotSupplierType(invoice, currentType);
  });

  const [availableProducts, setAvailableProducts] = useState<SupplierProduct[]>([]);
  const [loadingProducts, startLoadingProducts] = useTransition();

  const action = isEdit ? updateInvoice.bind(null, invoice.id) : createInvoice;
  const [state, submitInvoice, isPending] = useActionState(action, initialState);

  function snapshotOf(fields: {
    invoiceDate: string;
    supplierId: string;
    invoiceNo: string;
    note: string;
    items: InvoiceItemState[];
    discountType: string;
    discountValue: string;
    vatRate: string;
  }) {
    return JSON.stringify({
      ...fields,
      items: fields.items.map(({ id, productId, unitPrice, quantity }) => ({
        id: id ?? null,
        productId,
        unitPrice,
        quantity,
      })),
    });
  }

  const [initialSnapshot] = useState(() =>
    snapshotOf({ invoiceDate, supplierId, invoiceNo, note, items, discountType, discountValue, vatRate })
  );
  const isDirty =
    snapshotOf({ invoiceDate, supplierId, invoiceNo, note, items, discountType, discountValue, vatRate }) !==
    initialSnapshot;

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
    if (!supplierId || itemsLocked) return;
    let cancelled = false;
    startLoadingProducts(async () => {
      const result = await getSupplierProducts(supplierId);
      if (cancelled) return;
      setAvailableProducts(result.status === "success" ? result.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [supplierId, itemsLocked]);

  // Switching supplier invalidates the previously loaded product list — per
  // spec, never silently keep a now-invalid item, so warn and clear rather
  // than guessing which rows are still valid. On top of that, if the new
  // supplier's type differs from the block currently showing, the
  // discount/VAT policy no longer applies and must be reset — confirmed
  // separately, since that's a distinct (financial, not just catalog) loss.
  function handleSupplierChange(value: string) {
    const newSupplier = suppliers.find((s) => s.id === value);
    if (!newSupplier) return;

    if (items.length > 0) {
      const confirmed = window.confirm(
        "Đổi nhà cung cấp sẽ xóa danh sách sản phẩm hiện tại vì có thể không thuộc nhà cung cấp mới. Bạn có chắc muốn tiếp tục?"
      );
      if (!confirmed) return;
    }

    const willResetFinancials = !!activeFinancialType && activeFinancialType !== newSupplier.supplier_type;
    if (willResetFinancials) {
      const message =
        newSupplier.supplier_type === "company"
          ? "Nhà cung cấp mới là Công ty: chiết khấu hiện tại sẽ bị xóa, VAT mặc định 8% sẽ được áp dụng. Bạn có chắc muốn tiếp tục?"
          : "Nhà cung cấp mới là Hộ kinh doanh: VAT sẽ được xóa (về 0). Bạn sẽ cần chọn lại chiết khấu (hoặc không áp dụng). Bạn có chắc muốn tiếp tục?";
      if (!window.confirm(message)) return;
    }

    setSupplierId(value);
    setAvailableProducts([]);
    setItems([]);
    setActiveFinancialType(newSupplier.supplier_type);
    if (willResetFinancials) {
      setDiscountType("none");
      setDiscountValue("");
      setVatRate("8");
    }
  }

  useEffect(() => {
    if (state.status === "success" && state.invoice) {
      router.push(`/invoices/${state.invoice.id}`);
    }
  }, [state, router]);

  // While the supplier hasn't changed from the invoice's original one, keep
  // the originally-assigned products selectable in their own row even if
  // they've since been deactivated — otherwise an existing row's SKU picker
  // would render with no matching option for its current value.
  const products = useMemo(() => {
    if (!invoice || supplierId !== invoice.supplierId) return availableProducts;
    const seen = new Set(availableProducts.map((p) => p.id));
    const extra = invoice.items
      .filter((i) => !seen.has(i.productId))
      .map((i) => ({
        id: i.productId,
        sku: i.sku,
        name: i.name,
        unit: i.unit,
        current_price: Number(i.unitPrice) || 0,
      }));
    return [...availableProducts, ...extra];
  }, [availableProducts, invoice, supplierId]);

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
    if (!activeFinancialType || items.length === 0) return null;
    return calculateInvoiceFinancials({
      supplierType: activeFinancialType,
      items: items.map((item) => ({
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.unitPrice) || 0,
      })),
      discountType: discountType === "none" ? null : (discountType as "percent" | "fixed_amount"),
      discountValue: discountType === "none" ? null : Number(discountValue) || 0,
      vatRate: activeFinancialType === "company" ? Number(vatRate) || 0 : null,
    });
  }, [activeFinancialType, items, discountType, discountValue, vatRate]);

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
    router.push(isEdit ? `/invoices/${invoice.id}` : "/invoices");
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
        discountType:
          activeFinancialType === "business_household" && discountType !== "none"
            ? (discountType as "percent" | "fixed_amount")
            : null,
        discountValue:
          activeFinancialType === "business_household" && discountType !== "none"
            ? Number(discountValue) || 0
            : null,
        vatRate: activeFinancialType === "company" ? Number(vatRate) || 0 : null,
        items: items.map((item) => ({
          id: item.id,
          productId: item.productId,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
        })),
      });
    });
  }

  return (
    <div className="space-y-6">
      {itemsLocked && (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Hóa đơn này được tạo từ hàng đã nhận: nhà cung cấp, các ngày hàng về liên kết và danh sách
          hàng không thể thay đổi. Chỉ sửa được số hóa đơn, ngày hóa đơn, ghi chú và chiết khấu/VAT.
          Muốn đổi ngày hàng về, cần xóa hóa đơn và tạo lại.
        </p>
      )}
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
              disabled={itemsLocked}
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
          {!itemsLocked && (
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
          )}
        </CardHeader>
        <CardContent>
          {itemsLocked ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Tên hàng</TableHead>
                  <TableHead>Đơn vị</TableHead>
                  <TableHead>Đơn giá</TableHead>
                  <TableHead>SL hóa đơn</TableHead>
                  <TableHead>Thành tiền</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.key}>
                    <TableCell className="font-medium">{item.sku}</TableCell>
                    <TableCell>{item.name}</TableCell>
                    <TableCell>{item.unit}</TableCell>
                    <TableCell>{formatCurrency(Number(item.unitPrice) || 0)}</TableCell>
                    <TableCell>{item.quantity}</TableCell>
                    <TableCell>
                      {formatCurrency(
                        Math.round((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0) * 100) / 100
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : !supplierId ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Vui lòng chọn nhà cung cấp trước.
            </p>
          ) : loadingProducts ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Đang tải sản phẩm...</p>
          ) : products.length === 0 ? (
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
                  const rowProducts = products.filter(
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

      {activeFinancialType && (
        <Card>
          <CardHeader>
            <CardTitle>{activeFinancialType === "company" ? "VAT" : "Chiết khấu"}</CardTitle>
          </CardHeader>
          <CardContent>
            <InvoiceFinancialFields
              supplierType={activeFinancialType}
              discountType={discountType}
              onDiscountTypeChange={setDiscountType}
              discountValue={discountValue}
              onDiscountValueChange={setDiscountValue}
              vatRate={vatRate}
              onVatRateChange={setVatRate}
              fieldErrors={state.fieldErrors}
            />
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
            label="Tổng phải trả"
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
          {isPending ? "Đang lưu..." : isEdit ? "Lưu thay đổi" : "Lưu hóa đơn"}
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
