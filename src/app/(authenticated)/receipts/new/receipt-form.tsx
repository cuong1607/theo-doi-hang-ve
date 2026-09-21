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

import { createReceipt, getSupplierProducts, type CreateReceiptState, type SupplierProduct } from "./actions";
import { ReceiptItemRow } from "./receipt-item-row";

const initialState: CreateReceiptState = { status: "idle" };

const SHIFT_OPTIONS = [
  { label: "Ca sáng", value: "morning" },
  { label: "Ca chiều", value: "afternoon" },
];

export type ReceiptItemState = {
  key: number;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  unitPrice: string;
  deliveredQty: string;
  receivedQty: string;
};

function todayLocalDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function emptyItem(key: number): ReceiptItemState {
  return {
    key,
    productId: "",
    sku: "",
    name: "",
    unit: "",
    unitPrice: "",
    deliveredQty: "",
    receivedQty: "",
  };
}

export function ReceiptForm({
  suppliers,
}: {
  suppliers: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const nextKeyRef = useRef(1);

  const [receiptDate, setReceiptDate] = useState(todayLocalDateString());
  const [supplierId, setSupplierId] = useState("");
  const [shift, setShift] = useState("");
  const [receiverName, setReceiverName] = useState("");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<ReceiptItemState[]>([]);

  const [availableProducts, setAvailableProducts] = useState<SupplierProduct[]>([]);
  const [loadingProducts, startLoadingProducts] = useTransition();

  const [state, submitReceipt, isPending] = useActionState(createReceipt, initialState);

  const isDirty =
    !!supplierId || !!shift || !!receiverName || !!note || items.length > 0;

  // Warn on tab close/refresh when there's unsaved data. In-app navigation
  // via the sidebar isn't intercepted — Next.js App Router has no built-in
  // navigation-block hook — but the explicit "Hủy" button below confirms.
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

  // Switching supplier invalidates the previously loaded product list and
  // any items picked from it — reset synchronously with the user's action
  // rather than via an effect.
  function handleSupplierChange(value: string) {
    setSupplierId(value);
    setAvailableProducts([]);
    setItems([]);
  }

  useEffect(() => {
    if (state.status === "success" && state.receipt) {
      router.push(`/receipts/${state.receipt.id}`);
    }
  }, [state, router]);

  const usedProductIds = useMemo(() => new Set(items.map((i) => i.productId).filter(Boolean)), [items]);

  const summary = useMemo(() => {
    let totalDelivered = 0;
    let totalReceived = 0;
    let totalAmount = 0;
    for (const item of items) {
      const delivered = Number(item.deliveredQty) || 0;
      const received = Number(item.receivedQty) || 0;
      const unitPrice = Number(item.unitPrice) || 0;
      totalDelivered += delivered;
      totalReceived += received;
      totalAmount += received * unitPrice;
    }
    const totalDifference = totalReceived - totalDelivered;
    const vatAmount = Math.round(totalAmount * 0.08 * 100) / 100;
    const grandTotal = Math.round(totalAmount * 1.08 * 100) / 100;
    return { totalDelivered, totalReceived, totalDifference, totalAmount, vatAmount, grandTotal };
  }, [items]);

  function handleAddItem() {
    setItems((prev) => [...prev, emptyItem(nextKeyRef.current++)]);
  }

  function handleItemChange(key: number, patch: Partial<ReceiptItemState>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function handleRemoveItem(key: number) {
    setItems((prev) => prev.filter((item) => item.key !== key));
  }

  function handleCancel() {
    if (isDirty && !window.confirm("Dữ liệu chưa lưu sẽ bị mất. Bạn có chắc muốn rời trang?")) {
      return;
    }
    router.push("/receipts");
  }

  const hasEmptyProductRow = items.some((item) => !item.productId);
  const canSubmit =
    !!receiptDate && !!shift && !!supplierId && !!receiverName.trim() && items.length > 0 && !hasEmptyProductRow;

  function handleSubmit() {
    // useActionState's dispatch must run inside a transition when invoked
    // outside a <form action>, otherwise `isPending` won't track it.
    startTransition(() => {
      submitReceipt({
        receiptDate,
        shift: shift as "morning" | "afternoon",
        supplierId,
        receiverName,
        note,
        items: items.map((item) => ({
          productId: item.productId,
          unitPrice: item.unitPrice,
          deliveredQty: item.deliveredQty,
          receivedQty: item.receivedQty,
        })),
      });
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Thông tin phiếu nhập</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="receiptDate" className="text-sm font-medium">
              Ngày nhận *
            </label>
            <Input
              id="receiptDate"
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
              required
            />
          </div>
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
          </div>
          <div className="space-y-1.5">
            <label htmlFor="shift" className="text-sm font-medium">
              Ca *
            </label>
            <Select
              value={shift || null}
              onValueChange={(value) => setShift(String(value))}
              items={SHIFT_OPTIONS}
            >
              <SelectTrigger id="shift" className="w-full">
                <SelectValue placeholder="Chọn ca" />
              </SelectTrigger>
              <SelectContent>
                {SHIFT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="receiverName" className="text-sm font-medium">
              Người nhận *
            </label>
            <Input
              id="receiverName"
              value={receiverName}
              onChange={(e) => setReceiverName(e.target.value)}
              maxLength={255}
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
          <CardTitle>Danh sách hàng nhận</CardTitle>
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
                  <TableHead>SL giao</TableHead>
                  <TableHead>SL nhận</TableHead>
                  <TableHead>Chênh lệch</TableHead>
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
                    <ReceiptItemRow
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

      <Card>
        <CardHeader>
          <CardTitle>Tổng hợp</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <SummaryField label="Tổng SL giao" value={String(summary.totalDelivered)} />
          <SummaryField label="Tổng SL nhận" value={String(summary.totalReceived)} />
          <SummaryField
            label="Tổng chênh lệch"
            value={String(summary.totalDifference)}
            emphasis={summary.totalDifference < 0}
          />
          <SummaryField label="Tổng tiền" value={formatCurrency(summary.totalAmount)} />
          <SummaryField label="VAT 8%" value={formatCurrency(summary.vatAmount)} />
          <SummaryField
            label="Tổng sau VAT"
            value={formatCurrency(summary.grandTotal)}
            strong
          />
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
          {isPending ? "Đang lưu..." : "Lưu phiếu nhập"}
        </Button>
      </div>
    </div>
  );
}

function SummaryField({
  label,
  value,
  emphasis,
  strong,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p
        className={
          strong
            ? "text-base font-semibold"
            : emphasis
              ? "font-medium text-destructive"
              : "font-medium"
        }
      >
        {value}
      </p>
    </div>
  );
}
