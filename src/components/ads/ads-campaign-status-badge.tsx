// SHOPEE-ADS-UI-1: campaign status pill — centralized mapping
// (CAMPAIGN_STATUS), a distinct icon per status and always the label, so
// paused vs ended are told apart without colour.
// SHOPEE-ADS-1B: real raw statuses (ongoing / paused / ended / closed) map
// here; an unknown raw value shows neutrally with the raw text as a tooltip.
// Display only — the Ads module never changes a campaign status (read-only).
import { AlertTriangle, CircleHelp, CircleOff, CirclePause, CirclePlay, CircleStop, type LucideIcon } from "lucide-react";

import type { AdsCampaignStatus } from "@/lib/channels/shopee/ads/view-models";
import { StatusBadge } from "@/components/patterns/status-badge";

import { CAMPAIGN_STATUS } from "./metric-style";

const ICON: Record<AdsCampaignStatus, LucideIcon> = {
  active: CirclePlay,
  paused: CirclePause,
  ended: CircleStop,
  closed: CircleOff,
  warning: AlertTriangle,
  unknown: CircleHelp,
};

export function AdsCampaignStatusBadge({ status, raw }: { status: AdsCampaignStatus; raw?: string }) {
  const s = CAMPAIGN_STATUS[status];
  return (
    <StatusBadge tone={s.tone} icon={ICON[status]} title={raw ? `Shopee: ${raw}` : undefined} className={status === "ended" || status === "closed" ? "opacity-75" : undefined}>
      {status === "unknown" && raw ? raw : s.label}
    </StatusBadge>
  );
}
