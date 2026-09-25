"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Not a server-side redirect() on purpose: this is the site's root URL,
// which third-party crawlers (e.g. Zalo's site-verification bot) fetch with
// a single plain GET and no JS execution. A server redirect() returns an
// empty-bodied 307 with no <head> at all, so a meta tag on the root layout
// (see layout.tsx's zalo-platform-site-verification) would never be seen.
// Rendering real HTML here and redirecting via a client-side effect means
// GET / always returns a normal 200 page with the full <head> — real
// browsers still bounce to /dashboard almost instantly, and non-JS crawlers
// just see the homepage as-is.
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);

  return null;
}
