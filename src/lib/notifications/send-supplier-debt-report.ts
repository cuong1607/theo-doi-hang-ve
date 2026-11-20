// SUPPLIER_DEBT_REPORT business event, built on sendNotification() (never
// calls Zalo directly). One notification per message part so a long report
// splits cleanly; each part has its own dedupe key, so a cron retry the same
// day never double-sends a part that already went out.
import "server-only";

import { buildSupplierDebtReport } from "./supplier-debt-report";
import { formatSupplierDebtReportMessages } from "./supplier-debt-report-message";
import { sendNotification, type SendNotificationResult } from "./service";

export type SendSupplierDebtReportResult =
  | { skipped: true; reason: "NO_DEBT"; date: string }
  | { skipped: false; date: string; parts: number; results: SendNotificationResult[] };

// No open debt -> nothing is sent (same convention as the other daily
// summaries: no invented "hôm nay không có ..." message).
export async function sendSupplierDebtReport(date: string): Promise<SendSupplierDebtReportResult> {
  const report = await buildSupplierDebtReport(date);
  if (report.suppliers.length === 0) {
    return { skipped: true, reason: "NO_DEBT", date };
  }

  const messages = formatSupplierDebtReportMessages(report);
  const results: SendNotificationResult[] = [];
  for (let i = 0; i < messages.length; i++) {
    results.push(
      await sendNotification({
        eventType: "SUPPLIER_DEBT_REPORT",
        message: messages[i],
        entityType: "supplier_debt_report",
        entityId: date,
        dedupeKey: `SUPPLIER_DEBT_REPORT:${date}:${i + 1}/${messages.length}`,
      })
    );
  }
  return { skipped: false, date, parts: messages.length, results };
}
