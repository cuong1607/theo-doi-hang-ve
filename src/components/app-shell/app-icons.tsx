// APP-SHELL-1: registry icon keys → lucide-react (the project's only icon set).
import {
  Banknote,
  Bell,
  Bot,
  Box,
  Calculator,
  CalendarDays,
  ChartColumn,
  ChartNoAxesCombined,
  ClipboardList,
  FileText,
  HeartPulse,
  History,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutTemplate,
  Library,
  Lightbulb,
  ListChecks,
  Megaphone,
  PackagePlus,
  PackageSearch,
  Palette,
  PenLine,
  Receipt,
  Scale,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Siren,
  Store,
  Target,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  Video,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

import type { NavIconName } from "@/lib/apps/nav";
import type { AppIconName } from "@/lib/apps/registry";

export const APP_ICONS: Record<AppIconName, LucideIcon> = {
  warehouse: Warehouse,
  "store-chart": ChartNoAxesCombined,
  "shopping-cart": ShoppingCart,
  palette: Palette,
  megaphone: Megaphone,
  settings: Settings,
};

export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  "package-plus": PackagePlus,
  history: History,
  "package-search": PackageSearch,
  "file-text": FileText,
  wallet: Wallet,
  receipt: Receipt,
  box: Box,
  truck: Truck,
  calculator: Calculator,
  "shopping-bag": ShoppingBag,
  "trending-up": TrendingUp,
  undo: Undo2,
  scale: Scale,
  banknote: Banknote,
  megaphone: Megaphone,
  chart: ChartColumn,
  siren: Siren,
  bot: Bot,
  store: Store,
  "heart-pulse": HeartPulse,
  users: Users,
  bell: Bell,
  clipboard: ClipboardList,
  "list-checks": ListChecks,
  lightbulb: Lightbulb,
  image: ImageIcon,
  video: Video,
  library: Library,
  "layout-template": LayoutTemplate,
  target: Target,
  pen: PenLine,
  calendar: CalendarDays,
};

/** The app's icon on its two-hue gradient tile (needs a [data-app] ancestor). */
export function AppIconTile({ icon, size = "md", className = "" }: { icon: AppIconName; size?: "sm" | "md" | "lg"; className?: string }) {
  const Icon = APP_ICONS[icon];
  const box = size === "lg" ? "size-12 rounded-xl" : size === "md" ? "size-8 rounded-lg" : "size-6 rounded-md";
  const glyph = size === "lg" ? "size-6" : size === "md" ? "size-4" : "size-3.5";
  return (
    <span aria-hidden="true" className={`app-gradient inline-flex shrink-0 items-center justify-center text-white shadow-sm dark:text-background ${box} ${className}`}>
      <Icon className={glyph} />
    </span>
  );
}
