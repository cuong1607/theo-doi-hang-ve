// ============================================================
// PHASE SHOPEE-6B: scheduled "hàng hoàn đã giao" notification text.
// Summary + exact delta only — never hundreds of rows (the UI has the list).
// Delta = operations in THIS run's membership that were not in the previous
// successful run of the same setting and business date (computed in SQL from
// return_notification_run_operations, never count − count). First run of the
// day says "Phát sinh từ đầu ngày" instead of a misleading "+X".
// Pure: no I/O.
// ============================================================
import { displayDate } from "./time.ts";

export interface Counts {
  orders: number;
  items: string;
}

export interface MessageBucket {
  customerReturn: Counts;
  failedDelivery: Counts;
  total: Counts;
}

export interface MessageWindow extends MessageBucket {
  name: string;
  startTime: string;
  endTime: string;
  /** now is inside this window → "đến hiện tại". */
  current: boolean;
}

export interface MessageCarrier {
  carrier: string;
  windows: MessageWindow[];
  outside: MessageBucket | null;
  total: MessageBucket;
}

export type MessageDelta = { kind: "first_of_day" } | { kind: "since_previous"; previousTime: string; newOrders: number; newItems: string; sampleOrderSns: string[] };

export interface ReturnNotificationMessageInput {
  date: string;
  /** "HH:MM" of the scheduled slot. */
  slot: string;
  carriers: MessageCarrier[];
  total: MessageBucket;
  delta: MessageDelta | null;
  includeDetail: boolean;
  /** Only one type selected in the setting → only that line is printed. */
  typeFilter: "customer_return" | "failed_delivery_return" | null;
  /** Oldest last-success among the return sync types (ISO) — printed as "dữ liệu lúc". */
  dataAsOf: string | null;
  staleMinutes: number | null;
  sampleLimit?: number;
}

const qty = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(n) : s;
};
const line = (c: Counts) => `${c.orders} đơn / ${qty(c.items)} SP`;

function bucketLines(b: MessageBucket, typeFilter: ReturnNotificationMessageInput["typeFilter"]): string[] {
  const out: string[] = [];
  if (typeFilter !== "failed_delivery_return") out.push(`Hoàn Trả: ${line(b.customerReturn)}`);
  if (typeFilter !== "customer_return") out.push(`Hoàn Hủy: ${line(b.failedDelivery)}`);
  return out;
}

function hhmmVN(iso: string): string {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function formatReturnNotificationMessage(input: ReturnNotificationMessageInput): string {
  const single = input.carriers.length === 1 ? input.carriers[0].carrier : null;
  const out: string[] = [`HÀNG HOÀN${single ? ` ${single.toUpperCase()}` : ""} — ${displayDate(input.date)} — ${input.slot}`, "Đã giao thành công về shop"];

  if (input.carriers.length === 0) {
    out.push("", "Chưa có đơn hoàn nào được giao về shop hôm nay.");
  }
  for (const c of input.carriers) {
    if (!single) out.push("", `▸ ${c.carrier}`);
    for (const w of c.windows) {
      out.push("", `${w.name}${w.current ? " đến hiện tại" : ""} (${w.startTime}–${w.endTime})`, ...bucketLines(w, input.typeFilter));
    }
    if (c.outside) out.push("", "Khác / Ngoài ca", ...bucketLines(c.outside, input.typeFilter));
    if (!single) out.push(`Tổng ${c.carrier}: ${line(c.total.total)}`);
  }

  out.push("", "TỔNG TỪ ĐẦU NGÀY:", line(input.total.total));

  if (input.delta) {
    if (input.delta.kind === "first_of_day") {
      out.push("", "Phát sinh từ đầu ngày:", line(input.total.total));
    } else {
      out.push("", `Mới từ thông báo trước (${input.delta.previousTime}):`, `+${input.delta.newOrders} đơn / ${qty(input.delta.newItems)} SP`);
      if (input.includeDetail && input.delta.sampleOrderSns.length > 0) {
        const limit = input.sampleLimit ?? 5;
        const shown = input.delta.sampleOrderSns.slice(0, limit);
        const more = input.delta.newOrders - shown.length;
        out.push(...shown.map((sn) => `• ${sn}`));
        if (more > 0) out.push(`… và ${more} đơn khác (xem đầy đủ trên hệ thống)`);
      }
    }
  }

  if (input.dataAsOf) {
    out.push("", `Dữ liệu đồng bộ lúc ${hhmmVN(input.dataAsOf)}${input.staleMinutes !== null && input.staleMinutes > 0 ? ` (chưa đồng bộ ${input.staleMinutes} phút)` : ""}`);
  }
  return out.join("\n");
}
