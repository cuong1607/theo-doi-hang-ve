// ============================================================
// PHASE SHOPEE-3: split a [from, to] range into consecutive windows no longer
// than `maxSeconds` (Shopee get_order_list: ≤ 15 days per request).
// Callers never have to pre-split. Windows touch end-to-start (inclusive
// bounds on both sides are fine: order_sn are deduped by the sync).
// ============================================================

export interface TimeWindow {
  from: number; // Unix seconds
  to: number;
}

export function splitTimeWindows(fromSeconds: number, toSeconds: number, maxSeconds: number): TimeWindow[] {
  if (!Number.isInteger(fromSeconds) || !Number.isInteger(toSeconds) || maxSeconds <= 0) throw new Error("Khoảng thời gian không hợp lệ.");
  if (toSeconds < fromSeconds) throw new Error("time_to phải ≥ time_from.");
  const windows: TimeWindow[] = [];
  for (let start = fromSeconds; ; start += maxSeconds) {
    const end = Math.min(start + maxSeconds, toSeconds);
    windows.push({ from: start, to: end });
    if (end >= toSeconds) break;
  }
  return windows;
}

/** Runs `fn` over `items` with at most `limit` in flight (no unbounded Promise.all). */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
