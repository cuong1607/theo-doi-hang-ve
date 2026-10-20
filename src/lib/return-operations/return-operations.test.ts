// SHOPEE-6B — pure rules: classification, business date, delivery windows,
// summary reconciliation, notification text / slots, logistics adapter.
//   node --test src/lib/return-operations/return-operations.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFailedDeliveryTracking, parseReverseTrackingInfo } from "../channels/shopee/return-logistics-adapter.ts";
import { loadReturnLogisticsFixtures } from "../channels/shopee/return-logistics-provider.ts";
import { mapReturnLogisticsStatus } from "../channels/shopee/return-logistics-status.ts";
import { classifyReturnOperation } from "./classify.ts";
import { returnOperationReason } from "./reasons.ts";
import { formatReturnNotificationMessage, type MessageBucket } from "./notification-message.ts";
import { dueSlots, normalizeSlot, presyncSlots } from "./schedule.ts";
import { addQuantities, buildDailySummary, type SummaryRow } from "./summary.ts";
import { businessDateOf, localTimeOf } from "./time.ts";
import { assignWindow, resolveWindowSet, validateWindowSet, type DeliveryWindow } from "./windows.ts";

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// ------------------------------------------------------------ §68 classification

test("68: delivered order + customer return → Hoàn Trả; failed delivery + RTS → Hoàn Hủy; completed → neither; cancelled before shipment → not Hoàn Hủy", () => {
  assert.equal(classifyReturnOperation({ orderStatus: "COMPLETED", pickupDoneAt: "2026-10-18T02:00:00Z", packageLogisticsStatus: "LOGISTICS_DELIVERY_DONE", returns: [{ status: "ACCEPTED", needsLogistics: true }] }), "customer_return");
  assert.equal(classifyReturnOperation({ orderStatus: "CANCELLED", pickupDoneAt: "2026-10-18T02:00:00Z", packageLogisticsStatus: "LOGISTICS_DELIVERY_FAILED", returns: [] }), "failed_delivery_return");
  assert.equal(classifyReturnOperation({ orderStatus: "CANCELLED", pickupDoneAt: null, packageLogisticsStatus: "LOGISTICS_COD_REJECTED", returns: [] }), "failed_delivery_return");
  assert.equal(classifyReturnOperation({ orderStatus: "COMPLETED", pickupDoneAt: "2026-10-18T02:00:00Z", packageLogisticsStatus: "LOGISTICS_DELIVERY_DONE", returns: [] }), null);
  assert.equal(classifyReturnOperation({ orderStatus: "CANCELLED", pickupDoneAt: null, packageLogisticsStatus: "LOGISTICS_READY", returns: [] }), null, "cancelled before shipping");
  assert.equal(classifyReturnOperation({ orderStatus: "CANCELLED", pickupDoneAt: null, packageLogisticsStatus: null, returns: [] }), null);
  // refund-only / cancelled customer returns are not a physical return
  assert.equal(classifyReturnOperation({ orderStatus: "COMPLETED", pickupDoneAt: "x", packageLogisticsStatus: null, returns: [{ status: "REQUESTED", needsLogistics: false }] }), null);
  assert.equal(classifyReturnOperation({ orderStatus: "COMPLETED", pickupDoneAt: "x", packageLogisticsStatus: null, returns: [{ status: "CANCELLED", needsLogistics: true }] }), null);
  // TO_RETURN without a return record: unconfirmed semantics → not classified
  assert.equal(classifyReturnOperation({ orderStatus: "TO_RETURN", pickupDoneAt: "x", packageLogisticsStatus: null, returns: [] }), null);
});

// ------------------------------------------------------------ §69 business date

test("69: business date in Asia/Ho_Chi_Minh — 23:59 and 00:01 Vietnam fall on their own local days (not UTC)", () => {
  // 23:59 VN on 20/10 = 16:59Z on 20/10
  assert.equal(businessDateOf("2026-10-20T16:59:00Z"), "2026-10-20");
  // 00:01 VN on 21/10 = 17:01Z on 20/10 — UTC date would say 20/10
  assert.equal(businessDateOf("2026-10-20T17:01:00Z"), "2026-10-21");
  assert.equal(localTimeOf("2026-10-20T17:01:00Z"), "00:01:00");
  assert.equal(businessDateOf("2026-10-20T17:01:00Z", "UTC"), "2026-10-20");
});

