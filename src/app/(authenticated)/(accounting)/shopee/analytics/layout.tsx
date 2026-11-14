import { Suspense } from "react";

import { requirePermission } from "@/lib/auth/session";
import { AnalyticsTabs } from "@/components/analytics/analytics-tabs";
import { PageContainer } from "@/components/patterns/page-header";

export default async function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("channel:view");
  return (
    <PageContainer>
      <Suspense fallback={<div className="h-10 border-b" />}>
        <AnalyticsTabs />
      </Suspense>
      {children}
    </PageContainer>
  );
}
