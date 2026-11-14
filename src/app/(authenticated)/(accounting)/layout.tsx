import { AppShell } from "@/components/app-shell/app-shell";

// APP-SHELL-1: "Theo dõi hàng về" (Kế toán & vận hành). The retired Shopee
// accounting pages also live in this group; the proxy keeps redirecting them
// while SHOPEE_LEGACY_MODULES_ENABLED is off (and the nav hides them).
export default function AccountingLayout({ children }: { children: React.ReactNode }) {
  return <AppShell app="accounting">{children}</AppShell>;
}