// ------------------------------------------------------------ §72 windows

const W = (id: string, name: string, s: string, e: string, extra: Partial<DeliveryWindow> = {}): DeliveryWindow => ({ id, name, startTime: s, endTime: e, shopId: null, carrier: null, sortOrder: 0, enabled: true, ...extra });
const GLOBAL = [W("g1", "Ca sáng", "08:00", "11:59", { sortOrder: 1 }), W("g2", "Ca chiều", "12:00", "16:59", { sortOrder: 2 }), W("g3", "Ca tối", "17:00", "21:00", { sortOrder: 3 })];

test("72: 3 windows/day — boundary minutes inclusive, outside → null; 2 windows/day carrier-specific override; shop+carrier beats carrier beats shop beats global", () => {
  const set = resolveWindowSet(GLOBAL, "shop-1", "SPX Express");
  assert.deepEqual(set.map((w) => w.id), ["g1", "g2", "g3"]);
  assert.equal(assignWindow(set, "08:00:00")?.id, "g1");
  assert.equal(assignWindow(set, "10:15:00")?.id, "g1");
  assert.equal(assignWindow(set, "11:59:59")?.id, "g1");
  assert.equal(assignWindow(set, "12:00:00")?.id, "g2");
  assert.equal(assignWindow(set, "14:30:00")?.id, "g2");
  assert.equal(assignWindow(set, "17:45:00")?.id, "g3");
  assert.equal(assignWindow(set, "21:00:59")?.id, "g3");
  assert.equal(assignWindow(set, "21:01:00"), null, "after the last window");
  assert.equal(assignWindow(set, "07:59:59"), null, "before the first window");

  const jt = [W("j1", "Đợt 1", "09:00", "12:59", { carrier: "J&T Express", sortOrder: 1 }), W("j2", "Đợt 2", "13:00", "18:00", { carrier: "J&T Express", sortOrder: 2 })];
  const shopDefault = [W("s1", "Cả ngày", "07:00", "22:00", { shopId: "shop-1" })];
  const shopCarrier = [W("sc1", "Riêng", "10:00", "11:00", { shopId: "shop-1", carrier: "j&t express" })];
  const all = [...GLOBAL, ...jt, ...shopDefault];
  assert.deepEqual(resolveWindowSet(all, "shop-2", "J&T Express").map((w) => w.id), ["j1", "j2"], "carrier set (2 windows)");
  assert.deepEqual(resolveWindowSet(all, "shop-1", "J&T Express").map((w) => w.id), ["j1", "j2"], "carrier beats shop default");
  assert.deepEqual(resolveWindowSet(all, "shop-1", "SPX Express").map((w) => w.id), ["s1"], "shop default beats global");
  assert.deepEqual(resolveWindowSet(all, "shop-2", null).map((w) => w.id), ["g1", "g2", "g3"], "unknown carrier → global");
  assert.deepEqual(resolveWindowSet([...all, ...shopCarrier], "shop-1", "J&T EXPRESS").map((w) => w.id), ["sc1"], "shop+carrier (case-insensitive) wins");
  // disabled windows never count; a scope with none enabled falls through
  assert.deepEqual(resolveWindowSet([...GLOBAL, { ...jt[0], enabled: false }, { ...jt[1], enabled: false }], "x", "J&T Express").map((w) => w.id), ["g1", "g2", "g3"]);
});

test("72: window validation — overlap, end before start, bad time", () => {
  assert.deepEqual(validateWindowSet([{ name: "A", startTime: "08:00", endTime: "11:59", enabled: true }, { name: "B", startTime: "12:00", endTime: "16:59", enabled: true }]), []);
  assert.equal(validateWindowSet([{ name: "A", startTime: "08:00", endTime: "12:00", enabled: true }, { name: "B", startTime: "12:00", endTime: "16:59", enabled: true }]).length, 1);
  assert.equal(validateWindowSet([{ name: "A", startTime: "12:00", endTime: "08:00", enabled: true }]).length, 1);
  assert.equal(validateWindowSet([{ name: "A", startTime: "25:00", endTime: "26:00", enabled: true }]).length, 1);
  // a disabled overlapping window is allowed
  assert.deepEqual(validateWindowSet([{ name: "A", startTime: "08:00", endTime: "12:00", enabled: true }, { name: "B", startTime: "11:00", endTime: "13:00", enabled: false }]), []);
});

