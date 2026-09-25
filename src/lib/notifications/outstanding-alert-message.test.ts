// Run: node --env-file=.env.local --test src/lib/notifications/outstanding-alert-message.test.ts
//
// Only the pure formatOutstandingAlertMessage is covered here.
// evaluateOutstandingNotifications() touches the real DB (v_outstanding,
// notification_event_states, sendNotification) and is verified with a live
// throwaway script instead, same convention as daily-receipt-summary.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOutstandingAlertMessage, type OutstandingAlertItem } from "./outstanding-alert-message.ts";

function item(overrides: Partial<OutstandingAlertItem>): OutstandingAlertItem {
  return {
    invoiceItemId: "ii-1",
    supplierId: "s1",
    supplierName: "Bích Đại",
    sku: "GA160",
    productName: "Ga chống thấm 1m6",
    invoiceNo: "BD-00125",
    invoiceQty: 100,
    receivedQty: 88,
    remainingQty: 12,
    alertState: "near_empty",
    ...overrides,
  };
}

test("formatOutstandingAlertMessage: single SKU, near_empty — spec's exact example", () => {
  const message = formatOutstandingAlertMessage("Bích Đại", [item({})]);
  assert.equal(
    message,
    [
      "CẢNH BÁO HÀNG SẮP HẾT",
      "",
      "NCC: Bích Đại",
      "SKU: GA160",
      "Sản phẩm: Ga chống thấm 1m6",
      "SL hóa đơn: 100",
      "Đã nhận: 88",
      "Còn lại: 12",
      "HĐ: BD-00125",
    ].join("\n")
  );
});

test("formatOutstandingAlertMessage: single SKU, over_received — spec's exact example (negative Còn lại)", () => {
  const message = formatOutstandingAlertMessage(
    "Bích Đại",
    [
      item({
        receivedQty: 102,
        remainingQty: -2,
        alertState: "over_received",
      }),
    ]
  );
  assert.equal(
    message,
    [
      "CẢNH BÁO CẦN XUẤT BÙ",
      "",
      "NCC: Bích Đại",
      "SKU: GA160",
      "Sản phẩm: Ga chống thấm 1m6",
      "SL hóa đơn: 100",
      "Đã nhận: 102",
      "Còn lại: -2",
      "HĐ: BD-00125",
    ].join("\n")
  );
});

test("formatOutstandingAlertMessage: multiple SKUs for the same supplier — batched, spec's exact example", () => {
  const message = formatOutstandingAlertMessage("Bích Đại", [
    item({ invoiceItemId: "ii-1", sku: "GA160", remainingQty: 12, alertState: "near_empty" }),
    item({ invoiceItemId: "ii-2", sku: "GOI4565", remainingQty: 8, alertState: "near_empty" }),
    item({ invoiceItemId: "ii-3", sku: "THAM001", remainingQty: -2, alertState: "over_received" }),
  ]);

  assert.equal(
    message,
    [
      "CẢNH BÁO HÀNG",
      "",
      "Bích Đại",
      "",
      "- GA160: còn 12",
      "- GOI4565: còn 8",
      "- THAM001: cần xuất bù -2",
    ].join("\n")
  );
});

test("formatOutstandingAlertMessage: throws on an empty item list", () => {
  assert.throws(() => formatOutstandingAlertMessage("Bích Đại", []));
});
