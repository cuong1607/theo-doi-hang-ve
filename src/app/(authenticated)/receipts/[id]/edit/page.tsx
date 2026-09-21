import { Lock } from "lucide-react";
import { notFound } from "next/navigation";

import { canEditReceipts, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { ReceiptForm, type ExistingReceipt } from "@/components/receipts/receipt-form";

// Dynamic route param already forces per-request rendering, but this is
// explicit for the same reason as /receipts/new: the page reads live
// supplier/receipt data with no other dynamic API to trigger it implicitly.
export const dynamic = "force-dynamic";

type ReceiptRow = {
  id: string;
  receipt_date: string;
  shift: "morning" | "afternoon";
  supplier_id: string;
  receiver_name: string;
  note: string | null;
  receipt_items: {
    id: string;
    product_id: string;
    unit_price: number;
    delivered_qty: number;
    received_qty: number;
    products: { sku: string; name: string; unit: string } | null;
  }[];
};

async function getReceiptForEdit(id: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("receipts")
    .select(
      "id, receipt_date, shift, supplier_id, receiver_name, note, receipt_items(id, product_id, unit_price, delivered_qty, received_qty, products(sku, name, unit))"
    )
    .eq("id", id)
    .maybeSingle();
  return data as unknown as ReceiptRow | null;
}

// Active suppliers for the picker, plus the receipt's current supplier even
// if it has since been deactivated — otherwise the select would show no
// matching option for the receipt's existing value.
async function getSuppliersForEdit(currentSupplierId: string) {
  const supabase = createAdminClient();
  const { data: active } = await supabase
    .from("suppliers")
    .select("id, code, name")
    .eq("is_active", true)
    .order("code", { ascending: true });

  const list = active ?? [];
  if (list.some((s) => s.id === currentSupplierId)) {
    return list;
  }

  const { data: current } = await supabase
    .from("suppliers")
    .select("id, code, name")
    .eq("id", currentSupplierId)
    .maybeSingle();

  return current ? [...list, current].sort((a, b) => a.code.localeCompare(b.code)) : list;
}

export default async function EditReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const receiptRow = await getReceiptForEdit(id);
  if (!receiptRow) {
    notFound();
  }

  const role = getCurrentRole();
  const canEdit = canEditReceipts(role);

  if (!canEdit) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Sửa phiếu nhập</h2>
          <p className="text-muted-foreground">{receiptRow.id}</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Lock className="size-8 text-muted-foreground" />
            <p className="font-medium">Bạn chỉ có quyền xem.</p>
            <p className="text-sm text-muted-foreground">
              Tài khoản của bạn không có quyền sửa phiếu nhập hàng.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const suppliers = await getSuppliersForEdit(receiptRow.supplier_id);

  const receipt: ExistingReceipt = {
    id: receiptRow.id,
    receiptDate: receiptRow.receipt_date,
    supplierId: receiptRow.supplier_id,
    shift: receiptRow.shift,
    receiverName: receiptRow.receiver_name,
    note: receiptRow.note ?? "",
    items: receiptRow.receipt_items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      sku: i.products?.sku ?? "",
      name: i.products?.name ?? "",
      unit: i.products?.unit ?? "",
      unitPrice: String(i.unit_price),
      deliveredQty: String(i.delivered_qty),
      receivedQty: String(i.received_qty),
    })),
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Sửa phiếu nhập</h2>
        <p className="text-muted-foreground">Cập nhật thông tin phiếu nhập hàng.</p>
      </div>

      <ReceiptForm suppliers={suppliers} receipt={receipt} />
    </div>
  );
}
