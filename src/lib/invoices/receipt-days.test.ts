// Run: node --test src/lib/invoices/receipt-days.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DAY_ALREADY_INVOICED_MESSAGE,
  fromReceiptsErrorMessage,
  isReceiptDayLockedError,
  normalizeReceiptDates,
} from "./receipt-days.ts";

test("normalizeReceiptDates: de-duplicates and sorts ascending (receipt_start_date = first)", () => {
  assert.deepEqual(
    normalizeReceiptDates(["2026-09-04", "2026-09-01", " 2026-09-03 ", "2026-09-01"]),
    ["2026-09-01", "2026-09-03", "2026-09-04"]
  );
});

test("normalizeReceiptDates: keeps gaps — 02/09 is never inferred between 01 and 03", () => {
  const dates = normalizeReceiptDates(["2026-09-01", "2026-09-03", "2026-09-04"]);
  assert.ok(dates);
  assert.equal(dates.includes("2026-09-02"), false);
  assert.equal(dates.length, 3);
});

test("normalizeReceiptDates: rejects malformed or impossible dates as a whole", () => {
  assert.equal(normalizeReceiptDates(["2026-09-01", "01/09/2026"]), null);
  assert.equal(normalizeReceiptDates(["2026-02-30"]), null);
  assert.equal(normalizeReceiptDates([""]), null);
});

test("normalizeReceiptDates: empty input stays empty (caller rejects it)", () => {
  assert.deepEqual(normalizeReceiptDates([]), []);
});

test("fromReceiptsErrorMessage: concurrency/duplicate-link never leaks the raw DB error", () => {
  assert.equal(
    fromReceiptsErrorMessage("HD001", 'duplicate key value violates unique constraint "invoice_receipt_days_supplier_id_receipt_date_key"'),
    DAY_ALREADY_INVOICED_MESSAGE
  );
  assert.equal(
    fromReceiptsErrorMessage("23505", "duplicate key value violates unique constraint"),
    "Không thể lưu hóa đơn. Vui lòng thử lại."
  );
});

test("fromReceiptsErrorMessage: user-facing SQL messages pass through for HD004/HD010", () => {
  assert.equal(fromReceiptsErrorMessage("HD004", "Ngày 02/09/2031 không có phiếu nhập"), "Ngày 02/09/2031 không có phiếu nhập");
  assert.equal(isReceiptDayLockedError("HD010"), true);
  assert.equal(isReceiptDayLockedError("23505"), false);
});
