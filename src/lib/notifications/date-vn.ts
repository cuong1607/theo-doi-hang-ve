// Shared by every daily-summary event (ZL3's DAILY_RECEIPT_SUMMARY, ZL5's
// DAILY_PAYMENT_SUMMARY, and any future one) — "ngày tính theo
// Asia/Ho_Chi_Minh" is the same rule regardless of which business event is
// asking. Pure, zero DB/"@/" imports, so it runs under plain `node --test`.
export function getTodayDateVN(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
