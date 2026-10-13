"use server";

// SHOPEE-4 admin cost actions. Rebuild recomputes the cost ledger/state from
// receipts + posted sales; it NEVER rewrites order COGS snapshots.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { CostEngine } from "@/lib/inventory-cost/engine";
import { createAdminClient } from "@/lib/supabase/admin";

export type CostActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function rebuildProductCostAction(productId: string): Promise<CostActionResult> {
  const authz = await authorizeAction("cost:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!z.string().uuid().safeParse(productId).success) return { ok: false, message: "Sản phẩm không hợp lệ." };
  try {
    await new CostEngine({ db: createAdminClient() }).rebuildProduct(productId, { reason: "manual_rebuild", triggeredBy: authz.auth.user.id });
  } catch {
    return { ok: false, message: "Không tính lại được giá vốn." };
  }
  revalidatePath("/inventory", "layout");
  return { ok: true, message: "Đã tính lại giá vốn (đơn hàng cũ giữ nguyên COGS đã chốt)." };
}

export async function rebuildAllCostsAction(): Promise<CostActionResult> {
  const authz = await authorizeAction("cost:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  try {
    const n = await new CostEngine({ db: createAdminClient() }).rebuildAll(authz.auth.user.id);
    revalidatePath("/inventory", "layout");
    return { ok: true, message: `Đã tính lại giá vốn cho ${n} sản phẩm (đơn hàng cũ giữ nguyên COGS đã chốt).` };
  } catch {
    return { ok: false, message: "Không tính lại được giá vốn." };
  }
}
