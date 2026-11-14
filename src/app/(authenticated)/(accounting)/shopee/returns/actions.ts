"use server";

// SHOPEE-6 return actions. Disposition changes move stock and COGS → admin
// only (return:disposition); they go through the central service (one DB
// transaction: audit + inventory effect + financial recalculation).
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { ReturnDispositionError, setReturnDisposition } from "@/lib/channels/core/returns";
import { DISPOSITION_INFO, isReturnDisposition, type ReturnDisposition } from "@/lib/channels/shopee/return-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency } from "@/lib/ui/format";

export type DispositionActionResult = { ok: boolean; message: string };

const uuid = z.string().uuid();

export async function setReturnDispositionAction(returnItemId: string, disposition: ReturnDisposition, reason: string): Promise<DispositionActionResult> {
  const authz = await authorizeAction("return:disposition");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(returnItemId).success || !isReturnDisposition(disposition)) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const r = await setReturnDisposition(createAdminClient(), { returnItemId, disposition, reason: reason.slice(0, 500), changedBy: authz.auth.user.id });
    revalidatePath("/shopee/returns", "layout");
    revalidatePath("/shopee/orders", "layout");
    if (!r.changed) return { ok: true, message: "Không có thay đổi." };
    const label = DISPOSITION_INFO[r.disposition].label;
    if (r.inventoryEffect === "restocked") return { ok: true, message: `Đã chuyển sang "${label}" — nhập lại kho, hoàn giá vốn ${formatCurrency(r.cogsDelta)}.` };
    if (r.inventoryEffect === "restock_reversed") return { ok: true, message: `Đã chuyển sang "${label}" — huỷ lần nhập lại kho trước đó (${formatCurrency(r.cogsDelta.replace("-", ""))}).` };
    return { ok: true, message: `Đã chuyển sang "${label}" — không thay đổi tồn kho.` };
  } catch (err) {
    if (err instanceof ReturnDispositionError) return { ok: false, message: err.message };
    console.error(JSON.stringify({ source: "return-action", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return { ok: false, message: "Không cập nhật được cách xử lý. Vui lòng thử lại." };
  }
}
