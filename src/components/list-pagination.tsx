import Link from "next/link";

import { Button } from "@/components/ui/button";

export function ListPagination({
  page,
  totalPages,
  buildHref,
}: {
  page: number;
  totalPages: number;
  buildHref: (page: number) => string;
}) {
  return (
    <div className="flex items-center justify-between pt-4">
      <p className="text-sm text-muted-foreground">
        Trang {page} / {totalPages}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={buildHref(page - 1)} />}
          >
            Trước
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Trước
          </Button>
        )}
        {page < totalPages ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={buildHref(page + 1)} />}
          >
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
