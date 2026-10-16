"use server";

// SHOPEE-4 admin cost actions. Rebuild recomputes the cost ledger/state from
// receipts + posted sales; it NEVER rewrites order COGS snapshots. Historical
// COGS changes only through restateHistoricalCogsAction (explicit, audited).
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

const restateSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(1000),
  reason: z.string().trim().min(5, "Lý do cần ít nhất 5 ký tự.").max(500),
});

/**
 * Explicit historical COGS restatement (admin). The SQL function re-checks
 * every line (still differs, new cost known); each restated line is audited
 * with old / new values, version, reason and user.
 */
export async function restateHistoricalCogsAction(input: { itemIds: string[]; reason: string }): Promise<CostActionResult> {
  const authz = await authorizeAction("cost:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = restateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ." };
  try {
    const r = await new CostEngine({ db: createAdminClient() }).restateOrderCogs(parsed.data.itemIds, parsed.data.reason, authz.auth.user.id);
    revalidatePath("/inventory", "layout");
    revalidatePath("/shopee/orders", "layout");
    return {
      ok: true,
      message: `Đã điều chỉnh COGS ${r.restated} dòng (${r.orders} đơn)${r.skipped ? `, bỏ qua ${r.skipped} dòng không còn chênh lệch` : ""}.`,
    };
  } catch {
    return { ok: false, message: "Không điều chỉnh được COGS." };
  }
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
