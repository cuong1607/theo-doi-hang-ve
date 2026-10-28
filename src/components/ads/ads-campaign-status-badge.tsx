// SHOPEE-ADS-UI-1: campaign status pill — centralized mapping
// (CAMPAIGN_STATUS), a distinct icon per status and always the label, so
// paused vs ended are told apart without colour.
import { AlertTriangle, CirclePause, CirclePlay, CircleStop, type LucideIcon } from "lucide-react";

import type { AdsCampaignStatus } from "@/lib/channels/shopee/ads/view-models";
import { StatusBadge } from "@/components/patterns/status-badge";

import { CAMPAIGN_STATUS } from "./metric-style";

const ICON: Record<AdsCampaignStatus, LucideIcon> = {
  active: CirclePlay,
  paused: CirclePause,
  ended: CircleStop,
  warning: AlertTriangle,
};

export function AdsCampaignStatusBadge({ status }: { status: AdsCampaignStatus }) {
  const s = CAMPAIGN_STATUS[status];
  return (
    <StatusBadge tone={s.tone} icon={ICON[status]} className={status === "ended" ? "opacity-75" : undefined}>
      {s.label}
    </StatusBadge>
  );
}
