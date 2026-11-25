"use client";

// PHASE 06 — per-user reminder preferences. The Zalo channels are stored as a wish
// only: nothing is sent while the global flags / kill switch keep them off.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/patterns/toast";
import { callApi } from "@/components/zalo-personal/api-client";

export interface Prefs {
  day_enabled: boolean;
  hour_enabled: boolean;
  overdue_enabled: boolean;
  morning_enabled: boolean;
  mention_enabled: boolean;
  confirmation_enabled: boolean;
  zalo_personal_enabled: boolean;
  zalo_oa_enabled: boolean;
}

const ROWS: Array<{ key: keyof Prefs; label: string; hint: string; external?: boolean }> = [
  { key: "day_enabled", label: "Nhắc trước hạn 24 giờ", hint: "Gửi bù nếu hệ thống trễ dưới 1 giờ." },
  { key: "hour_enabled", label: "Nhắc trước hạn 1 giờ", hint: "Gửi bù nếu trễ dưới 15 phút và chưa qua hạn." },
  { key: "overdue_enabled", label: "Cảnh báo quá hạn (sau hạn 5 phút)", hint: "Sau thời gian gián đoạn dài: một cảnh báo tổng hợp, không gửi hàng loạt." },
  { key: "morning_enabled", label: "Bản tin 08:00 mỗi ngày", hint: "Việc quá hạn và đến hạn hôm nay. Gửi bù nếu trước 10:00." },
  { key: "mention_enabled", label: "Khi tôi được nhắc tên trong nhóm", hint: "Chỉ khi tài khoản Zalo của bạn đã liên kết và bạn có quyền xem nhóm." },
  { key: "confirmation_enabled", label: "Khi có việc mới cần xác nhận", hint: "Chỉ dành cho người quản lý kết nối." },
  { key: "zalo_personal_enabled", label: "Cũng gửi qua Zalo cá nhân", hint: "Chưa khả dụng: hệ thống chưa có đường gửi tin đã xác minh.", external: true },
  { key: "zalo_oa_enabled", label: "Cũng gửi qua Zalo OA", hint: "Chưa khả dụng: cần điều kiện tương tác của Zalo OA.", external: true },
];

export function PreferencesForm({ initial }: { initial: Prefs }) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(initial);
  const [pending, startTransition] = useTransition();
  const save = () =>
    startTransition(async () => {
      const res = await callApi<Prefs>("/api/zalo-personal/reminders/preferences", { method: "PATCH", body: prefs });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Đã lưu cài đặt nhắc việc.");
      router.refresh();
    });

  return (
    <div className="grid max-w-2xl gap-3">
      {ROWS.map((r) => (
        <label key={r.key} className="flex items-start gap-3 rounded-lg border p-3">
          <input type="checkbox" className="mt-1" checked={prefs[r.key]} onChange={(e) => setPrefs((p) => ({ ...p, [r.key]: e.target.checked }))} />
          <span className="grid gap-0.5">
            <span className="font-medium">
              {r.label}
              {r.external && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">Sắp có</span>}
            </span>
            <span className="text-sm text-muted-foreground">{r.hint}</span>
          </span>
        </label>
      ))}
      <div>
        <Button disabled={pending} onClick={save}>
          Lưu cài đặt
        </Button>
      </div>
    </div>
  );
}
