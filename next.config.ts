import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: lets a Cloudflare quick tunnel reach `next dev` (Shopee
  // sandbox OAuth rejects localhost redirect URLs). Ignored in production.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // APP-SHELL-1 aliases: the long-term /apps/<app> URLs for apps whose landing
  // is an existing page (docs/app-shell-architecture.md). Temporary (307), so
  // the targets can move later without stale browser caches. The proxy still
  // runs its auth check on the target.
  async redirects() {
    return [
      { source: "/apps/accounting", destination: "/dashboard", permanent: false },
      { source: "/apps/system", destination: "/users", permanent: false },
    ];
  },
};

export default nextConfig;