// ------------------------------------------------------------ §73 reconciliation

test("73: daily total = Σ windows + outside; every row counted once; empty configured windows shown as 0; exact decimal quantities", () => {
  const rows: SummaryRow[] = [
    { shop_id: "s", carrier: "SPX Express", window_id: "g1", operation_type: "customer_return", order_count: 8, item_qty: "10" },
    { shop_id: "s", carrier: "SPX Express", window_id: "g1", operation_type: "failed_delivery_return", order_count: 10, item_qty: "12" },
    { shop_id: "s", carrier: "SPX Express", window_id: "g2", operation_type: "customer_return", order_count: "7", item_qty: "8.5" },
    { shop_id: "s", carrier: "SPX Express", window_id: null, operation_type: "failed_delivery_return", order_count: 2, item_qty: "2" },
    { shop_id: "s", carrier: "J&T", window_id: "g1", operation_type: "customer_return", order_count: 1, item_qty: "1" },
  ];
  const s = buildDailySummary({ date: "2026-10-20", rows, windows: GLOBAL, shopIds: ["s"] });
  const spx = s.carrierGroups.find((g) => g.carrier === "SPX Express")!;
  assert.deepEqual(spx.deliveryWindows.map((w) => w.name), ["Ca sáng", "Ca chiều", "Ca tối", "Khác / Ngoài ca"]);
  assert.equal(spx.deliveryWindows[2].total.orderCount, 0, "configured window with no delivery yet");
  const sumOrders = spx.deliveryWindows.reduce((a, w) => a + w.total.orderCount, 0);
  const sumItems = addQuantities(...spx.deliveryWindows.map((w) => w.total.itemQuantity));
  assert.equal(sumOrders, spx.total.orderCount);
  assert.equal(sumOrders, 27);
  assert.equal(sumItems, spx.total.itemQuantity);
  assert.equal(spx.total.itemQuantity, "32.5");
  assert.deepEqual(spx.deliveryWindows[0].customerReturn, { orderCount: 8, itemQuantity: "10" });
  assert.equal(s.total.orderCount, 28);
  assert.equal(s.customerReturn.orderCount + s.failedDeliveryReturn.orderCount, s.total.orderCount);
  assert.equal(addQuantities("0.0001", "0.0002", "1"), "1.0003");
});

// ------------------------------------------------------------ §75 notification text + slots

const bucket = (cr: number, fd: number): MessageBucket => ({ customerReturn: { orders: cr, items: String(cr) }, failedDelivery: { orders: fd, items: String(fd) }, total: { orders: cr + fd, items: String(cr + fd) } });

test("75: notification text — windows so far, current window 'đến hiện tại', exact delta or 'Phát sinh từ đầu ngày', sample capped", () => {
  const first = formatReturnNotificationMessage({
    date: "2026-10-20",
    slot: "14:30",
    carriers: [{ carrier: "SPX Express", windows: [{ ...bucket(8, 10), name: "Ca sáng", startTime: "08:00", endTime: "11:59", current: false }, { ...bucket(7, 6), name: "Ca chiều", startTime: "12:00", endTime: "16:59", current: true }], outside: null, total: bucket(15, 16) }],
    total: bucket(15, 16),
    delta: { kind: "first_of_day" },
    includeDetail: false,
    typeFilter: null,
    dataAsOf: null,
    staleMinutes: null,
  });
  assert.match(first, /^HÀNG HOÀN SPX EXPRESS — 20\/10\/2026 — 14:30/);
  assert.match(first, /Đã giao thành công về shop/);
  assert.match(first, /Ca chiều đến hiện tại/);
  assert.match(first, /Hoàn Trả: 8 đơn \/ 8 SP/);
  assert.match(first, /TỔNG TỪ ĐẦU NGÀY:\n31 đơn \/ 31 SP/);
  assert.match(first, /Phát sinh từ đầu ngày/);
  assert.doesNotMatch(first, /Mới từ thông báo trước/);

  const later = formatReturnNotificationMessage({
    date: "2026-10-20",
    slot: "18:30",
    carriers: [{ carrier: "SPX Express", windows: [], outside: null, total: bucket(15, 16) }],
    total: bucket(15, 16),
    delta: { kind: "since_previous", previousTime: "14:30", newOrders: 13, newItems: "15", sampleOrderSns: ["A1", "A2", "A3", "A4", "A5", "A6", "A7"] },
    includeDetail: true,
    typeFilter: "failed_delivery_return",
    dataAsOf: "2026-10-20T11:25:00Z",
    staleMinutes: null,
  });
  assert.match(later, /Mới từ thông báo trước \(14:30\):\n\+13 đơn \/ 15 SP/);
  assert.match(later, /• A5/);
  assert.doesNotMatch(later, /• A6/);
  assert.match(later, /… và 8 đơn khác/);
  assert.doesNotMatch(later, /Hoàn Trả:/, "type filter prints only Hoàn Hủy");
  assert.match(later, /Dữ liệu đồng bộ lúc 18:25/);
});

