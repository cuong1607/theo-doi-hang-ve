import type { Metadata } from "next";
import { Gauge } from "lucide-react";
import { redirect } from "next/navigation";

import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { AskPanel } from "@/components/zalo-personal/ai/ask-panel";
import { MemoryPanel } from "@/components/zalo-personal/ai/memory-panel";
import { formatDateTime } from "@/lib/ui/format";
import { requireZaloPersonalAi } from "@/lib/zalo-personal/ai/server";
import { aiStatus, getUsage, listSessions, type AiStatusView } from "@/lib/zalo-personal/ai/service";
import { vnDate } from "@/lib/zalo-personal/dashboard/contracts";
import { unwrap } from "@/lib/zalo-personal/dashboard/server";
import { listConversations } from "@/lib/zalo-personal/dashboard/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Hỏi AI" };
export const dynamic = "force-dynamic";

const UNAVAILABLE: Record<string, string> = {
  ai_disabled: "AI đang tắt (AI_ENABLED=false). Bạn vẫn hỏi được: hệ thống tìm và hiển thị tin liên quan, nhưng không có câu trả lời của AI.",
  feature_disabled: "Hỏi AI cho Zalo cá nhân đang tắt (ZALO_PERSONAL_AI_ENABLED=false). Bạn vẫn hỏi được: hệ thống chỉ hiển thị tin liên quan.",
  config_missing: "AI chưa được cấu hình (GEMINI_API_KEY / GEMINI_MODEL). Hệ thống chỉ hiển thị tin liên quan.",
  model_invalid: "GEMINI_MODEL không hợp lệ. Hệ thống chỉ hiển thị tin liên quan.",
};
const SHARING: Record<string, string> = {
  policy_none: "Chính sách dữ liệu đang chặn gửi hội thoại thật tới AI (AI_DATA_SHARING_POLICY=none). Hệ thống chỉ tìm và hiển thị tin liên quan.",
  free_tier_not_approved: "Gemini đang ở gói miễn phí và chưa có phê duyệt gửi hội thoại thật (AI_FREE_TIER_DATA_APPROVED). Hệ thống chỉ tìm và hiển thị tin liên quan.",
};

function disabledReason(s: AiStatusView): string | null {
  if (s.unavailable) return UNAVAILABLE[s.unavailable] ?? null;
  if (s.sharing !== "allowed") return SHARING[s.sharing] ?? null;
  return null;
}

// AI-12: Ask AI over the Zalo Personal conversations the user may read. Separate from the
// Web assistant (/apps/shopee/ai) and from the OA: its sessions live in ai_assistant_sessions.
export default async function ZaloPersonalAiPage() {
  const { actor, deps, dashboardDeps } = await requireZaloPersonalAi();
  const [status, usage, sessions, conversations] = await Promise.all([aiStatus(deps, actor), getUsage(deps, actor), listSessions(deps, actor, 20), listConversations(dashboardDeps, actor, { page: 1, size: 100 })]);
  if (!status.ok) redirect("/forbidden");
  const s = status.data;
  const convs = unwrap(conversations).rows.filter((c) => c.messageCount > 0);
  const u = usage.ok ? usage.data : null;
  const today = new Date();
  const lastMessage = convs.map((c) => c.lastMessageAt).filter((v): v is string => !!v).sort().at(-1) ?? null;

  return (
    <PageContainer>
      <PageHeader
        title="Hỏi AI"
        description="Hỏi về các hội thoại Zalo cá nhân bạn được phép xem. Mỗi câu trả lời kèm tin nguồn. AI không gửi tin Zalo và không xem lịch sử Web / OA."
        meta={
          <>
            <span>
              AI: {s.provider === "fake" ? "giả lập (demo, không gọi AI thật)" : `Gemini · ${s.model ?? "chưa cấu hình"} · gói ${s.tier === "paid" ? "trả phí" : "miễn phí"}`}
              {s.redacted ? " · che dữ liệu nhạy cảm" : ""}
            </span>
            <span>Tin gần nhất đã đồng bộ: {formatDateTime(lastMessage)}</span>
          </>
        }
      />
      {u && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-4 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Gauge aria-hidden="true" className="size-3.5" />
            Hạn mức hôm nay
          </span>
          <span>
            Bạn: {u.own.calls}/{u.limits.perUserPerDay} lượt gọi AI
          </span>
          {u.global && (
            <span>
              Toàn hệ thống: {u.global.calls}/{u.limits.perDay} · token vào {u.global.inputTokens.toLocaleString("vi-VN")} / ra {u.global.outputTokens.toLocaleString("vi-VN")}
              {u.global.calls > 0 && u.global.confirmedCalls < u.global.calls ? " (một phần là ước tính)" : ""}
            </span>
          )}
          <span>Dùng lại kết quả: {u.own.cacheHits}</span>
          {Object.keys(u.own.reasons).length > 0 && <span>Lý do không gọi / lỗi: {Object.entries(u.own.reasons).map(([k, v]) => `${k} ${v}`).join(", ")}</span>}
          {u.budget !== "ok" && <span className="font-medium text-warning-text">{u.budget === "cooldown" ? "AI tạm dừng do nhà cung cấp báo hết quota" : u.budget === "exhausted" ? "Đã hết hạn mức" : "Sắp hết hạn mức"}</span>}
        </div>
      )}
      {convs.length === 0 && <Callout tone="info">Chưa có hội thoại nào có tin nhắn trong phạm vi bạn được phép xem.</Callout>}
      <AskPanel conversations={convs.map((c) => ({ id: c.id, title: c.title }))} initialSessions={sessions.ok ? sessions.data : []} defaultFrom={vnDate(new Date(today.getTime() - 6 * 86_400_000))} defaultTo={vnDate(today)} disabledReason={disabledReason(s)} />
      <section className="space-y-3 pt-4" aria-label="Tóm tắt và ghi nhớ">
        <h2 className="text-base font-semibold">Tóm tắt &amp; ghi nhớ</h2>
        <MemoryPanel conversations={convs.map((c) => ({ id: c.id, title: c.title }))} defaultFrom={vnDate(new Date(today.getTime() - 6 * 86_400_000))} defaultTo={vnDate(today)} />
      </section>
    </PageContainer>
  );
}
