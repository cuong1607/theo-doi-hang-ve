// Run: node --env-file=.env.local --test src/lib/notifications/daily-receipt-summary.test.ts
//
// Only the pure, DB-free functions are covered here (formatDailyReceiptSummaryMessage,
// getTodayDateVN) — buildDailyReceiptSummary/sendDailyReceiptSummary touch the real
// Supabase cloud DB (via createAdminClient/sendNotification) and are verified with a
// live throwaway script instead, same convention as the rest of src/lib/notifications.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDailyReceiptSummaryMessage,
  getTodayDateVN,
  type DailyReceiptSummary,
} from "./daily-receipt-summary-message.ts";

function summary(overrides: Partial<DailyReceiptSummary>): DailyReceiptSummary {
  return {
    date: "2026-09-25",
    receiptCount: 0,
    totalDelivered: 0,
    totalReceived: 0,
    totalDifference: 0,
    totalAmount: 0,
    suppliers: [],
    ...overrides,
  };
}

test("getTodayDateVN: returns YYYY-MM-DD shaped string", () => {
  assert.match(getTodayDateVN(), /^\d{4}-\d{2}-\d{2}$/);
});

test("formatDailyReceiptSummaryMessage: multiple suppliers, with per-supplier and TỔNG Tổng tiền/Tổng tiền sau VAT (8%)", () => {
  const s = summary({
    date: "2026-09-25",
    receiptCount: 6,
    totalDelivered: 430,
    totalReceived: 428,
    totalDifference: -2,
    totalAmount: 25_600_000,
    suppliers: [
      {
        supplierId: "s1",
        supplierCode: "NCC01",
        supplierName: "Bích Đại",
        receiptCount: 3,
        totalDelivered: 250,
        totalReceived: 248,
        totalDifference: -2,
        totalAmount: 15_000_000,
      },
      {
        supplierId: "s2",
        supplierCode: "NCC02",
        supplierName: "Minh Hoa",
        receiptCount: 3,
        totalDelivered: 180,
        totalReceived: 180,
        totalDifference: 0,
        totalAmount: 10_600_000,
      },
    ],
  });

  const message = formatDailyReceiptSummaryMessage(s);

  assert.equal(
    message,
    [
      "HÀNG VỀ 25/09/2026",
      "",
      "Bích Đại",
      "- SL giao: 250",
      "- SL nhận: 248",
      "- Chênh lệch: -2",
      "- Tổng tiền: 15.000.000 đ",
      "- Tổng tiền sau VAT: 16.200.000 đ",
      "",
      "Minh Hoa",
      "- SL giao: 180",
      "- SL nhận: 180",
      "- Chênh lệch: 0",
      "- Tổng tiền: 10.600.000 đ",
      "- Tổng tiền sau VAT: 11.448.000 đ",
      "",
      "TỔNG",
      "- Số phiếu: 6",
      "- SL giao: 430",
      "- SL nhận: 428",
      "- Chênh lệch: -2",
      "- Tổng tiền: 25.600.000 đ",
      "- Tổng tiền sau VAT: 27.648.000 đ",
    ].join("\n")
  );
});

test("formatDailyReceiptSummaryMessage: single supplier, zero difference", () => {
  const s = summary({
    receiptCount: 1,
    totalDelivered: 100,
    totalReceived: 100,
    totalDifference: 0,
    totalAmount: 5_000_000,
    suppliers: [
      {
        supplierId: "s1",
        supplierCode: "NCC01",
        supplierName: "Bích Đại",
        receiptCount: 1,
        totalDelivered: 100,
        totalReceived: 100,
        totalDifference: 0,
        totalAmount: 5_000_000,
      },
    ],
  });

  const message = formatDailyReceiptSummaryMessage(s);
  assert.ok(message.includes("- Chênh lệch: 0"));
  assert.ok(!message.includes("+0"));
});

test("formatDailyReceiptSummaryMessage: negative difference keeps the minus sign", () => {
  const s = summary({
    receiptCount: 1,
    totalDelivered: 50,
    totalReceived: 45,
    totalDifference: -5,
    totalAmount: 1_000_000,
    suppliers: [
      {
        supplierId: "s1",
        supplierCode: "NCC01",
        supplierName: "NCC A",
        receiptCount: 1,
        totalDelivered: 50,
        totalReceived: 45,
        totalDifference: -5,
        totalAmount: 1_000_000,
      },
    ],
  });

  assert.ok(formatDailyReceiptSummaryMessage(s).includes("- Chênh lệch: -5"));
});

test("formatDailyReceiptSummaryMessage: VND amount formatting uses thousand separators and 'đ' suffix", () => {
  const s = summary({ totalAmount: 1_234_567 });
  assert.ok(formatDailyReceiptSummaryMessage(s).includes("- Tổng tiền: 1.234.567 đ"));
});

test("formatDailyReceiptSummaryMessage: Tổng tiền sau VAT applies the 8% rate and rounds to 2 decimals", () => {
  // 1,234,567 * 1.08 = 1,333,332.36 exactly.
  const s = summary({ totalAmount: 1_234_567 });
  assert.ok(formatDailyReceiptSummaryMessage(s).includes("- Tổng tiền sau VAT: 1.333.332,36 đ"));
});

test("formatDailyReceiptSummaryMessage: zero-supplier summary still renders a TỔNG block", () => {
  const message = formatDailyReceiptSummaryMessage(summary({}));
  assert.ok(message.includes("TỔNG"));
  assert.ok(message.includes("- Số phiếu: 0"));
  assert.ok(message.includes("- Tổng tiền: 0 đ"));
  assert.ok(message.includes("- Tổng tiền sau VAT: 0 đ"));
});
