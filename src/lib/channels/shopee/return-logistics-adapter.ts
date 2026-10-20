// ============================================================
// PHASE SHOPEE-6B: return-logistics payloads → canonical logistics facts.
//
// The ONLY place that knows the field names of
//   v2.returns.get_reverse_tracking_info   (Hoàn Trả)
//   v2.logistics.get_tracking_number       (Hoàn Hủy: tracking number)
//   v2.logistics.get_tracking_info         (Hoàn Hủy: event history)
// Field names follow the documented v2 schema — NOT yet confirmed on a real
// VN payload (docs/shopee-return-operations.md §API validation). Tolerant:
// unknown fields ignored, missing optional fields → null, never a guess.
//
// delivered_to_seller_at rules (also in the docs):
//   Hoàn Trả  segment that ends at the seller:
//               post_return (warehouse → seller) when Shopee reports any
//               post-return data or warehouse validation;
//               reverse (buyer → seller) only with SELLER validation.
//               reverse "delivered" with unknown validation and no
//               post-return data is NOT treated as delivered to the seller
//               (it may be the warehouse) → canonical "unknown".
//             1. earliest event of that segment whose own status means
//                delivered-to-seller (source "tracking_event")
//             2. fallback ONLY when the segment status itself means
//                delivered: the segment's update_time ("status_update_time")
//   Hoàn Hủy  earliest tracking event whose status means returned to the
//             seller (RETURNED, candidate). No fallback.
// Description text is kept for display only, never interpreted.
// Pure: no I/O.
// ============================================================
import { z } from "zod";

import { ShopeePayloadError } from "./product-adapter.ts";
import { isDeliveredToSellerEvent, mapReturnLogisticsStatus, type ReturnLogisticsSegment, type ReturnOpCanonicalStatus } from "./return-logistics-status.ts";

export const RETURN_LOGISTICS_API = {
  reverse: "v2.returns.get_reverse_tracking_info",
  trackingNumber: "v2.logistics.get_tracking_number",
  trackingInfo: "v2.logistics.get_tracking_info",
} as const;

const envelope = z.object({ error: z.string().nullish(), message: z.string().nullish(), response: z.unknown().optional() }).passthrough();
const unix = z.union([z.number(), z.string()]).nullish();
const text = z.string().nullish();

const trackingEvent = z
  .object({
    update_time: unix,
    tracking_description: text,
    description: text,
    logistics_status: text,
    status: text,
    location: text,
  })
  .passthrough();

const reverseResponse = z
  .object({
    return_sn: z.union([z.string(), z.number()]).nullish(),
    validation_type: text,
    return_refund_request_type: z.union([z.string(), z.number()]).nullish(),
    tracking_number: text,
    reverse_logistics_status: text,
    reverse_logistics_update_time: unix,
    reverse_logistics_tracking_info: z.array(z.unknown()).nullish(),
    post_return_logistics_status: text,
    post_return_logistics_update_time: unix,
    rts_tracking_number: text,
    post_return_logistics_tracking_info: z.array(z.unknown()).nullish(),
    logistics_channel_name: text,
    shipping_carrier: text,
  })
  .passthrough();

const trackingNumberResponse = z.object({ tracking_number: text, plp_number: text, first_mile_tracking_number: text, last_mile_tracking_number: text }).passthrough();

const trackingInfoResponse = z
  .object({
    order_sn: text,
    package_number: text,
    logistics_status: text,
    tracking_info: z.array(z.unknown()).nullish(),
  })
  .passthrough();

