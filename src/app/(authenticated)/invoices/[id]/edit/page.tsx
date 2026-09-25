import { Lock } from "lucide-react";
import { notFound } from "next/navigation";

import { canEditInvoices, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { InvoiceForm, type ExistingInvoice, type InvoiceSupplierOption } from "@/components/invoices/invoice-form";

// Dynamic route param already forces per-request rendering, but this is
// explicit for the same reason as /invoices/new: the page reads live
// supplier/invoice data with no other dynamic API to trigger it implicitly.
export const dynamic = "force-dynamic";

type InvoiceRow = {
  id: string;
  invoice_no: string;
  invoice_date: string;
  supplier_id: string;
  note: string | null;
  discount_type: "percent" | "fixed_amount" | null;
  discount_value: number | null;
  vat_rate: number;
  invoice_items: {
    id: string;
    product_id: string;
    unit_price: number;
    quantity: number;
    products: { sku: string; name: string; unit: string } | null;
  }[];
};

async function getInvoiceForEdit(id: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("invoices")
    .select(
      "id, invoice_no, invoice_date, supplier_id, note, discount_type, discount_value, vat_rate, invoice_items(id, product_id, unit_price, quantity, products(sku, name, unit))"
    )
    .eq("id", id)
    .maybeSingle();
  return data as unknown as InvoiceRow | null;
}

// Active suppliers for the picker, plus the invoice's current supplier even
// if it has since been deactivated — otherwise the select would show no
// matching option for the invoice's existing value.
async function getSuppliersForEdit(currentSupplierId: string): Promise<InvoiceSupplierOption[]> {
  const supabase = createAdminClient();
  const { data: active } = await supabase
    .from("suppliers")
    .select("id, code, name, supplier_type")
    .eq("is_active", true)
    .order("code", { ascending: true });

  const list = (active ?? []) as InvoiceSupplierOption[];
  if (list.some((s) => s.id === currentSupplierId)) {
    return list;
  }

  const { data: current } = await supabase
    .from("suppliers")
    .select("id, code, name, supplier_type")
    .eq("id", currentSupplierId)
    .maybeSingle();

  return current
    ? [...list, current as InvoiceSupplierOption].sort((a, b) => a.code.localeCompare(b.code))
    : list;
}

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const invoiceRow = await getInvoiceForEdit(id);
  if (!invoiceRow) {
    notFound();
  }

  const role = getCurrentRole();
  const canEdit = canEditInvoices(role);

  if (!canEdit) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Sửa hóa đơn</h2>
          <p className="text-muted-foreground">{invoiceRow.invoice_no}</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Lock className="size-8 text-muted-foreground" />
            <p className="font-medium">Bạn chỉ có quyền xem.</p>
            <p className="text-sm text-muted-foreground">
              Tài khoản của bạn không có quyền sửa hóa đơn.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const suppliers = await getSuppliersForEdit(invoiceRow.supplier_id);

  const invoice: ExistingInvoice = {
    id: invoiceRow.id,
    supplierId: invoiceRow.supplier_id,
    invoiceNo: invoiceRow.invoice_no,
    invoiceDate: invoiceRow.invoice_date,
    note: invoiceRow.note ?? "",
    discountType: invoiceRow.discount_type,
    discountValue: invoiceRow.discount_value,
    vatRate: invoiceRow.vat_rate,
    items: invoiceRow.invoice_items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      sku: i.products?.sku ?? "",
      name: i.products?.name ?? "",
      unit: i.products?.unit ?? "",
      unitPrice: String(i.unit_price),
      quantity: String(i.quantity),
    })),
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Sửa hóa đơn</h2>
        <p className="text-muted-foreground">Cập nhật thông tin hóa đơn nhà cung cấp.</p>
      </div>

      <InvoiceForm suppliers={suppliers} invoice={invoice} />
    </div>
  );
}
