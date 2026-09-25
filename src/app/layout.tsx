import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Theo Dõi Hàng Về - Quản lý kho hàng",
  description:
    "Hệ thống theo dõi hàng về, quản lý hóa đơn, sản phẩm và nhà cung cấp.",
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
