"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertTriangle className="size-8 text-destructive" />
        <div>
          <p className="font-medium">Đã xảy ra lỗi khi tải trang tổng quan.</p>
          <p className="text-sm text-muted-foreground">Vui lòng thử lại.</p>
        </div>
        <Button onClick={() => retry()}>Thử lại</Button>
      </CardContent>
    </Card>
  );
}
