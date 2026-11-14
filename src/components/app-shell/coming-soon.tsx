// APP-SHELL-1: landing for an app that is planned but not built. It shows
// what the app will contain (its "soon" nav items) — no data, no metrics,
// no buttons that pretend to work.
import Link from "next/link";
import { ArrowLeft, Sparkles } from "lucide-react";

import { APP_NAV } from "@/lib/apps/nav";
import { APP_HUB_PATH, getApp, type AppId } from "@/lib/apps/registry";

import { AppIconTile, NAV_ICONS } from "./app-icons";

export function ComingSoonLanding({ app: appId }: { app: AppId }) {
  const app = getApp(appId);
  const planned = APP_NAV[appId].flatMap((g) => g.items).filter((i) => i.soon);
  return (
    <div className="mx-auto max-w-3xl space-y-6" data-ads-root data-coming-soon={appId}>
      <section className="app-wash animate-ads-rise rounded-2xl border p-6 text-center md:p-10">
        <AppIconTile icon={app.icon} size="lg" className="mx-auto" />
        <p className="mt-4 text-xs font-semibold tracking-wide text-app-accent-text uppercase">{app.subtitle}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">{app.name}</h2>
        <p className="mx-auto mt-2 max-w-md text-muted-foreground">{app.description}</p>
        <p className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-sm font-medium text-muted-foreground">
          <Sparkles aria-hidden="true" className="size-4" /> Đang phát triển — chưa có chức năng
        </p>
      </section>
      <section aria-labelledby="planned-title" className="space-y-3">
        <h2 id="planned-title" className="text-base font-semibold">
          Dự kiến gồm
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {planned.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            return (
              <li key={item.href} className="flex items-center gap-3 rounded-xl border border-dashed bg-muted/30 p-4">
                <span aria-hidden="true" className="inline-flex size-9 items-center justify-center rounded-lg bg-app-accent-soft text-app-accent-text">
                  <Icon className="size-4.5" />
                </span>
                <span className="font-medium">{item.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">Sắp có</span>
              </li>
            );
          })}
        </ul>
      </section>
      <Link href={APP_HUB_PATH} className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
        <ArrowLeft aria-hidden="true" className="size-4" /> Tất cả ứng dụng
      </Link>
    </div>
  );
}
