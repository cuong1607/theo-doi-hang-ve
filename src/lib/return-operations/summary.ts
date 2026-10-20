// ============================================================
// PHASE SHOPEE-6B: daily summary shaping (pure). SQL aggregates
// (carrier, window, type) → counts; this file only arranges those rows into
// carrier groups → delivery windows (+ "Ngoài ca") → totals, and adds the
// configured windows that had no delivery yet (shown as 0).
//
// Reconciliation is structural: every SQL row lands in exactly one window
// bucket of exactly one carrier, and every total is the sum of its buckets —
// daily total = Σ windows + outside, never computed separately.
// Quantities are exact decimal strings (≤ 4 decimals), added as BigInt.
// Pure: no I/O.
// ============================================================
import type { ReturnOperationType } from "./classify.ts";
import { OUTSIDE_WINDOW_ID, OUTSIDE_WINDOW_LABEL, resolveWindowSet, type DeliveryWindow } from "./windows.ts";

const SCALE = BigInt(10_000);
const ZERO = BigInt(0);

function toUnits(q: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,4})\d*)?$/.exec(q.trim());
  if (!m) return ZERO;
  const v = BigInt(m[2]) * SCALE + BigInt((m[3] ?? "").padEnd(4, "0"));
  return m[1] ? -v : v;
}

function fromUnits(u: bigint): string {
  const neg = u < ZERO;
  const a = neg ? -u : u;
  const int = a / SCALE;
  const frac = (a % SCALE).toString().padStart(4, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Exact sum of decimal quantity strings. */
export function addQuantities(...values: string[]): string {
  return fromUnits(values.reduce((s, v) => s + toUnits(v), ZERO));
}

export interface CountPair {
  orderCount: number;
  itemQuantity: string;
}

export interface Breakdown {
  customerReturn: CountPair;
  failedDeliveryReturn: CountPair;
  total: CountPair;
}

export interface WindowBreakdown extends Breakdown {
  windowId: string;
  name: string;
  startTime: string | null;
  endTime: string | null;
  isOutside: boolean;
}

export interface CarrierGroup extends Breakdown {
  /** null = carrier unknown. */
  carrier: string | null;
  label: string;
  deliveryWindows: WindowBreakdown[];
}

export interface DailySummary extends Breakdown {
  date: string;
  carrierGroups: CarrierGroup[];
}

export interface SummaryRow {
  shop_id: string;
  carrier: string | null;
  window_id: string | null;
  operation_type: ReturnOperationType;
  order_count: number | string;
  item_qty: string;
}

export const UNKNOWN_CARRIER_LABEL = "Không rõ ĐVVC";

const zero = (): CountPair => ({ orderCount: 0, itemQuantity: "0" });
const emptyBreakdown = (): Breakdown => ({ customerReturn: zero(), failedDeliveryReturn: zero(), total: zero() });

function addTo(b: Breakdown, type: ReturnOperationType, orders: number, qty: string) {
  const target = type === "customer_return" ? b.customerReturn : b.failedDeliveryReturn;
  target.orderCount += orders;
  target.itemQuantity = addQuantities(target.itemQuantity, qty);
  b.total.orderCount += orders;
  b.total.itemQuantity = addQuantities(b.total.itemQuantity, qty);
}

const hhmm = (t: string) => t.slice(0, 5);

export function buildDailySummary(input: { date: string; rows: readonly SummaryRow[]; windows: readonly DeliveryWindow[]; shopIds: readonly string[] }): DailySummary {
  const byCarrier = new Map<string, { carrier: string | null; rows: SummaryRow[] }>();
  for (const r of input.rows) {
    const key = (r.carrier ?? "").toLowerCase();
    const g = byCarrier.get(key) ?? { carrier: r.carrier, rows: [] };
    g.rows.push(r);
    byCarrier.set(key, g);
  }
  const windowById = new Map(input.windows.map((w) => [w.id, w]));
  const summary: DailySummary = { date: input.date, carrierGroups: [], ...emptyBreakdown() };

  for (const { carrier, rows } of byCarrier.values()) {
    const group: CarrierGroup = { carrier, label: carrier ?? UNKNOWN_CARRIER_LABEL, deliveryWindows: [], ...emptyBreakdown() };
    const buckets = new Map<string, WindowBreakdown>();
    // configured windows of every shop in scope (shown even when still 0)
    const shopIds = input.shopIds.length > 0 ? input.shopIds : [...new Set(rows.map((r) => r.shop_id))];
    for (const shopId of shopIds) {
      for (const w of resolveWindowSet(input.windows, shopId, carrier)) {
        if (!buckets.has(w.id)) buckets.set(w.id, { windowId: w.id, name: w.name, startTime: hhmm(w.startTime), endTime: hhmm(w.endTime), isOutside: false, ...emptyBreakdown() });
      }
    }
    for (const r of rows) {
      const id = r.window_id ?? OUTSIDE_WINDOW_ID;
      let b = buckets.get(id);
      if (!b) {
        const w = r.window_id ? windowById.get(r.window_id) : undefined;
        b = w
          ? { windowId: w.id, name: w.name, startTime: hhmm(w.startTime), endTime: hhmm(w.endTime), isOutside: false, ...emptyBreakdown() }
          : { windowId: OUTSIDE_WINDOW_ID, name: OUTSIDE_WINDOW_LABEL, startTime: null, endTime: null, isOutside: true, ...emptyBreakdown() };
        buckets.set(b.windowId, b);
      }
      const orders = Number(r.order_count);
      addTo(b, r.operation_type, orders, r.item_qty);
      addTo(group, r.operation_type, orders, r.item_qty);
      addTo(summary, r.operation_type, orders, r.item_qty);
    }
    group.deliveryWindows = [...buckets.values()].sort((a, b) => {
      if (a.isOutside !== b.isOutside) return a.isOutside ? 1 : -1;
      const wa = windowById.get(a.windowId);
      const wb = windowById.get(b.windowId);
      return (wa?.sortOrder ?? 0) - (wb?.sortOrder ?? 0) || (a.startTime ?? "").localeCompare(b.startTime ?? "");
    });
    summary.carrierGroups.push(group);
  }
  summary.carrierGroups.sort((a, b) => b.total.orderCount - a.total.orderCount || a.label.localeCompare(b.label));
  return summary;
}
