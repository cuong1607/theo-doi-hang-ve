import type { Metadata } from "next";
import Link from "next/link";
import { Bot, ShieldCheck, Store } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { SupabaseConversationStore } from "@/lib/conversation/supabase-store";
import { webAssistantAvailable } from "@/lib/product-analyst/access";
import { getProductAnalystConfig } from "@/lib/product-analyst/config";
import { minutesSince } from "@/lib/product-analytics/display";
import { loadShopFreshness } from "@/lib/product-analytics/read-model";
import { createAdminClient } from "@/lib/supabase/admin";
import { AppIconTile } from "@/components/app-shell/app-icons";
import { EmptyState } from "@/components/patterns/empty-state";

import { AssistantChat, type ChatMessage, type ChatPeriod } from "./assistant-chat";

export const metadata: Metadata = { title: "Trợ lý phân tích" };
export const dynamic = "force-dynamic";

const PERIODS: readonly ChatPeriod[] = ["today", "yesterday", "7d", "30d"];

// PRODUCT-ANALYTICS-4: the web Product Analyst inside the Shopee app.
// URL = context (?shop, ?product, ?period), validated here against the user's
// shop grants and the product's shop. Opening the page never calls the model.
export default async function ShopeeAssistantPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requirePermission("app:shopee");
  const config = getProductAnalystConfig();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  if (!webAssistantAvailable(auth.profile.role, config)) {
    return (
      <Shell>
        <EmptyState
          icon={Bot}
          title={config.webEnabled ? "Trợ lý phân tích đang mở cho quản trị viên trước" : "Trợ lý phân tích sắp có"}
          description={config.webEnabled ? "Tài khoản của bạn chưa nằm trong nhóm dùng thử." : "Tính năng đang được kiểm thử và chưa bật."}
          action={
            <Link href="/apps/shopee" className="text-sm font-medium text-app-accent-text hover:underline">
              Về tổng quan Shopee
            </Link>
          }
        />
      </Shell>
    );
  }

  const db = createAdminClient();
  const store = new SupabaseConversationStore(db);
  const shops = await store.allowedShops(auth.user.id);
  if (!shops.length) {
    return (
      <Shell>
        <EmptyState
          icon={Store}
          title="Bạn chưa chọn shop nào cho trợ lý"
          description="Chọn shop mà trợ lý được phân tích cho bạn (mặc định không có shop nào)."
          action={
            <Link href="/settings/zalo-agent" className="text-sm font-medium text-app-accent-text hover:underline">
              Chọn shop cho trợ lý
            </Link>
          }
        />
      </Shell>
    );
  }

  const shopId = shops.find((s) => s.id === one("shop"))?.id ?? shops[0].id;
  const period = (PERIODS as readonly string[]).includes(one("period") ?? "") ? (one("period") as ChatPeriod) : "7d";
  let product: { id: string; name: string | null; sku: string | null; itemId: string } | null = null;
  const productParam = one("product");
  if (productParam && /^[0-9a-f-]{36}$/i.test(productParam)) {
    const { data } = await db.from("shopee_products").select("id, name, sku, provider_item_id").eq("id", productParam).eq("shop_id", shopId).maybeSingle<{ id: string; name: string | null; sku: string | null; provider_item_id: string }>();
    if (data) product = { id: data.id, name: data.name, sku: data.sku, itemId: data.provider_item_id };
  }

  const [{ data: conv }, freshness] = await Promise.all([
    db.from("ai_conversations").select("id").eq("channel", "web").eq("external_user_id", auth.user.id).maybeSingle<{ id: string }>(),
    loadShopFreshness(db, [shopId]).catch(() => null),
  ]);
  const thread = conv ? await store.threadMessages(conv.id, 30) : [];
  const initialMessages: ChatMessage[] = thread.map((m) => ({ id: m.id, role: m.direction === "inbound" ? "user" : "assistant", text: m.text, analysis: m.analysis, failed: m.status === "failed" }));
  const f = freshness?.get(shopId);
  const now = new Date();
  const ago = (iso: string | null | undefined) => {
    const m = minutesSince(iso, now);
    return m === null ? "chưa có" : m < 60 ? `${m} phút trước` : `${Math.round(m / 60)} giờ trước`;
  };
  const freshnessText = f ? `Dữ liệu: doanh số cập nhật ${ago(f.sales_last_success_at)} · Ads cập nhật ${ago(f.ads_campaign_today_at)}` : null;

  return (
    <Shell>
      <AssistantChat key={`${shopId}:${product?.id ?? "-"}:${period}`} shops={shops} shopId={shopId} product={product} period={period} initialMessages={initialMessages} freshness={freshnessText} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4" data-ads-root>
      <header className="flex items-start gap-3">
        <AppIconTile icon="store-chart" />
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-lg font-bold tracking-tight">Trợ lý phân tích</h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck aria-hidden="true" className="size-3.5" /> Chỉ đọc dữ liệu đã đồng bộ · tách dữ kiện và giả thuyết · không thay đổi gì trên Shopee
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}
