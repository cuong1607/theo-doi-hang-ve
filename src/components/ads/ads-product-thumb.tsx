"use client";

// SHOPEE-ADS-3A.2 product thumbnail. Only a verified image URL (stable
// https://cf.shopee.vn/file/<id>, stored by the enrichment job) is rendered;
// anything missing or failing to load falls back to a neutral icon in the
// SAME fixed square, so a broken image never moves the row layout.
// Plain <img loading="lazy">: the CDN already serves the image — no Next
// image-optimizer proxy, no remote host wildcard in next.config.
import { useEffect, useRef, useState } from "react";
import { Package } from "lucide-react";
import { cn } from "cn";

export function AdsProductThumb({ src, alt, size = "sm", className }: { src?: string | null; alt: string; size?: "sm" | "lg"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // a server-rendered image can fail before hydration attaches onError: check once mounted
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, [src]);
  const box = size === "lg" ? "size-12" : "size-9";
  const show = !!src && !failed;
  return (
    <span
      data-slot="ads-product-thumb"
      data-state={show ? "image" : "fallback"}
      className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-ads-border bg-ads-surface-strong", box, className)}
    >
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element -- fixed-size CDN thumbnail, see header
        <img ref={img} src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" width={size === "lg" ? 48 : 36} height={size === "lg" ? 48 : 36} onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <Package aria-hidden="true" className={cn("text-ads-accent", size === "lg" ? "size-5" : "size-4")} />
      )}
    </span>
  );
}
