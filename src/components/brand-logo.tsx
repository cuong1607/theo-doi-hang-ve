import Image from "next/image";
import { cn } from "cn";

import { BRAND_NAME } from "@/lib/brand";

// The round CongTrang Bedding emblem (tight crop, transparent corners).
export function BrandLogo({ size = 32, className, priority }: { size?: number; className?: string; priority?: boolean }) {
  return (
    <Image
      src="/brand/logo-mark.png"
      alt={BRAND_NAME}
      width={size}
      height={size}
      priority={priority}
      className={cn("shrink-0 rounded-full", className)}
    />
  );
}
