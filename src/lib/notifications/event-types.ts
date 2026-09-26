// Known event types so far (ZL2's manual test-all, ZL3/ZL5's daily
// summaries, ZL4's low-stock alert) — hardcoded rather than a DISTINCT
// query, same convention as other fixed dropdowns in this codebase (e.g.
// SHIFT_OPTIONS). Add a new value here whenever a new business event ships.
//
// Kept in its own dependency-free module so client components (the log
// filters) can import it without pulling server-only code (logs.ts uses
// the service-role client) into the browser bundle.
export const NOTIFICATION_EVENT_TYPES = [
  "TEST_ALL_RECIPIENTS",
  "TEST_SINGLE_RECIPIENT",
  "DAILY_RECEIPT_SUMMARY",
  "DAILY_PAYMENT_SUMMARY",
  "LOW_STOCK_ALERT",
] as const;
