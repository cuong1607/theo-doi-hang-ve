"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/logs";

const STATUS_OPTIONS = [
  { label: "Đang gửi", value: "pending" },
  { label: "Thành công", value: "sent" },
  { label: "Thất bại", value: "failed" },
  { label: "Bỏ qua", value: "skipped" },
];

export function LogFilters({
  date,
  eventType,
  recipientId,
  status,
  recipients,
}: {
  date: string;
  eventType: string;
  recipientId: string;
  status: string;
  recipients: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const eventItems = [
    { label: "Tất cả event", value: "all" },
    ...NOTIFICATION_EVENT_TYPES.map((e) => ({ label: e, value: e })),
  ];
  const recipientItems = [
    { label: "Tất cả người nhận", value: "all" },
    ...recipients.map((r) => ({ label: r.name, value: r.id })),
  ];
  const statusItems = [{ label: "Tất cả trạng thái", value: "all" }, ...STATUS_OPTIONS];

  const hasAnyFilter = !!(date || eventType || recipientId || status);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <label htmlFor="logDate" className="text-xs font-medium text-muted-foreground">
          Ngày
        </label>
        <Input
          id="logDate"
          type="date"
          defaultValue={date}
          onChange={(e) => updateParam("logDate", e.target.value)}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="logEvent" className="text-xs font-medium text-muted-foreground">
          Event
        </label>
        <Select value={eventType || "all"} onValueChange={(v) => updateParam("logEvent", v === "all" ? "" : String(v))} items={eventItems}>
          <SelectTrigger id="logEvent" className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {eventItems.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="logRecipient" className="text-xs font-medium text-muted-foreground">
          Người nhận
        </label>
        <Select
          value={recipientId || "all"}
          onValueChange={(v) => updateParam("logRecipient", v === "all" ? "" : String(v))}
          items={recipientItems}
        >
          <SelectTrigger id="logRecipient" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {recipientItems.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="logStatus" className="text-xs font-medium text-muted-foreground">
          Trạng thái
        </label>
        <Select value={status || "all"} onValueChange={(v) => updateParam("logStatus", v === "all" ? "" : String(v))} items={statusItems}>
          <SelectTrigger id="logStatus" className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusItems.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {hasAnyFilter && (
        <Button variant="ghost" size="sm" onClick={() => router.replace(pathname)}>
          Xóa lọc
        </Button>
      )}
    </div>
  );
}