const clean = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
function unixToIso(v: string | number | null | undefined): string | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function describe(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function unwrap(api: string, raw: unknown): unknown {
  const env = envelope.safeParse(raw);
  if (!env.success) throw new ShopeePayloadError(api, describe(env.error));
  if (env.data.error) throw new ShopeePayloadError(api, `error=${env.data.error} ${env.data.message ?? ""}`.trim());
  return env.data.response ?? {};
}

export interface LogisticsEvent {
  segment: ReturnLogisticsSegment;
  eventTime: string;
  providerStatus: string | null;
  canonicalStatus: ReturnOpCanonicalStatus;
  description: string | null;
  location: string | null;
  trackingNumber: string | null;
}

export interface ReturnLogisticsFacts {
  segment: ReturnLogisticsSegment;
  providerStatus: string | null;
  canonicalStatus: ReturnOpCanonicalStatus;
  /** Time of the latest status (segment update_time, else latest event). */
  lastStatusAt: string | null;
  deliveredToSellerAt: string | null;
  deliveredAtSource: "tracking_event" | "status_update_time" | null;
  trackingNumber: string | null;
  rtsTrackingNumber: string | null;
  logisticsProvider: string | null;
  events: LogisticsEvent[];
  /** Short machine notes (e.g. "reverse_delivered_unknown_validation"). */
  notes: string[];
}

function parseEvents(segment: ReturnLogisticsSegment, raw: unknown[] | null | undefined, trackingNumber: string | null): LogisticsEvent[] {
  const out: LogisticsEvent[] = [];
  for (const e of raw ?? []) {
    const p = trackingEvent.safeParse(e);
    if (!p.success) continue;
    const eventTime = unixToIso(p.data.update_time);
    if (!eventTime) continue; // an event without time cannot be placed — skipped, never invented
    const providerStatus = clean(p.data.logistics_status) ?? clean(p.data.status);
    out.push({
      segment,
      eventTime,
      providerStatus: providerStatus?.toUpperCase() ?? null,
      canonicalStatus: providerStatus ? mapReturnLogisticsStatus(segment, providerStatus, "event") : "unknown",
      description: clean(p.data.tracking_description) ?? clean(p.data.description),
      location: clean(p.data.location),
      trackingNumber,
    });
  }
  return out.sort((a, b) => a.eventTime.localeCompare(b.eventTime));
}

/** Earliest event of the segment whose own status means delivered-to-seller. */
function firstDeliveredEvent(segment: ReturnLogisticsSegment, events: LogisticsEvent[]): LogisticsEvent | null {
  return events.find((e) => e.segment === segment && isDeliveredToSellerEvent(segment, e.providerStatus)) ?? null;
}

const WAREHOUSE = /WAREHOUSE/i;
const SELLER = /SELLER/i;

/** v2.returns.get_reverse_tracking_info → facts. */
export function parseReverseTrackingInfo(raw: unknown): ReturnLogisticsFacts {
  const res = reverseResponse.safeParse(unwrap(RETURN_LOGISTICS_API.reverse, raw));
  if (!res.success) throw new ShopeePayloadError(RETURN_LOGISTICS_API.reverse, describe(res.error));
  const d = res.data;
  const notes: string[] = [];
  const reverseTracking = clean(d.tracking_number);
  const rtsTracking = clean(d.rts_tracking_number);
  const reverseEvents = parseEvents("reverse", d.reverse_logistics_tracking_info, reverseTracking);
  const postEvents = parseEvents("post_return", d.post_return_logistics_tracking_info, rtsTracking);
  const postStatus = clean(d.post_return_logistics_status)?.toUpperCase() ?? null;
  const reverseStatus = clean(d.reverse_logistics_status)?.toUpperCase() ?? null;
  const validation = clean(d.validation_type);

  const hasPost = !!(postStatus || rtsTracking || postEvents.length > 0 || unixToIso(d.post_return_logistics_update_time));
  const warehouse = validation ? WAREHOUSE.test(validation) : false;
  const sellerValidation = validation ? SELLER.test(validation) && !warehouse : false;
  const segment: ReturnLogisticsSegment = hasPost || warehouse ? "post_return" : "reverse";

  const status = segment === "post_return" ? postStatus : reverseStatus;
  const updateTime = unixToIso(segment === "post_return" ? d.post_return_logistics_update_time : d.reverse_logistics_update_time);
  const segEvents = segment === "post_return" ? postEvents : reverseEvents;
  let canonical = mapReturnLogisticsStatus(segment, status);
  if (segment === "post_return" && !postStatus && warehouse) canonical = reverseStatus ? "in_transit_to_seller" : "pending";

  let deliveredAt: string | null = null;
  let source: ReturnLogisticsFacts["deliveredAtSource"] = null;
  const reverseEndsAtSeller = segment === "post_return" || sellerValidation;
  if (reverseEndsAtSeller) {
    const ev = firstDeliveredEvent(segment, segEvents);
    if (ev) {
      deliveredAt = ev.eventTime;
      source = "tracking_event";
    } else if (canonical === "delivered_to_seller" && updateTime) {
      deliveredAt = updateTime;
      source = "status_update_time";
      notes.push("delivered_fallback_update_time");
    }
    if (deliveredAt) canonical = "delivered_to_seller";
  } else if (canonical === "delivered_to_seller") {
    // reverse leg delivered, validation unknown, no post-return data: maybe the warehouse
    canonical = "unknown";
    notes.push("reverse_delivered_unknown_validation");
  }
  if (canonical === "delivered_to_seller" && !deliveredAt) {
    canonical = "unknown";
    notes.push("delivered_without_time");
  }

  const lastEvent = segEvents.at(-1)?.eventTime ?? null;
  return {
    segment,
    providerStatus: status ? `${segment === "post_return" ? "post_return" : "reverse"}:${status}` : null,
    canonicalStatus: canonical,
    lastStatusAt: updateTime ?? lastEvent,
    deliveredToSellerAt: deliveredAt,
    deliveredAtSource: source,
    trackingNumber: reverseTracking,
    rtsTrackingNumber: rtsTracking,
    logisticsProvider: clean(d.logistics_channel_name) ?? clean(d.shipping_carrier),
    events: [...reverseEvents, ...postEvents],
    notes,
  };
}

/** v2.logistics.get_tracking_number → the tracking number (null when Shopee has none yet). */
export function parseTrackingNumber(raw: unknown): string | null {
  const res = trackingNumberResponse.safeParse(unwrap(RETURN_LOGISTICS_API.trackingNumber, raw));
  if (!res.success) throw new ShopeePayloadError(RETURN_LOGISTICS_API.trackingNumber, describe(res.error));
  return clean(res.data.tracking_number);
}

/** v2.logistics.get_tracking_info (failed-delivery RTS) → facts. */
export function parseFailedDeliveryTracking(raw: unknown, trackingNumber: string | null): ReturnLogisticsFacts {
  const res = trackingInfoResponse.safeParse(unwrap(RETURN_LOGISTICS_API.trackingInfo, raw));
  if (!res.success) throw new ShopeePayloadError(RETURN_LOGISTICS_API.trackingInfo, describe(res.error));
  const d = res.data;
  const segment: ReturnLogisticsSegment = "failed_delivery_rts";
  const events = parseEvents(segment, d.tracking_info, trackingNumber);
  const packageStatus = clean(d.logistics_status)?.toUpperCase() ?? null;
  const delivered = firstDeliveredEvent(segment, events);
  const latest = events.at(-1) ?? null;
  let canonical: ReturnOpCanonicalStatus;
  if (delivered) canonical = "delivered_to_seller";
  else if (latest && latest.canonicalStatus !== "unknown") canonical = latest.canonicalStatus;
  else if (latest) canonical = "unknown";
  else canonical = mapReturnLogisticsStatus(segment, packageStatus, "status");
  return {
    segment,
    providerStatus: latest?.providerStatus ?? packageStatus,
    canonicalStatus: canonical,
    lastStatusAt: latest?.eventTime ?? null,
    deliveredToSellerAt: delivered?.eventTime ?? null,
    deliveredAtSource: delivered ? "tracking_event" : null,
    trackingNumber,
    rtsTrackingNumber: null,
    logisticsProvider: null,
    events,
    notes: [],
  };
}

/** Raw tracking payloads carry no buyer data except free-text locations/descriptions; kept as-is in snapshots. */
export function toApplyOperationEvents(facts: ReturnLogisticsFacts) {
  return facts.events.map((e) => ({
    source_segment: e.segment,
    event_time: e.eventTime,
    provider_status: e.providerStatus,
    canonical_status: e.canonicalStatus,
    description: e.description,
    location: e.location,
    tracking_number: e.trackingNumber,
  }));
}
