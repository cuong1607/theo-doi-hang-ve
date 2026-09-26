"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export type ProductFormValues = {
  sku: string;
  name: string;
  unit: string;
  currentPrice: string;
  supplierId: string;
};

export type ProductFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  // React resets uncontrolled form fields after every action call, success or
  // error. Echo back what the user typed so a failed submit doesn't force
  // them to retype everything.
  values?: ProductFormValues;
};

export type ProductActionResult = {
  status: "success" | "error";
  message?: string;
};


const productSchema = z.object({
  sku: z.string().trim().min(1, "SKU là bắt buộc.").max(100, "SKU tối đa 100 ký tự."),
  name: z
    .string()
    .trim()
    .min(1, "Tên sản phẩm là bắt buộc.")
    .max(255, "Tên sản phẩm tối đa 255 ký tự."),
  unit: z.string().trim().min(1, "Đơn vị là bắt buộc.").max(50, "Đơn vị tối đa 50 ký tự."),
  currentPrice: z.coerce
    .number({ error: "Đơn giá phải là số." })
    .min(0, "Đơn giá phải lớn hơn hoặc bằng 0."),
  supplierId: z.string().trim().min(1, "Vui lòng chọn nhà cung cấp."),
});

function readSubmittedValues(formData: FormData): ProductFormValues {
  return {
    sku: (formData.get("sku") ?? "").toString(),
    name: (formData.get("name") ?? "").toString(),
    unit: (formData.get("unit") ?? "").toString(),
    currentPrice: (formData.get("currentPrice") ?? "").toString(),
    supplierId: (formData.get("supplierId") ?? "").toString(),
  };
}

function parseProductForm(formData: FormData) {
  return productSchema.safeParse({
    sku: formData.get("sku"),
    name: formData.get("name"),
    unit: formData.get("unit"),
    currentPrice: formData.get("currentPrice"),
    supplierId: formData.get("supplierId"),
  });
}

// Products may only be (re)assigned to an active supplier. An existing
// product keeps whichever supplier it already has even if that supplier was
// deactivated later — this only blocks *new* assignments to an inactive one.
async function validateSupplierAssignment(
  supabase: ReturnType<typeof createAdminClient>,
  supplierId: string,
  currentSupplierId: string | null
) {
  if (currentSupplierId && supplierId === currentSupplierId) {
    return null;
  }
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, is_active")
    .eq("id", supplierId)
    .maybeSingle();

  if (error || !data) {
    return "Nhà cung cấp không tồn tại.";
  }
  if (!data.is_active) {
    return "Nhà cung cấp này đã ngừng hoạt động. Vui lòng chọn nhà cung cấp khác.";
  }
  return null;
}

export async function createProduct(
  _prevState: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const authz = await authorizeAction("product:manage");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = parseProductForm(formData);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      values: readSubmittedValues(formData),
    };
  }

  const supabase = createAdminClient();

  const supplierError = await validateSupplierAssignment(supabase, parsed.data.supplierId, null);
  if (supplierError) {
    return {
      status: "error",
      message: supplierError,
      fieldErrors: { supplierId: [supplierError] },
      values: readSubmittedValues(formData),
    };
  }

  const { error } = await supabase.from("products").insert({
    sku: parsed.data.sku,
    name: parsed.data.name,
    unit: parsed.data.unit,
    current_price: parsed.data.currentPrice,
    supplier_id: parsed.data.supplierId,
  });

  if (error) {
    if (error.code === "23505") {
      return {
        status: "error",
        message: "SKU đã tồn tại. Vui lòng chọn SKU khác.",
        fieldErrors: { sku: ["SKU đã tồn tại."] },
        values: readSubmittedValues(formData),
      };
    }
    return {
      status: "error",
      message: "Không thể tạo sản phẩm. Vui lòng thử lại.",
      values: readSubmittedValues(formData),
    };
  }

  revalidatePath("/products");
  return { status: "success", message: "Đã thêm sản phẩm." };
}

export async function updateProduct(
  id: string,
  _prevState: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const authz = await authorizeAction("product:manage");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = parseProductForm(formData);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      values: readSubmittedValues(formData),
    };
  }

  const supabase = createAdminClient();

  const { data: current } = await supabase
    .from("products")
    .select("supplier_id")
    .eq("id", id)
    .maybeSingle();

  const supplierError = await validateSupplierAssignment(
    supabase,
    parsed.data.supplierId,
    current?.supplier_id ?? null
  );
  if (supplierError) {
    return {
      status: "error",
      message: supplierError,
      fieldErrors: { supplierId: [supplierError] },
      values: readSubmittedValues(formData),
    };
  }

  // Only products.current_price changes here — receipt_items.unit_price and
  // invoice_items.unit_price are captured at transaction time and must never
  // be rewritten retroactively when the catalog price changes later.
  const { error } = await supabase
    .from("products")
    .update({
      sku: parsed.data.sku,
      name: parsed.data.name,
      unit: parsed.data.unit,
      current_price: parsed.data.currentPrice,
      supplier_id: parsed.data.supplierId,
    })
    .eq("id", id);

  if (error) {
    if (error.code === "23505") {
      return {
        status: "error",
        message: "SKU đã tồn tại. Vui lòng chọn SKU khác.",
        fieldErrors: { sku: ["SKU đã tồn tại."] },
        values: readSubmittedValues(formData),
      };
    }
    return {
      status: "error",
      message: "Không thể cập nhật sản phẩm. Vui lòng thử lại.",
      values: readSubmittedValues(formData),
    };
  }

  revalidatePath("/products");
  return { status: "success", message: "Đã lưu thay đổi." };
}

export async function setProductActive(
  id: string,
  isActive: boolean
): Promise<ProductActionResult> {
  const authz = await authorizeAction("product:manage");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from("products").update({ is_active: isActive }).eq("id", id);

  if (error) {
    return { status: "error", message: "Không thể cập nhật trạng thái. Vui lòng thử lại." };
  }

  revalidatePath("/products");
  return { status: "success" };
}
