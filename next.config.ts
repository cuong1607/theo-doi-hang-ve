import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: lets a Cloudflare quick tunnel reach `next dev` (Shopee
  // sandbox OAuth rejects localhost redirect URLs). Ignored in production.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
