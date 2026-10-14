"use server";

// SHOPEE-3/4 order screen actions. Order SYNC is no longer run from a request
// (SHOPEE-PERF-1): the screen enqueues a job via ../sync/actions.ts and the
// background worker calls Shopee. What remains here is database-only.
import { revalidatePath } from "next/cache";

import { authorizeAction } from "@/lib/auth/session";
import { CostEngine } from "@/lib/inventory-cost/engine";
import { createAdminClient } from "@/lib/supabase/admin";

export type OrderActionResult = { ok: true; message: string } | { ok: false; message: string };

/** Admin: compute COGS for every order still missing it. Existing snapshots are never overwritten. */
export async function backfillOrderCogsAction(): Promise<OrderActionResult> {
  const authz = await authorizeAction("cost:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const r = await new CostEngine({ db: createAdminClient() }).backfillOrderCogs({ onlyMissing: true });
  revalidatePath("/shopee", "layout");
  revalidatePath("/inventory", "layout");
  return {
    ok: r.failed === 0,
    message:
      `Đã xét ${r.ordersProcessed} đơn / ${r.scanned} dòng: tính mới ${r.calculated + r.calculatedNegative}` +
      (r.calculatedNegative ? ` (${r.calculatedNegative} làm tồn giá vốn âm)` : "") +
      `, đã có sẵn ${r.alreadyCalculated}, chưa ghép ${r.skippedUnmapped}, thiếu giá vốn ${r.skippedNoCost}, chưa đủ điều kiện ${r.skippedIneligible}, hoàn kho ${r.reversed}` +
      (r.failed ? `, lỗi ${r.failed}` : "") +
      ".",
  };
}
