"use client";

import { useState, useTransition } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/patterns/callout";
import { LoadingButton } from "@/components/patterns/loading-button";
import { StatusBadge } from "@/components/patterns/status-badge";

import { createMyZaloLinkCode, revokeMyZaloLink, setMyAgentShops } from "./actions";

export function ZaloAgentPanel({
  links,
  shops,
  grantedShopIds,
}: {
  links: Array<{ id: string; zaloUserId: string; status: string; linkedAt: string }>;
  shops: Array<{ id: string; name: string }>;
  grantedShopIds: string[];
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [selected, setSelected] = useState(new Set(grantedShopIds));
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setMessage({ tone: r.ok ? "success" : "danger", text: r.message });
    });

  return (
    <div className="space-y-6">
      {message && <Callout tone={message.tone} title={message.text} />}

      <section className="space-y-2 rounded-lg border p-4" aria-label="Liên kết Zalo">
        <h2 className="font-medium">1. Liên kết tài khoản Zalo</h2>
        <p className="text-sm text-muted-foreground">Tạo mã, rồi nhắn cho OA đúng nội dung: LINK &lt;mã&gt;. Mã dùng 1 lần, hết hạn sau 10 phút.</p>
        <LoadingButton
          loading={pending}
          icon={<KeyRound aria-hidden="true" />}
          onClick={() =>
            start(async () => {
              const r = await createMyZaloLinkCode();
              if (r.ok) setCode({ code: r.code, expiresAt: r.expiresAt });
              else setMessage({ tone: "danger", text: r.message });
            })
          }
        >
          Tạo mã liên kết
        </LoadingButton>
        {code && (
          <p className="text-sm">
            Gửi cho OA: <code className="rounded bg-muted px-2 py-1 font-mono text-base">LINK {code.code}</code> · hết hạn {new Date(code.expiresAt).toLocaleTimeString("vi-VN")}
          </p>
        )}
        <ul className="space-y-1 text-sm">
          {links.map((l) => (
            <li key={l.id} className="flex items-center gap-2">
              <span className="font-mono">Zalo {l.zaloUserId}</span>
              <StatusBadge tone={l.status === "active" ? "success" : "neutral"}>{l.status === "active" ? "đang liên kết" : "đã thu hồi"}</StatusBadge>
              {l.status === "active" && (
                <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => revokeMyZaloLink({ linkId: l.id }))}>
                  Thu hồi
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2 rounded-lg border p-4" aria-label="Quyền shop">
        <h2 className="font-medium">2. Shop trợ lý được trả lời cho bạn</h2>
        <p className="text-sm text-muted-foreground">Mặc định không có shop nào. Câu hỏi về shop chưa chọn sẽ bị từ chối.</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {shops.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(s.id);
                  else next.delete(s.id);
                  setSelected(next);
                }}
              />
              {s.name}
            </label>
          ))}
        </div>
        <Button size="sm" disabled={pending} onClick={() => run(() => setMyAgentShops({ shopIds: [...selected] }))}>
          Lưu quyền shop
        </Button>
      </section>
    </div>
  );
}