test("75: slots — due within grace, one per slot window; pre-sync window before the slot", () => {
  const slots = [
    { id: "a", timeOfDay: "10:30", enabled: true },
    { id: "b", timeOfDay: "14:30", enabled: true },
    { id: "c", timeOfDay: "18:30", enabled: false },
  ];
  assert.deepEqual(dueSlots(slots, "10:29:59").map((s) => s.id), []);
  assert.deepEqual(dueSlots(slots, "10:30:00").map((s) => s.id), ["a"]);
  assert.deepEqual(dueSlots(slots, "11:14:00").map((s) => s.id), ["a"]);
  assert.deepEqual(dueSlots(slots, "11:15:00").map((s) => s.id), [], "past the grace → skipped, not back-filled");
  assert.deepEqual(dueSlots(slots, "18:31:00").map((s) => s.id), [], "disabled slot");
  assert.deepEqual(presyncSlots(slots, "14:20:00", 10).map((s) => s.id), ["b"]);
  assert.deepEqual(presyncSlots(slots, "14:30:00", 10).map((s) => s.id), []);
  assert.equal(normalizeSlot("8:5"), null);
  assert.equal(normalizeSlot("8:05"), "08:05");
  assert.equal(normalizeSlot("18:30:00"), "18:30");
});

// ------------------------------------------------------------ §70/§71 Hoàn Trả adapter

test("70: reverse tracking — post-return event meaning delivered-to-seller gives delivered_to_seller_at, rts tracking, segment post_return", () => {
  const f = parseReverseTrackingInfo({
    error: "",
    response: {
      return_sn: "R1",
      tracking_number: "BUYER-TRK",
      reverse_logistics_status: "LOGISTICS_DELIVERY_DONE",
      reverse_logistics_update_time: unix("2026-10-19T08:00:00Z"),
      reverse_logistics_tracking_info: [{ update_time: unix("2026-10-19T08:00:00Z"), tracking_description: "Đã tới kho", logistics_status: "LOGISTICS_DELIVERY_DONE" }],
      post_return_logistics_status: "LOGISTICS_DELIVERY_DONE",
      post_return_logistics_update_time: unix("2026-10-20T07:00:00Z"),
      rts_tracking_number: "RTS-123",
      post_return_logistics_tracking_info: [
        { update_time: unix("2026-10-20T01:00:00Z"), tracking_description: "Lấy hàng", logistics_status: "LOGISTICS_PICKUP_DONE" },
        { update_time: unix("2026-10-20T03:15:00Z"), tracking_description: "Giao thành công cho người bán", logistics_status: "LOGISTICS_DELIVERY_DONE" },
      ],
    },
  });
  assert.equal(f.segment, "post_return");
  assert.equal(f.canonicalStatus, "delivered_to_seller");
  assert.equal(f.deliveredToSellerAt, "2026-10-20T03:15:00.000Z", "the delivered EVENT time, not the status update time");
  assert.equal(f.deliveredAtSource, "tracking_event");
  assert.equal(f.rtsTrackingNumber, "RTS-123");
  assert.equal(f.trackingNumber, "BUYER-TRK");
  assert.equal(businessDateOf(f.deliveredToSellerAt!), "2026-10-20");
  assert.equal(f.events.length, 3);
});

