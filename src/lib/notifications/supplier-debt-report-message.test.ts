// Run: node --test src/lib/notifications/supplier-debt-report-message.test.ts
// Only the pure, DB-free functions are covered (grouping + message formatting + question detection).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatSupplierDebtReportMessages,
  groupSupplierDebt,
  SUPPLIER_DEBT_EMPTY_MESSAGE,
} from "./supplier-debt-report-message.ts";
import { isSupplierDebtQuestion } from "../conversation/router.ts";

const row = (supplier_id: string, supplier_name: string, invoice_date: string, remaining_amount: number) => ({
  supplier_id,
  supplier_name,
  invoice_date,
  remaining_amount,
});

const vnd = (n: number) => `${n.toLocaleString("vi-VN")} đ`;

test("groupSupplierDebt: per-supplier buckets, supplier totals and grand total", () => {
  const r = groupSupplierDebt("2026-11-20", [
    row("s1", "Tuấn Hậu", "2026-11-05", 10_000_000),
    row("s1", "Tuấn Hậu", "2026-11-12", 5_000_000),
    row("s2", "Minh Anh", "2026-10-30", 2_500_000),
  ]);
  assert.equal(r.invoiceCount, 3);
  assert.equal(r.totalRemaining, 17_500_000);
  assert.deepEqual(
    r.suppliers.map((s) => [s.supplierName, s.supplierTotal]),
    [
      ["Tuấn Hậu", 15_000_000],
      ["Minh Anh", 2_500_000],
    ],
  );
});

test("formatSupplierDebtReportMessages: one message with supplier name, invoice date, remaining amount", () => {
  const report = groupSupplierDebt("2026-11-20", [
    row("s1", "Tuấn Hậu", "2026-11-05", 10_000_000),
    row("s1", "Tuấn Hậu", "2026-11-12", 5_000_000),
    row("s2", "Minh Anh", "2026-10-30", 2_500_000),
  ]);
  const msgs = formatSupplierDebtReportMessages(report);
  assert.equal(msgs.length, 1);
  assert.equal(
    msgs[0],
    [
      "CÔNG NỢ NCC 20/11/2026",
      "",
      "Tuấn Hậu",
      `- 05/11/2026: ${vnd(10_000_000)}`,
      `- 12/11/2026: ${vnd(5_000_000)}`,
      `Còn nợ NCC: ${vnd(15_000_000)}`,
      "",
      "Minh Anh",
      `- 30/10/2026: ${vnd(2_500_000)}`,
      `Còn nợ NCC: ${vnd(2_500_000)}`,
      "",
      "TỔNG CÒN NỢ:",
      vnd(17_500_000),
    ].join("\n"),
  );
});

test("formatSupplierDebtReportMessages: empty report -> single 'no debt' message", () => {
  assert.deepEqual(formatSupplierDebtReportMessages(groupSupplierDebt("2026-11-20", [])), [SUPPLIER_DEBT_EMPTY_MESSAGE]);
});

test("formatSupplierDebtReportMessages: long report splits under the limit, keeps every invoice once, total only on the last part", () => {
  const rows = [];
  for (let s = 0; s < 3; s++) {
    for (let i = 1; i <= 60; i++) {
      rows.push(row(`s${s}`, `NCC số ${s}`, `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, 1_000 * i));
    }
  }
  const msgs = formatSupplierDebtReportMessages(groupSupplierDebt("2026-11-20", rows), 700);
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.length <= 700, `part is ${m.length} chars`);
  msgs.forEach((m, i) => assert.ok(m.startsWith(`CÔNG NỢ NCC 20/11/2026 (${i + 1}/${msgs.length})`)));
  const invoiceLines = msgs.join("\n").split("\n").filter((l) => l.startsWith("- "));
  assert.equal(invoiceLines.length, rows.length, "no invoice lost or duplicated");
  assert.ok(msgs.slice(0, -1).every((m) => !m.includes("TỔNG CÒN NỢ")));
  assert.ok(msgs[msgs.length - 1].includes("TỔNG CÒN NỢ"));
  assert.ok(msgs.slice(1).some((m) => m.includes("(tiếp)")), "a supplier cut mid-way is labelled on the next part");
});

test("isSupplierDebtQuestion: matches debt questions, not shop / product analysis", () => {
  for (const t of ["công nợ NCC", "Công nợ ncc hôm nay", "cho mình xem công nợ nhà cung cấp", "nợ NCC", "báo cáo nợ"]) {
    assert.equal(isSupplierDebtQuestion(t), true, t);
  }
  for (const t of ["sản phẩm áo tuần này", "shop RUGLUX hôm qua", "quảng cáo 7 ngày qua", "hướng dẫn", "nợ"]) {
    assert.equal(isSupplierDebtQuestion(t), false, t);
  }
});
