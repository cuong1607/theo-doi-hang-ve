import { redirect } from "next/navigation";

export default async function AnalyticsIndex({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (v && ["period", "from", "to", "shop"].includes(k)) sp.set(k, v);
  redirect(`/shopee/analytics/products${sp.toString() ? `?${sp}` : ""}`);
}
