// SHOPEE-6 — return adapter + status mapping (pure):
//   node --test src/lib/channels/shopee/return-adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseReturnDetail, parseReturnListPage, returnFingerprint, sanitizeReturnPayload } from "./return-adapter.ts";
import { DISPOSITION_INFO, isReturnDisposition, isReturnTerminal, RETURN_DISPOSITIONS, returnStatusInfo } from "./return-status.ts";

const detail = (over: Record<string, unknown> = {}) => ({
  error: "",
  message: "",
  response: {
    return_sn: 2610171234567890,
    order_sn: "261017ABCDEF",
    status: "requested",
    reason: "NOT_RECEIPT",
    refund_amount: 199000,
    currency: "vnd",
    create_time: 1792200000,
    update_time: 1792203600,
    reverse_logistic_status: "LOGISTICS_PENDING_ARRANGE",
    seller_compensation: { seller_compensation_status: "PENDING", compensation_amount: 0 },
    negotiation: { negotiation_status: "PENDING_RESPOND" },
    user: { username: "pii", email: "x@y.z" },
    return_pickup_address: { name: "pii" },
    item: [
      { item_id: 803945992, model_id: 0, name: "Ga", item_sku: "ga", variation_sku: "", amount: 2, refund_amount: 199000, images: ["u"] },
      { item_id: 803945993, model_id: 77, name: "Nệm", amount: 1 },
    ],
    future_field: { anything: true },
    ...over,
  },
});

test("SHOPEE-6 A1: list envelope (sandbox-confirmed shape) → entries; a bad entry is an issue, not a page failure", () => {
  const page = parseReturnListPage({ error: "", response: { more: true, return: [{ return_sn: 1, order_sn: "A", status: "ACCEPTED", update_time: 1792203600 }, { order_sn: "no-sn" }] } });
  assert.deepEqual(page.entries, [{ returnSn: "1", orderSn: "A", status: "ACCEPTED", updatedAt: "2026-10-17T02:20:00.000Z" }]);
  assert.equal(page.more, true);
  assert.equal(page.issues.length, 1);
  assert.deepEqual(parseReturnListPage({ error: "", response: { return: [], more: false } }).entries, [], "empty sandbox list");
  assert.throws(() => parseReturnListPage({ error: "error_auth", message: "x" }), /error_auth/);
});

test("SHOPEE-6 A1: detail → canonical return (ids as text, model 0 → null, decimals exact, status upper-cased, terminal flag)", () => {
  const r = parseReturnDetail(detail());
  assert.ok("detail" in r);
  const d = r.detail;
  assert.deepEqual(
    [d.externalReturnSn, d.externalOrderSn, d.status, d.refundAmount, d.currency, d.sellerCompensationStatus, d.sellerCompensationAmount, d.negotiationStatus, d.isTerminal, d.completedAt],
    ["2610171234567890", "261017ABCDEF", "REQUESTED", "199000", "VND", "PENDING", "0", "PENDING_RESPOND", false, null],
  );
  assert.deepEqual(d.items.map((i) => [i.externalItemId, i.externalModelId, i.quantity, i.refundAmount]), [["803945992", null, "2", "199000"], ["803945993", "77", "1", null]]);
  const done = parseReturnDetail(detail({ status: "REFUND_PAID" }));
  assert.ok("detail" in done && done.detail.isTerminal && done.detail.completedAt === "2026-10-17T02:20:00.000Z");
});

test("SHOPEE-6 41: snapshots never keep buyer identity / addresses / media", () => {
  const r = parseReturnDetail(detail());
  assert.ok("sanitized" in r);
  const s = r.sanitized as Record<string, unknown>;
  assert.equal(s.user, undefined);
  assert.equal(s.return_pickup_address, undefined);
  assert.equal((s.item as Array<Record<string, unknown>>)[0].images, undefined);
  assert.equal(s.future_field !== undefined, true, "unknown non-PII fields are kept for audit");
  assert.deepEqual(sanitizeReturnPayload({ a: [{ user: 1, b: 2 }] }), { a: [{ b: 2 }] });
});

test("SHOPEE-6: invalid item identity → the whole return is an issue (never a partial return)", () => {
  assert.ok("issue" in parseReturnDetail(detail({ item: [{ item_id: 1, amount: 0 }] })));
  assert.ok("issue" in parseReturnDetail(detail({ item: [{ amount: 1 }] })));
  assert.ok("issue" in parseReturnDetail({ error: "", response: { order_sn: "A" } }), "no return_sn");
});

test("SHOPEE-6 44 + 48: one status / disposition mapping; unknown statuses are shown raw and kept polling", () => {
  assert.equal(isReturnTerminal("CLOSED"), true);
  assert.equal(isReturnTerminal("cancelled"), true);
  assert.equal(isReturnTerminal("REQUESTED"), false);
  assert.deepEqual([returnStatusInfo("NEW_PROVIDER_STATE").label, returnStatusInfo("NEW_PROVIDER_STATE").terminal], ["NEW_PROVIDER_STATE", false]);
  assert.deepEqual(RETURN_DISPOSITIONS, ["pending", "restock", "damaged", "lost", "disposed"]);
  assert.deepEqual(RETURN_DISPOSITIONS.map((d) => DISPOSITION_INFO[d].label), ["Chờ xử lý", "Nhập lại kho", "Hỏng", "Thất lạc", "Huỷ bỏ"]);
  assert.equal(isReturnDisposition("restock"), true);
  assert.equal(isReturnDisposition("returned"), false);
});

test("SHOPEE-6: the fingerprint changes on status / items, not on noise", () => {
  const a = parseReturnDetail(detail());
  const b = parseReturnDetail(detail({ text_reason: "changed text" }));
  const c = parseReturnDetail(detail({ status: "ACCEPTED" }));
  assert.ok("detail" in a && "detail" in b && "detail" in c);
  assert.equal(returnFingerprint(a.detail), returnFingerprint(b.detail));
  assert.notEqual(returnFingerprint(a.detail), returnFingerprint(c.detail));
});
