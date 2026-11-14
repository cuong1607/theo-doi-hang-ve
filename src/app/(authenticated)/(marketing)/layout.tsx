import { AppShell } from "@/components/app-shell/app-shell";

// APP-SHELL-1: "Marketing" — shell + landing only until the app is built.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <AppShell app="marketing">{children}</AppShell>;
}