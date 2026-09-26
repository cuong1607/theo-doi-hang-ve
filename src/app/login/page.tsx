import type { Metadata } from "next";

import { APP_NAME, BRAND_NAME } from "@/lib/brand";
import { BrandLogo } from "@/components/brand-logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Đăng nhập" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-accent/60 to-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <BrandLogo size={112} priority className="mx-auto mb-1 shadow-sm ring-1 ring-primary/15" />
          <CardTitle className="text-xl font-bold tracking-wide text-heading">{BRAND_NAME}</CardTitle>
          <CardDescription>{APP_NAME} — đăng nhập để tiếp tục.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={next ?? ""} />
        </CardContent>
      </Card>
    </div>
  );
}
