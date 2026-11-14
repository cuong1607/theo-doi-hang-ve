import { AppShell } from "@/components/app-shell/app-shell";

// APP-SHELL-1: "Quản trị hệ thống" — admin only (app:system), hidden from the hub for other roles.
export default function SystemLayout({ children }: { children: React.ReactNode }) {
  return <AppShell app="system">{children}</AppShell>;
}
