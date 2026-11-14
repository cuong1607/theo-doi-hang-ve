import { AppShell } from "@/components/app-shell/app-shell";

// APP-SHELL-1: "Phân tích Shopee" — Ads (read only), product analytics,
// shop connections. Navigation only: no Shopee call happens here.
export default function ShopeeLayout({ children }: { children: React.ReactNode }) {
  return <AppShell app="shopee">{children}</AppShell>;
}
