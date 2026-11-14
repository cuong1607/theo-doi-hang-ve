import type { Metadata } from "next";
import { LayoutGrid } from "lucide-react";

import { hubApps } from "@/lib/apps/registry";
import { loadShopeeConnectionSummary } from "@/lib/apps/status";
import { connectionSummaryText } from "@/lib/apps/sync-health";
import { createAdminClient } from "@/lib/supabase/admin";
import { shellUser } from "@/components/app-shell/app-shell";
import { HubCard, type HubCardStatus } from "@/components/app-shell/hub-card";
import { EmptyState } from "@/components/patterns/empty-state";

export const metadata: Metadata = { title: "Ứng dụng" };
export const dynamic = "force-dynamic";

// APP-SHELL-1: the workspace launcher — where every sign-in lands. Cards come
// from the registry, filtered by app access. The only data read is the
// Shopee connection count (2 tiny DB reads, no Shopee call, no analytics RPC).
export default async function AppHubPage() {
  const user = await shellUser();
  const apps = hubApps(user.role);
  const shopeeOpen = apps.some((a) => a.id === "shopee" && a.access === "open");
  const shopee = shopeeOpen ? await loadShopeeConnectionSummary(createAdminClient()) : null;

  const statusOf = (statusSource: string | null): HubCardStatus | null => {
    if (statusSource !== "shopee-connections" || !shopee) return null;
    const line = connectionSummaryText(shopee);
    const count = shopee.connected === shopee.shops ? `${shopee.shops} shop đang kết nối` : `${shopee.connected}/${shopee.shops} shop đang kết nối`;
    return { lines: shopee.shops ? [count, line.text] : [line.text], tone: line.tone };
  };

  const firstName = user.displayName.trim().split(/\s+/).at(-1) ?? user.displayName;
  const anyOpen = apps.some((a) => a.access === "open");

  return (
    <div className="space-y-8" data-ads-root>
      <div className="space-y-1.5 animate-ads-rise">
        <p className="text-sm font-medium text-app-accent-text">Xin chào, {firstName}</p>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Bạn muốn làm gì hôm nay?</h1>
        <p className="text-muted-foreground">Chọn một khu vực để bắt đầu</p>
      </div>

      {!anyOpen ? (
        <EmptyState icon={LayoutGrid} title="Bạn chưa được cấp quyền vào khu vực nào." description="Liên hệ quản trị viên để được cấp quyền." />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Ứng dụng">
          {apps.map((app, i) => (
            <li key={app.id} className="min-w-0">
              <HubCard app={app} index={i} status={statusOf(app.statusSource)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
