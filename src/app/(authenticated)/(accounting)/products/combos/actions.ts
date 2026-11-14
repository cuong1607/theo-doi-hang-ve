"use server";

// PRODUCT-COMBO-1 combo actions (product:manage). BOM rules live in the DB
// (save_combo_product + guards); src/lib/products/combo.ts validates early
// and maps errors. Reads for pickers authorize with product:view.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { searchInternalProducts, type InternalProductOption } from "@/lib/channels/core/product-queries";
import { ComboError, createComboProduct, deleteComboProduct, updateComboProduct, type ComboInput } from "@/lib/products/combo";
import { createAdminClient } from "@/lib/supabase/admin";

export type ComboActionResult = { ok: true; id: string; message: string } | { ok: false; message: string; field?: "sku" | "name" | "components" | null };

const uuid = z.string().uuid();

export async function saveComboAction(id: string | null, input: ComboInput): Promise<ComboActionResult> {
  const authz = await authorizeAction("product:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (id !== null && !uuid.safeParse(id).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const db = createAdminClient();
    const savedId = id ? await updateComboProduct(db, id, input) : await createComboProduct(db, input);
    revalidatePath("/products");
    revalidatePath(`/products/combos/${savedId}`);
    return { ok: true, id: savedId, message: id ? "Đã lưu combo. Thành phần mới áp dụng cho các đơn được tính giá vốn từ bây giờ." : "Đã tạo combo." };
  } catch (err) {
    if (err instanceof ComboError) return { ok: false, message: err.message, field: err.field };
    console.error(JSON.stringify({ source: "combo-action", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return { ok: false, message: "Không lưu được combo. Vui lòng thử lại." };
  }
}

export async function setComboActiveAction(id: string, isActive: boolean): Promise<{ ok: boolean; message: string }> {
  const authz = await authorizeAction("product:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(id).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const { error } = await createAdminClient().from("products").update({ is_active: isActive }).eq("id", id).eq("product_type", "combo");
  if (error) return { ok: false, message: "Không cập nhật được trạng thái." };
  revalidatePath("/products");
  revalidatePath(`/products/combos/${id}`);
  return { ok: true, message: isActive ? "Đã kích hoạt combo." : "Đã ngừng combo." };
}

export async function deleteComboAction(id: string): Promise<{ ok: boolean; message: string }> {
  const authz = await authorizeAction("product:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(id).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const result = await deleteComboProduct(createAdminClient(), id);
    if (result === "in_use") return { ok: false, message: "Combo đã có trong đơn hàng — không xóa được, hãy chuyển sang Ngừng hoạt động." };
    revalidatePath("/products");
    return { ok: true, message: "Đã xóa combo." };
  } catch {
    return { ok: false, message: "Không xóa được combo." };
  }
}

/** Component picker: ATOMIC, active products only (no nested combos). */
export async function searchComboComponentsAction(term: string): Promise<InternalProductOption[]> {
  const authz = await authorizeAction("product:view");
  if (!authz.ok) return [];
  return searchInternalProducts(term, 20, { onlyType: "atomic", activeOnly: true });
}
