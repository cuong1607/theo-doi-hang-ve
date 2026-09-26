// PHASE ZL5 — POST /api/notifications/daily-payment-summary: admin-only
// manual trigger ("Gửi báo cáo thanh toán hôm nay"), always uses "today" in
// Asia/Ho_Chi_Minh, mirrors /api/notifications/daily-receipt-summary (ZL3).
import { NextResponse } from "next/server";

import { authorizeRoute } from "@/lib/auth/session";
import { getTodayDateVN } from "@/lib/notifications/daily-payment-summary";
import { sendDailyPaymentSummary } from "@/lib/notifications/send-daily-payment-summary";

export const runtime = "nodejs";

export async function POST() {
  const authz = await authorizeRoute("notification:manage");
  if (!authz.ok) return authz.response;

  const date = getTodayDateVN();

  try {
    const outcome = await sendDailyPaymentSummary(date);
    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    return NextResponse.json(
      { success: false, errorMessage: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
