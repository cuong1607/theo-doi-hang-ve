import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bot, ChartColumn, HeartPulse, Megaphone, ShieldCheck, Siren, Store, type LucideIcon } from "lucide-react";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { loadShopeeSyncHealth } from "@/lib/apps/status";
import { SYNC_STATE_LABEL, type ShopSyncHealth, type SyncState } from "@/lib/apps/sync-health";
import { getShopeeFlags } from "@/lib/feature-flags";
import { webAssistantAvailable } from "@/lib/product-analyst/access";
import { PRODUCT_SIGNAL_THRESHOLDS } from "@/lib/product-analytics/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { AppIconTile } from "@/components/app-shell/app-icons";
import { EmptyState } from "@/components/patterns/empty-state";

export const metadata: Metadata = { title: "Phân tích Shopee" };
export const dynamic = "force-dynamic";

// APP-SHELL-1: Shopee app landing. Entry cards + a sync-health summary built
// from what the database already records (connections, Ads / sales
// freshness). Never duplicates the Ads dashboard, never calls Shopee, no AI.
export default async function ShopeeAppPage() {
  const auth = await requirePermission("app:shopee");
  const role = auth.profile.role;
  const flags = getShopeeFlags();
  const health = hasPermission(role, "channel:view") ? await loadShopeeSyncHealth(createAdminClient()) : null;
  const shops = health?.length ?? 0;
  const connected = health?.filter((h) => h.connected).length ?? 0;
  const attention = health?.filter((h) => h.attention).length ?? 0;

  const entries: Array<{ title: string; description: string; href: string; icon: LucideIcon; soon?: string }> = [];
  if (flags.adsEnabled && hasPermission(role, "channel:view")) {
    entries.push(
      { title: "Quảng cáo", description: "Chi tiêu, doanh số, ROAS và chiến dịch theo ngày / giờ (chỉ đọc).", href: "/shopee/ads", icon: Megaphone },
      { title: "Phân tích sản phẩm", description: "Doanh số từng sản phẩm cạnh số liệu Ads, sức khỏe và tín hiệu.", href: "/shopee/product-analytics", icon: ChartColumn },
      { title: "Sản phẩm cần chú ý", description: "Sản phẩm Cần theo dõi / Yếu, xếp theo mức ưu tiên.", href: "/shopee/product-analytics?health=ATTENTION", icon: Siren },
    );
  }
  if (hasPermission(role, "channel:manage")) entries.push({ title: "Kết nối shop", description: "Kết nối thêm shop, kết nối lại hoặc ngắt kết nối.", href: "/settings/shopee", icon: Store });
  // PA-4: live for the rollout roles once AI_PRODUCT_ANALYST_ENABLED + _WEB_ENABLED are on
  entries.push(webAssistantAvailable(role) ? { title: "Trợ lý phân tích", description: "Hỏi đáp về sản phẩm và quảng cáo, có bằng chứng và độ tin cậy.", href: "/apps/shopee/ai", icon: Bot } : { title: "Trợ lý phân tích", description: "Hỏi đáp về sản phẩm và quảng cáo bằng AI.", href: "", icon: Bot, soon: "Sắp có" });

  return (
    <div className="space-y-8" data-ads-root>
      <section className="app-wash animate-ads-rise rounded-2xl border p-5 md:p-6" aria-labelledby="shopee-hero-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <AppIconTile icon="store-chart" size="lg" />
          <div className="min-w-0 flex-1 space-y-1">
            <h2 id="shopee-hero-title" className="text-xl font-bold tracking-tight md:text-2xl">
              Phân tích Shopee
            </h2>
            <p className="text-sm text-muted-foreground">Quảng cáo và hiệu quả sản phẩm của các shop Shopee — dữ liệu đồng bộ tự động, chỉ đọc.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {health && (
            <Chip tone={connected === shops ? "ok" : "warning"}>
              {connected === shops ? `${shops} shop đang kết nối` : `${connected}/${shops} shop đang kết nối`}
            </Chip>
          )}
          {health && shops > 0 && <Chip tone={attention ? "warning" : "ok"}>{attention ? `${attention} shop cần kiểm tra đồng bộ` : "Đồng bộ bình thường"}</Chip>}
          <Chip tone="muted">
            <ShieldCheck aria-hidden="true" className="size-3.5" /> Quảng cáo: chỉ đọc, không chỉnh chiến dịch
          </Chip>
        </div>
      </section>

      <section aria-labelledby="shopee-entries" className="space-y-3">
        <h2 id="shopee-entries" className="text-base font-semibold">
          Bắt đầu
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {entries.map((e, i) => (
            <li key={e.title} className="min-w-0 animate-ads-rise" style={{ "--ads-delay": `${60 + i * 40}ms` } as React.CSSProperties}>
              <EntryCard {...e} />
            </li>
          ))}
        </ul>
      </section>

      <section id="suc-khoe-dong-bo" aria-labelledby="sync-health-title" className="scroll-mt-20 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sync-health-title" className="flex items-center gap-2 text-base font-semibold">
            <HeartPulse aria-hidden="true" className="size-4 text-app-accent-text" /> Sức khỏe đồng bộ
          </h2>
          <p className="text-xs text-muted-foreground">
            Chậm khi Ads quá {PRODUCT_SIGNAL_THRESHOLDS.adsStaleMinutes} phút, doanh số quá {PRODUCT_SIGNAL_THRESHOLDS.salesStaleMinutes} phút chưa cập nhật.
          </p>
        </div>
        {!health ? (
          <EmptyState icon={HeartPulse} title="Chưa đọc được trạng thái đồng bộ" description="Thử tải lại trang sau ít phút." />
        ) : health.length === 0 ? (
          <EmptyState icon={Store} title="Chưa kết nối shop Shopee nào" description="Quản trị viên có thể kết nối shop trong mục Kết nối shop." />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {health.map((h) => (
              <ShopHealthCard key={h.shopId} h={h} />
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Trang này chỉ đọc cơ sở dữ liệu — mở trang không gọi Shopee.</p>
      </section>
    </div>
  );
}

const TONE_CLASS = {
  ok: "bg-success-soft text-success-text",
  warning: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
  muted: "bg-muted text-muted-foreground",
} as const;

function Chip({ tone, children }: { tone: keyof typeof TONE_CLASS; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

function EntryCard({ title, description, href, icon: Icon, soon }: { title: string; description: string; href: string; icon: LucideIcon; soon?: string }) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span aria-hidden="true" className="inline-flex size-9 items-center justify-center rounded-lg bg-app-accent-soft text-app-accent-text">
          <Icon className="size-4.5" />
        </span>
        {soon ? (
          <span className="rounded-full border border-dashed px-2 py-0.5 text-xs font-medium text-muted-foreground">{soon}</span>
        ) : (
          <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform duration-(--ads-dur-normal) group-hover:translate-x-0.5 group-hover:text-app-accent-text" />
        )}
      </div>
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </>
  );
  const shared = "flex h-full flex-col gap-3 rounded-xl border p-4";
  if (soon) {
    return (
      <div aria-disabled="true" data-entry-soon="" className={`${shared} border-dashed bg-muted/30 opacity-75`}>
        {inner}
      </div>
    );
  }
  return (
    <Link href={href} className={`${shared} app-card group bg-card outline-none focus-visible:ring-2 focus-visible:ring-app-accent`}>
      {inner}
    </Link>
  );
}

function ago(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} giờ trước`;
  return `${Math.round(minutes / 1440)} ngày trước`;
}

const STATE_TONE: Record<SyncState, keyof typeof TONE_CLASS> = { ok: "ok", stale: "warning", none: "muted", off: "muted" };

function ShopHealthCard({ h }: { h: ShopSyncHealth }) {
  const rows: Array<{ label: string; tone: keyof typeof TONE_CLASS; value: string; detail?: string }> = [
    { label: "Kết nối", tone: h.connected ? "ok" : "danger", value: h.connected ? "Đã kết nối" : h.connectionStatus ? "Cần kết nối lại" : "Chưa kết nối" },
    { label: "Quảng cáo", tone: STATE_TONE[h.ads], value: h.ads === "off" ? "Dữ liệu mẫu" : h.ads === "none" ? "Chưa có dữ liệu hôm nay" : SYNC_STATE_LABEL[h.ads], detail: ago(h.adsMinutes) },
    { label: "Doanh số sản phẩm", tone: STATE_TONE[h.sales], value: SYNC_STATE_LABEL[h.sales], detail: ago(h.salesMinutes) },
  ];
  return (
    <li className="min-w-0 rounded-xl border bg-card p-4" data-shop-health={h.attention ? "attention" : "ok"}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="truncate font-semibold" title={h.shopName}>
          {h.shopName}
        </p>
        {h.attention && <Chip tone="warning">Cần kiểm tra</Chip>}
      </div>
      <dl className="space-y-2 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="flex items-center gap-2">
              {r.detail && <span className="text-xs text-muted-foreground">{r.detail}</span>}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[r.tone]}`}>{r.value}</span>
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
