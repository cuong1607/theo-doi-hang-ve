// Run: node --env-file=.env.local --test src/lib/notifications/daily-payment-summary.test.ts
//
// Only the pure, DB-free functions are covered here (formatDailyPaymentSummaryMessage).
// buildDailyPaymentSummary/sendDailyPaymentSummary touch the real Supabase cloud DB
// and are verified with a live throwaway script instead, same convention as ZL3/ZL4.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDailyPaymentSummaryMessage,
  type DailyPaymentSummary,
} from "./daily-payment-summary-message.ts";

function summary(overrides: Partial<DailyPaymentSummary>): DailyPaymentSummary {
  return {
    date: "2026-09-25",
    paymentCount: 0,
    invoiceCount: 0,
    totalPaid: 0,
    suppliers: [],
    ...overrides,
  };
}

test("formatDailyPaymentSummaryMessage: multiple suppliers, multiple invoices — spec's exact example", () => {
  const s = summary({
    date: "2026-09-25",
    paymentCount: 2,
    invoiceCount: 3,
    totalPaid: 45_500_000,
    suppliers: [
      {
        supplierId: "s1",
        supplierCode: "NCC03",
        supplierName: "Tuấn Hậu",
        invoices: [
          { invoiceId: "i1", invoiceNo: "001", amountPaid: 10_000_000 },
          { invoiceId: "i2", invoiceNo: "002", amountPaid: 20_000_000 },
        ],
        supplierTotal: 30_000_000,
      },
      {
        supplierId: "s2",
        supplierCode: "NCC04",
        supplierName: "Minh Hoa",
        invoices: [{ invoiceId: "i3", invoiceNo: "MH-125", amountPaid: 15_500_000 }],
        supplierTotal: 15_500_000,
      },
    ],
  });

  const message = formatDailyPaymentSummaryMessage(s);

  assert.equal(
    message,
    [
      "THANH TOÁN 25/09/2026",
      "",
      "Tuấn Hậu",
      "- HĐ 001: 10.000.000 đ",
      "- HĐ 002: 20.000.000 đ",
      "Tổng NCC: 30.000.000 đ",
      "",
      "Minh Hoa",
      "- HĐ MH-125: 15.500.000 đ",
      "Tổng NCC: 15.500.000 đ",
      "",
      "TỔNG THANH TOÁN:",
      "45.500.000 đ",
    ].join("\n")
  );
});

test("formatDailyPaymentSummaryMessage: one payment, one invoice", () => {
  const s = summary({
    paymentCount: 1,
    invoiceCount: 1,
    totalPaid: 5_000_000,
    suppliers: [
      {
        supplierId: "s1",
        supplierCode: "NCC01",
        supplierName: "Bích Đại",
        invoices: [{ invoiceId: "i1", invoiceNo: "BD-001", amountPaid: 5_000_000 }],
        supplierTotal: 5_000_000,
      },
    ],
  });

  assert.equal(
    formatDailyPaymentSummaryMessage(s),
    ["THANH TOÁN 25/09/2026", "", "Bích Đại", "- HĐ BD-001: 5.000.000 đ", "Tổng NCC: 5.000.000 đ", "", "TỔNG THANH TOÁN:", "5.000.000 đ"].join(
      "\n"
    )
  );
});

test("formatDailyPaymentSummaryMessage: one payment spanning multiple invoices for the same supplier", () => {
  const s = summary({
    paymentCount: 1,
    invoiceCount: 2,
    totalPaid: 8_000_000,
    suppliers: [
      {
        supplierId: "s1",
        supplierCode: "NCC01",
        supplierName: "Bích Đại",
        invoices: [
          { invoiceId: "i1", invoiceNo: "BD-001", amountPaid: 3_000_000 },
          { invoiceId: "i2", invoiceNo: "BD-002", amountPaid: 5_000_000 },
        ],
        supplierTotal: 8_000_000,
      },
    ],
  });

  const message = formatDailyPaymentSummaryMessage(s);
  assert.ok(message.includes("- HĐ BD-001: 3.000.000 đ"));
  assert.ok(message.includes("- HĐ BD-002: 5.000.000 đ"));
  assert.ok(message.includes("Tổng NCC: 8.000.000 đ"));
});

test("formatDailyPaymentSummaryMessage: VND formatting uses thousand separators and 'đ' suffix", () => {
  const s = summary({
    totalPaid: 1_234_567,
    suppliers: [
      {
        supplierId: "s1",
        supplierCode: "NCC01",
        supplierName: "Bích Đại",
        invoices: [{ invoiceId: "i1", invoiceNo: "BD-001", amountPaid: 1_234_567 }],
        supplierTotal: 1_234_567,
      },
    ],
  });

  const message = formatDailyPaymentSummaryMessage(s);
  assert.ok(message.includes("- HĐ BD-001: 1.234.567 đ"));
  assert.ok(message.includes("TỔNG THANH TOÁN:\n1.234.567 đ"));
});

test("formatDailyPaymentSummaryMessage: no suppliers still renders THANH TOÁN header and TỔNG THANH TOÁN", () => {
  const message = formatDailyPaymentSummaryMessage(summary({}));
  assert.ok(message.startsWith("THANH TOÁN 25/09/2026"));
  assert.ok(message.endsWith("TỔNG THANH TOÁN:\n0 đ"));
});
