"use server";

// SHOPEE-7 payout actions. A reconciliation note / resolution is an audit
// record (admin, payout:reconcile) — it never changes a provider amount or
// the computed difference. Forced re-sync goes through the existing sync
// actions (channel:sync, the job records who asked).
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { RESOLUTION_INFO } from "@/lib/channels/core/payout-display";
import { isPayoutResolutionStatus, PayoutReconciliationError, resolvePayoutMismatch, type PayoutResolutionStatus } from "@/lib/channels/core/payouts";
import { createAdminClient } from "@/lib/supabase/admin";

export type PayoutNoteActionResult = { ok: boolean; message: string };

const input = z.object({
  payoutId: z.string().uuid(),
  note: z.string().trim().min(1, "Cần nội dung ghi chú.").max(1000),
  resolutionStatus: z.string().nullable(),
  resolutionReason: z.string().max(500).nullable(),
});

export async function addPayoutNoteAction(raw: { payoutId: string; note: string; resolutionStatus: PayoutResolutionStatus | null; resolutionReason: string | null }): Promise<PayoutNoteActionResult> {
  const authz = await authorizeAction("payout:reconcile");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ." };
  const status = parsed.data.resolutionStatus;
  if (status !== null && !isPayoutResolutionStatus(status)) return { ok: false, message: "Trạng thái xử lý không hợp lệ." };
  try {
    await resolvePayoutMismatch(createAdminClient(), {
      payoutId: parsed.data.payoutId,
      note: parsed.data.note,
      resolutionStatus: status,
      resolutionReason: parsed.data.resolutionReason,
      by: authz.auth.user.id,
    });
    revalidatePath("/shopee/payouts", "layout");
    return { ok: true, message: status ? `Đã lưu ghi chú — trạng thái: ${RESOLUTION_INFO[status].label}.` : "Đã lưu ghi chú." };
  } catch (err) {
    if (err instanceof PayoutReconciliationError) return { ok: false, message: err.message };
    console.error(JSON.stringify({ source: "payout-action", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return { ok: false, message: "Không lưu được ghi chú. Vui lòng thử lại." };
  }
}
