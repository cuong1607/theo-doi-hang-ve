import Link from "next/link";

import { Button } from "@/components/ui/button";

function hrefFor(q: string, page: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/suppliers?${qs}` : "/suppliers";
}

export function SuppliersPagination({
  page,
  totalPages,
  q,
}: {
  page: number;
  totalPages: number;
  q: string;
}) {
  return (
    <div className="flex items-center justify-between pt-4">
      <p className="text-sm text-muted-foreground">
        Trang {page} / {totalPages}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button variant="outline" size="sm" render={<Link href={hrefFor(q, page - 1)} />}>
            Trước
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Trước
          </Button>
        )}
        {page < totalPages ? (
          <Button variant="outline" size="sm" render={<Link href={hrefFor(q, page + 1)} />}>
            Sau
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Sau
          </Button>
        )}
      </div>
    </div>
  );
}
