import type { Metadata } from "next";
import { Gauge } from "lucide-react";
import { redirect } from "next/navigation";

import { AssistantPanel } from "@/components/ai-system/assistant-panel";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { loadActor } from "@/lib/ai-system/identity";
import { getSystemAssistantDeps, requireSystemAssistantPage, systemUsageToday } from "@/lib/ai-system/server";
import { buildStatus, type SystemAssistantStatus } from "@/lib/ai-system/status";

export const metadata: Metadata = { title: "Trợ lý hệ thống" };
export const dynamic = "force-dynamic";

const UNAVAILABLE: Record<string, string> = {
  ai_disabled: "AI đang tắt (AI_ENABLED=false).",
  config_missing: "AI chưa được cấu hình (GEMINI_API_KEY / GEMINI_MODEL).",
  model_invalid: "GEMINI_MODEL không hợp lệ.",
};
const DATA_POLICY: Record<SystemAssistantStatus["dataToModel"], string | null> = {
  allowed: null,
  policy_none: "Chính sách dữ liệu đang chặn gửi dữ liệu nghiệp vụ tới AI (AI_DATA_SHARING_POLICY=none).",
  free_tier_not_approved: "Gemini đang ở gói miễn phí và chưa có phê duyệt gửi dữ liệu nghiệp vụ (AI_FREE_TIER_DATA_APPROVED).",
  redacted_only: "Chính sách dữ liệu chỉ cho gửi dữ liệu đã che; số liệu nghiệp vụ không được gửi tới AI.",
};

function notice(s: SystemAssistantStatus): string | null {
  const why = s.model.unavailable ? UNAVAILABLE[s.model.unavailable] : DATA_POLICY[s.dataToModel];
  return why ? `${why} Trợ lý vẫn trả lời: chọn dữ liệu theo quy tắc và trình bày nguyên văn số liệu từ hệ thống (không qua AI).` : null;
}

// PHASE 05 — Central AI System Assistant. Separate from the Product Analyst (/apps/shopee/ai)
// and from Zalo Personal "Hỏi AI": nothing is stored as a conversation, nothing is sent.
export default async function SystemAssistantPage() {
  const auth = await requireSystemAssistantPage();
  const deps = getSystemAssistantDeps();
  const who = await loadActor(deps.store, auth.user.id);
  if (who.status !== "resolved") redirect("/account-disabled");
  const status = buildStatus({ aiConfig: deps.aiConfig, config: deps.config, registry: deps.registry, actor: who.actor, modelCallsToday: await systemUsageToday(deps, auth.user.id) });
  const suggestions = [...new Set(status.tools.filter((t) => t.module !== "knowledge").flatMap((t) => t.examples.slice(0, 1)))].slice(0, 6);

  return (
    <PageContainer>
      <PageHeader
        title="Trợ lý hệ thống"
        description="Hỏi bằng tiếng Việt về hàng về, công nợ nhà cung cấp và Shopee. Trợ lý chỉ đọc dữ liệu bạn được phép xem, ghi rõ nguồn và thời điểm cập nhật; không tạo / sửa / xóa / thanh toán, không gửi tin."
        meta={
          <>
            <span>AI: {status.model.provider === "fake" ? "giả lập (demo, không gọi AI thật)" : `Gemini · ${status.model.name ?? "chưa cấu hình"} · gói ${status.model.tier === "paid" ? "trả phí" : "miễn phí"}`}</span>
            <span>Bạn được hỏi: {status.tools.map((t) => t.title).join(", ") || "chưa có loại dữ liệu nào"}</span>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-4 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Gauge aria-hidden="true" className="size-3.5" />
          Hạn mức
        </span>
        <span>
          Lượt gọi AI hôm nay của bạn: {status.usage.modelCallsToday}/{status.usage.perUserPerDay} (dùng chung với Hỏi AI Zalo)
        </span>
        <span>Tối đa {status.limits.maxToolCalls} nguồn dữ liệu / câu hỏi · {status.limits.requestsPerMinute} câu hỏi / phút</span>
      </div>
      <AssistantPanel suggestions={suggestions} disabledNotice={notice(status)} />
    </PageContainer>
  );
}
