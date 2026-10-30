"use client";

// SHOPEE-ADS-3A.2 product thumbnail. Only a verified image URL (stable
// https://cf.shopee.vn/file/<id>, stored by the enrichment job) is rendered;
// anything missing or failing to load falls back to a neutral icon in the
// SAME fixed square, so a broken image never moves the row layout.
// ADS-3A.2.1: when the server derived a small `_tn` variant it is tried first;
// if it fails the original URL is tried once, then the icon (no retry loop).
// Plain <img loading="lazy">: the CDN already serves the image — no Next
// image-optimizer proxy, no remote host wildcard in next.config.
import { useEffect, useRef, useState } from "react";
import { Package } from "lucide-react";
import { cn } from "cn";
import { adsThumbnailSources } from "@/lib/channels/shopee/ads/mapper";

export function AdsProductThumb({ src, thumbSrc, alt, size = "sm", className }: { src?: string | null; thumbSrc?: string | null; alt: string; size?: "sm" | "lg"; className?: string }) {
  const sources = adsThumbnailSources(thumbSrc, src);
  const chain = sources.join(" ");
  const [attempt, setAttempt] = useState({ chain, index: 0 });
  // new sources (e.g. after a refresh) restart the chain
  const index = attempt.chain === chain ? attempt.index : 0;
  const img = useRef<HTMLImageElement>(null);
  const current = sources[index];
  const fail = () => setAttempt({ chain, index: index + 1 });
  // a server-rendered image can fail before hydration attaches onError: check once mounted
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setAttempt({ chain, index: index + 1 });
  }, [chain, index]);
  const box = size === "lg" ? "size-12" : "size-9";
  const px = size === "lg" ? 48 : 36;
  return (
    <span
      data-slot="ads-product-thumb"
      data-state={current ? "image" : "fallback"}
      data-source={current ? (current === thumbSrc ? "thumbnail" : "original") : "icon"}
      className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-ads-border bg-ads-surface-strong", box, className)}
    >
      {current ? (
        // eslint-disable-next-line @next/next/no-img-element -- fixed-size CDN thumbnail, see header
        <img key={current} ref={img} src={current} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" width={px} height={px} onError={fail} className="size-full object-cover" />
      ) : (
        <Package aria-hidden="true" className={cn("text-ads-accent", size === "lg" ? "size-5" : "size-4")} />
      )}
    </span>
  );
}
