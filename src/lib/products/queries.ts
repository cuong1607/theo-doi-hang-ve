import { createAdminClient } from "@/lib/supabase/admin";

// Server-only helper — only ever called from within "use server" action
// files (receipts/actions.ts, invoices/actions.ts), never imported directly
// by a client component. Unlike getSupplierProducts (see ./actions.ts), this
// takes a live Supabase client as an argument, which isn't a serializable
// value a Server Action could accept from the client anyway.
//
// Shared by receipts and invoices: the chosen supplier must be active, and
// every item's product must exist, belong to that supplier, and be active.
// This is the server-side re-validation required even though the UI already
// limits the pickers — a request could otherwise submit a stale/tampered
// selection (e.g. a supplier changed to inactive between page load and
// submit).
export async function validateSupplierAndItems(
  supabase: ReturnType<typeof createAdminClient>,
  supplierId: string,
  items: { productId: string }[]
): Promise<string | null> {
  const { data: supplier, error: supplierError } = await supabase
    .from("suppliers")
    .select("id, is_active")
    .eq("id", supplierId)
    .maybeSingle();

  if (supplierError || !supplier) {
    return "Nhà cung cấp không tồn tại.";
  }
  if (!supplier.is_active) {
    return "Nhà cung cấp này đã ngừng hoạt động.";
  }

  const productIds = items.map((i) => i.productId);
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, supplier_id, is_active")
    .in("id", productIds);

  if (productsError || !products || products.length !== productIds.length) {
    return "Có sản phẩm không tồn tại trong hệ thống.";
  }
  const invalidProduct = products.find((p) => p.supplier_id !== supplierId || !p.is_active);
  if (invalidProduct) {
    return "Có sản phẩm không thuộc nhà cung cấp đã chọn hoặc đã ngừng kinh doanh.";
  }
  return null;
}
