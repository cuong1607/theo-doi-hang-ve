import { requirePermission } from "@/lib/auth/session";
import { getProductAnalystConfig } from "@/lib/product-analyst/provider";
import { createAdminClient } from "@/lib/supabase/admin";
import { getZaloWebhookConfig } from "@/lib/zalo/webhook-handler";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";

import { ZaloAgentPanel } from "./zalo-agent-panel";

export const dynamic = "force-dynamic";

// SHOPEE-PRODUCT-ANALYTICS-1 (part B): link the admin's own Zalo account to
// the conversation agent and choose its shops. Not linked from navigation.
export default async function ZaloAgentPage() {
  const auth = await requirePermission("integration:manage");
  const db = createAdminClient();
  const [{ data: links }, { data: shops }, { data: access }] = await Promise.all([
    db.from("zalo_user_links").select("id, zalo_user_id, status, linked_at").eq("internal_user_id", auth.user.id).order("linked_at", { ascending: false }),
    db.from("shops").select("id, shop_name").eq("is_active", true).order("shop_name"),
    db.from("ai_user_shop_access").select("shop_id").eq("internal_user_id", auth.user.id),
  ]);
  const webhook = getZaloWebhookConfig();
  const analyst = getProductAnalystConfig();

  return (
    <PageContainer>
      <PageHeader title="Trợ lý Zalo (thử nghiệm)" description="Liên kết tài khoản Zalo của bạn với OA và chọn shop mà trợ lý được trả lời. Chỉ quản trị viên trong giai đoạn đầu." />
      <Callout tone={webhook.enabled ? "info" : "warning"} title={`Webhook: ${webhook.enabled ? "BẬT" : "TẮT"} · Chữ ký: ${webhook.oaSecretKey ? "đã cấu hình" : "CHƯA cấu hình"} · Phân tích AI: ${analyst.enabled ? "bật (chưa có provider)" : "TẮT"}`}>
        Trợ lý hiện chỉ xác nhận câu hỏi và trả lời &quot;Hệ thống phân tích sản phẩm đang được chuẩn bị.&quot; — chưa phân tích dữ liệu thật.
      </Callout>
      <ZaloAgentPanel
        links={(links ?? []).map((l) => ({ id: l.id as string, zaloUserId: `…${String(l.zalo_user_id).slice(-4)}`, status: l.status as string, linkedAt: l.linked_at as string }))}
        shops={(shops ?? []).map((s) => ({ id: s.id as string, name: s.shop_name as string }))}
        grantedShopIds={(access ?? []).map((a) => a.shop_id as string)}
      />
    </PageContainer>
  );
}
