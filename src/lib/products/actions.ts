"use server";

import { authorizeAction } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export type SupplierProduct = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  current_price: number;
};

// Called directly from client components (receipt-form, invoice-form), so
// this must live in a "use server" module — Next.js then proxies the call
// over the network as a Server Action instead of bundling the real function
// (and its createAdminClient/service-role-key usage) into client JS.
export async function getSupplierProducts(
  supplierId: string
): Promise<{ status: "success"; data: SupplierProduct[] } | { status: "error"; message: string }> {
  // A Server Action is a public POST endpoint — authorize even reads.
  const authz = await authorizeAction("product:view");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }
  if (!supplierId) {
    return { status: "success", data: [] };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("products")
    .select("id, sku, name, unit, current_price")
    .eq("supplier_id", supplierId)
    .eq("is_active", true)
    .order("sku", { ascending: true });

  if (error) {
    return { status: "error", message: "Không thể tải danh sách sản phẩm." };
  }

  return { status: "success", data: data as SupplierProduct[] };
}