test("71: fallback — no detailed delivered event, segment status delivered → update_time, marked as fallback; not delivered → no timestamp", () => {
  const f = parseReverseTrackingInfo({
    response: {
      return_sn: "R2",
      post_return_logistics_status: "LOGISTICS_DELIVERY_DONE",
      post_return_logistics_update_time: unix("2026-10-20T04:30:00Z"),
      rts_tracking_number: "RTS-9",
      post_return_logistics_tracking_info: [{ update_time: unix("2026-10-20T02:00:00Z"), tracking_description: "Đang giao" }],
    },
  });
  assert.equal(f.deliveredToSellerAt, "2026-10-20T04:30:00.000Z");
  assert.equal(f.deliveredAtSource, "status_update_time");
  assert.ok(f.notes.includes("delivered_fallback_update_time"));

  const inTransit = parseReverseTrackingInfo({ response: { return_sn: "R3", post_return_logistics_status: "LOGISTICS_PICKUP_DONE", post_return_logistics_update_time: unix("2026-10-20T02:00:00Z") } });
  assert.equal(inTransit.canonicalStatus, "in_transit_to_seller");
  assert.equal(inTransit.deliveredToSellerAt, null);
});

test("70: reverse leg delivered with UNKNOWN validation and no post-return data is not delivered-to-seller (may be the warehouse); seller validation is", () => {
  const raw = { return_sn: "R4", reverse_logistics_status: "LOGISTICS_DELIVERY_DONE", reverse_logistics_update_time: unix("2026-10-20T05:00:00Z") };
  const unknown = parseReverseTrackingInfo({ response: raw });
  assert.equal(unknown.canonicalStatus, "unknown");
  assert.equal(unknown.deliveredToSellerAt, null);
  const seller = parseReverseTrackingInfo({ response: { ...raw, validation_type: "seller_validation" } });
  assert.equal(seller.segment, "reverse");
  assert.equal(seller.deliveredToSellerAt, "2026-10-20T05:00:00.000Z");
  const warehouse = parseReverseTrackingInfo({ response: { ...raw, validation_type: "warehouse_validation" } });
  assert.equal(warehouse.segment, "post_return");
  assert.equal(warehouse.deliveredToSellerAt, null);
  assert.equal(warehouse.canonicalStatus, "in_transit_to_seller");
});

// ------------------------------------------------------------ Hoàn Hủy adapter

test("Hoàn Hủy: RETURNED event = delivered back to the seller; DELIVERED (to the buyer) never counts; outbound failure = waiting", () => {
  const f = parseFailedDeliveryTracking(
    {
      response: {
        order_sn: "O1",
        logistics_status: "LOGISTICS_DELIVERY_FAILED",
        tracking_info: [
          { update_time: unix("2026-10-18T02:00:00Z"), description: "Đã lấy hàng", logistics_status: "PICKED_UP" },
          { update_time: unix("2026-10-19T02:00:00Z"), description: "Giao thất bại", logistics_status: "FAILED_DELIVERED" },
          { update_time: unix("2026-10-19T09:00:00Z"), description: "Đang hoàn", logistics_status: "RETURN_STARTED" },
          { update_time: unix("2026-10-20T10:15:00Z"), description: "Đã hoàn hàng cho người bán", logistics_status: "RETURNED" },
        ],
      },
    },
    "SPXVN123",
  );
  assert.equal(f.canonicalStatus, "delivered_to_seller");
  assert.equal(f.deliveredToSellerAt, "2026-10-20T10:15:00.000Z");
  assert.equal(f.trackingNumber, "SPXVN123");
  assert.equal(f.events.length, 4);

  const waiting = parseFailedDeliveryTracking({ response: { order_sn: "O2", logistics_status: "LOGISTICS_DELIVERY_FAILED", tracking_info: [] } }, null);
  assert.equal(waiting.canonicalStatus, "pending");
  assert.equal(waiting.deliveredToSellerAt, null);

  const buyerDelivered = parseFailedDeliveryTracking({ response: { order_sn: "O3", tracking_info: [{ update_time: unix("2026-10-20T03:00:00Z"), logistics_status: "DELIVERED" }] } }, null);
  assert.equal(buyerDelivered.deliveredToSellerAt, null);
  assert.equal(buyerDelivered.canonicalStatus, "unknown");

  assert.equal(mapReturnLogisticsStatus("failed_delivery_rts", "SOMETHING_NEW", "event"), "unknown", "unknown provider value is never guessed");
});

