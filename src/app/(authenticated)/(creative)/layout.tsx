import { AppShell } from "@/components/app-shell/app-shell";

// APP-SHELL-1: "Thiết kế ảnh & video" — shell + landing only until the app is built.
export default function CreativeLayout({ children }: { children: React.ReactNode }) {
  return <AppShell app="creative">{children}</AppShell>;
}