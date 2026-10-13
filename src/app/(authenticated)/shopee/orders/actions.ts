"use server";

// SHOPEE-3 order sync actions (admin only). Same data-source rules as product
// sync: fixture provider ↔ fixture shop only, no live→fixture fallback.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { ShopeeConfigError } from "@/lib/channels/shopee/config";
import { OrderSyncRefusedError, type OrderSyncResult } from "@/lib/channels/shopee/order-sync";
import { getShopeeOrderSync } from "@/lib/channels/shopee/server";
import { CostEngine } from "@/lib/inventory-cost/engine";
import { createAdminClient } from "@/lib/supabase/admin";

export type OrderActionResult = { ok: true; message: string } | { ok: false; message: string };

const BACKFILL_DAYS = 30;

function describe(r: OrderSyncResult): string {
  return (
    `${r.ordersDiscovered} đơn (${r.windowsProcessed} cửa sổ, ${r.pagesFetched} trang): mới ${r.counts.created}, cập nhật ${r.counts.updated}` +
    ` · mapping đủ ${r.mapping.complete} / thiếu ${r.mapping.partial} / chưa ghép ${r.mapping.unmapped}` +
    (r.linesUnresolved ? ` · ${r.linesUnresolved} dòng chưa có trong danh mục Shopee` : "")
  );
}

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

export async function syncShopeeOrdersAction(shopId: string, mode: "incremental" | "backfill"): Promise<OrderActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!z.string().uuid().safeParse(shopId).success || (mode !== "incremental" && mode !== "backfill")) return { ok: false, message: "Dữ liệu không hợp lệ." };

  let sync;
  try {
    ({ sync } = getShopeeOrderSync());
  } catch (err) {
    return { ok: false, message: err instanceof ShopeeConfigError ? `Chưa kết nối API Shopee: ${err.message}` : (err as Error).message };
  }
  try {
    const now = new Date();
    const result =
      mode === "backfill"
        ? await sync.backfill({ shopId, from: new Date(now.getTime() - BACKFILL_DAYS * 86_400_000), to: now })
        : await sync.sync(shopId, { mode: "incremental" });
    revalidatePath("/shopee", "layout");
    if (result.status === "success") return { ok: true, message: `Đồng bộ đơn xong: ${describe(result)}.` };
    if (result.status === "partial") return { ok: true, message: `Đồng bộ một phần (${result.counts.failed} lỗi): ${describe(result)}. ${result.errorMessage ?? ""}`.trim() };
    return { ok: false, message: `Đồng bộ đơn thất bại [${result.errorCode}]: ${result.errorMessage ?? ""}` };
  } catch (err) {
    if (err instanceof OrderSyncRefusedError) return { ok: false, message: err.message };
    return { ok: false, message: "Đồng bộ đơn thất bại do lỗi hệ thống." };
  }
}
