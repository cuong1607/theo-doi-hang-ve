import { AppShell } from "@/components/app-shell/app-shell";

// APP-SHELL-1: "Gọi hàng" — shell + landing only until the app is built.
export default function PurchasingLayout({ children }: { children: React.ReactNode }) {
  return <AppShell app="purchasing">{children}</AppShell>;
}