import { AppShell } from "@/components/app-shell/app-shell";

// ZALO PERSONAL Phase 03: "Trợ lý Zalo AI" (Zalo cá nhân). Navigation only — every
// page checks the flag, the role and the data scope itself (requireZaloPersonal).
// No AI, no sending, no Zalo call happens here: the dashboard only reads what the
// Phase 02 ingestion stored, plus governed group-mode / access changes.
export default function ZaloLayout({ children }: { children: React.ReactNode }) {
  return <AppShell app="zalo">{children}</AppShell>;
}
