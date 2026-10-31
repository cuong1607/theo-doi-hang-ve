// PRODUCT-ANALYTICS-2: small presentational pieces shared by the list and the detail page.
import { cn } from "cn";

import { AdsProductThumb } from "@/components/ads/ads-product-thumb";

export function ProductThumb({ url, size = "sm", alt = "" }: { url: string | null; size?: "sm" | "lg"; alt?: string }) {
  return <AdsProductThumb src={url} alt={alt} size={size} />;
}

/** "+12,3 %" / "−8 %" / "—"; colour is never the only signal (sign + arrow). `neutral`: spend going up is not "good" or "bad". */
export function DeltaText({ pct, neutral = false, className }: { pct: number | null | undefined; neutral?: boolean; className?: string }) {
  if (pct === null || pct === undefined) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const up = pct > 0;
  const tone = neutral || pct === 0 ? "text-muted-foreground" : up ? "text-success-text" : "text-danger-text";
  const text = `${up ? "▲ +" : pct < 0 ? "▼ −" : ""}${Math.abs(pct).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} %`;
  return <span className={cn("tabular-nums text-xs", tone, className)}>{text}</span>;
}
