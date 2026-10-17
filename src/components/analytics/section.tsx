// SHOPEE-8: one dashboard section = one card with its own data load. A
// failing section renders its own error (retry), never blanking the page;
// each section sits in its own <Suspense> so a slow query blocks only itself.
import { cn } from "cn";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { SectionRetry } from "./section-retry";

export function AnalyticsSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

/** Runs a section's loader; logs + returns null on failure (the caller renders <SectionFailed>). */
export async function loadSection<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    console.error(JSON.stringify({ source: "analytics", section: name, message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return { ok: false };
  }
}

export function SectionFailed({ title }: { title: string }) {
  return (
    <AnalyticsSection title={title}>
      <SectionRetry />
    </AnalyticsSection>
  );
}
