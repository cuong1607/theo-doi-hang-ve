import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { APP_NAME, APP_TAGLINE, BRAND_NAME } from "@/lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: `${BRAND_NAME} — ${APP_NAME}`,
    template: `%s | ${BRAND_NAME}`,
  },
  description: `${BRAND_NAME} — ${APP_TAGLINE}.`,
  applicationName: BRAND_NAME,
  // Icons: src/app/favicon.ico, icon.png, apple-icon.png (file conventions).
  other: {
    // Zalo OA site verification (Phase ZL1). "/" itself redirect()s to
    // /dashboard, which shares this same root layout, so the tag still
    // renders in the final page's <head> when a crawler/browser follows
    // that redirect.
    "zalo-platform-site-verification": "FkwzBV_HRoi1rU8HyCj69YpRvGt0hJvJDpOs",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="vi"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