test("fixtures: the documented-shape fixture files load and parse (event, fallback, RTS)", () => {
  const fx = loadReturnLogisticsFixtures();
  const r1 = parseReverseTrackingInfo({ response: fx.reverseBySn.get("FIXTURE-RET-1") });
  assert.equal(r1.deliveredAtSource, "tracking_event");
  assert.equal(r1.rtsTrackingNumber, "SPXVN-RTS-0001");
  const r2 = parseReverseTrackingInfo({ response: fx.reverseBySn.get("FIXTURE-RET-2") });
  assert.equal(r2.deliveredAtSource, "status_update_time");
  const fd = parseFailedDeliveryTracking({ response: fx.trackingByOrderSn.get("FIXTURE-FD-1") }, fx.trackingNumberByOrderSn.get("FIXTURE-FD-1") ?? null);
  assert.equal(fd.canonicalStatus, "delivered_to_seller");
  assert.equal(fd.trackingNumber, "SPXVN-FD-0001");
});

test("real VN shapes (prod 2026-10): reverse history in tracking_info without per-event status -> seller_validation, update_time fallback; return-leg carrier from get_return_detail", async () => {
  const real = {
    error: "",
    response: {
      return_sn: "261007023M90Y6K",
      tracking_info: [{ update_time: 1792200240, tracking_description: "Giao hang thanh cong" }],
      tracking_number: "SPXVN06125226162A",
      validation_type: "seller_validation",
      collection_pin_code: "",
      reverse_logistics_status: "LOGISTICS_DELIVERY_DONE",
      return_refund_request_type: 0,
      estimated_delivery_date_max: 1792256399,
      estimated_delivery_date_min: 1792169999,
      reverse_logistics_update_time: 1792200241,
    },
  };
  const f = parseReverseTrackingInfo(real);
  assert.equal(f.segment, "reverse");
  assert.equal(f.events.length, 1, "tracking_info is the reverse history");
  assert.equal(f.deliveredAtSource, "status_update_time");
  assert.equal(f.deliveredToSellerAt, new Date(1792200241 * 1000).toISOString());
  assert.equal(f.logisticsProvider, null, "reverse tracking has no carrier name");

  const { parseReturnDetail } = await import("../channels/shopee/return-adapter.ts");
  const d = parseReturnDetail({
    error: "",
    response: { return_sn: "2610110BW7X7HD5", order_sn: "2610071VB0KYQF", status: "ACCEPTED", needs_logistics: true, tracking_number: "SPXVN06142532314A", reverse_logistics_status: "LOGISTICS_DELIVERY_DONE", reverse_logistics_channel_name: "SPX Express", item: [] },
  });
  assert.ok(!("issue" in d));
  if (!("issue" in d)) {
    assert.equal(d.detail.reverseLogisticsChannelName, "SPX Express");
    assert.equal(d.detail.reverseLogisticsStatus, "LOGISTICS_DELIVERY_DONE");
  }
});

test("export 'Lý do hoàn': return reason label + buyer text; cancel reason for Hoàn Hủy; unknown codes kept as-is", () => {
  assert.equal(returnOperationReason({ operationType: "customer_return", returnReason: "CHANGE_MIND", returnTextReason: "Hàng không như kỳ vọng", cancelReason: null }), "Đổi ý: Hàng không như kỳ vọng");
  assert.equal(returnOperationReason({ operationType: "customer_return", returnReason: "DIFFERENT_DESCRIPTION", returnTextReason: null, cancelReason: null }), "Không đúng mô tả");
  assert.equal(returnOperationReason({ operationType: "customer_return", returnReason: "NEW_CODE_X", returnTextReason: "", cancelReason: null }), "NEW_CODE_X");
  assert.equal(returnOperationReason({ operationType: "failed_delivery_return", returnReason: null, returnTextReason: null, cancelReason: "Failed Delivery" }), "Giao hàng không thành công");
  assert.equal(returnOperationReason({ operationType: "failed_delivery_return", returnReason: null, returnTextReason: null, cancelReason: "Something Else" }), "Something Else");
  assert.equal(returnOperationReason({ operationType: "failed_delivery_return", returnReason: null, returnTextReason: null, cancelReason: null }), "Giao hàng không thành công");
});
