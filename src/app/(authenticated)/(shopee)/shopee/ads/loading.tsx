import { AdsDashboardSkeleton } from "@/components/ads/ads-states";

// SHOPEE-ADS-UI-1: first load / route change — Ads-tinted skeleton shaped
// like the real dashboard (refreshes keep the old data on screen instead).
export default function Loading() {
  return <AdsDashboardSkeleton />;
}
