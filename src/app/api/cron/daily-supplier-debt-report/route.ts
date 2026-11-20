// GET /api/cron/daily-supplier-debt-report: Vercel Cron entry point for the
// SUPPLIER_DEBT_REPORT event (Zalo "công nợ NCC" report). Same shape as the
// other daily crons; all logic lives in sendSupplierDebtReport().
import { NextResponse } from "next/server";

import { isAuthorizedCronSecret } from "@/lib/cron/auth";
import { getTodayDateVN } from "@/lib/notifications/date-vn";
import { sendSupplierDebtReport } from "@/lib/notifications/send-supplier-debt-report";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isAuthorizedCronSecret(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = getTodayDateVN();
  console.log(`[cron:daily-supplier-debt-report] started date=${date}`);

  try {
    const outcome = await sendSupplierDebtReport(date);

    if (outcome.skipped) {
      console.log(`[cron:daily-supplier-debt-report] completed date=${date} skipped reason=${outcome.reason}`);
    } else {
      const sent = outcome.results.reduce((n, r) => n + r.sentCount, 0);
      const failed = outcome.results.reduce((n, r) => n + r.failedCount, 0);
      const skipped = outcome.results.reduce((n, r) => n + r.skippedCount, 0);
      console.log(
        `[cron:daily-supplier-debt-report] completed date=${date} parts=${outcome.parts} sent=${sent} failed=${failed} skipped=${skipped}`
      );
    }

    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    console.error(`[cron:daily-supplier-debt-report] FAILED date=${date}:`, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, errorMessage: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
