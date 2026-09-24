import { AlertTriangle, PackageSearch } from "lucide-react";

import { canManageSuppliers, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListPagination } from "@/components/list-pagination";

import { CreateSupplierButton } from "./create-supplier-button";
import { SearchInput } from "./search-input";
import { SupplierRowActions } from "./supplier-row-actions";

const PAGE_SIZE = 10;

type SupplierListRow = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  is_active: boolean;
  supplier_type: string;
  products: { count: number }[] | null;
};

const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  business_household: "Hộ kinh doanh",
  company: "Công ty",
};

// PostgREST's `.or()` filter syntax treats commas/parentheses as condition
// separators; wrapping the value in double quotes (with `"` itself escaped)
// keeps a raw search term from being interpreted as extra filter conditions.
function escapeOrFilterTerm(value: string) {
  return escapeIlikeTerm(value).replace(/"/g, '\\"');
}

async function getSuppliers(q: string, page: number) {
  const supabase = createAdminClient();
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("suppliers")
    .select("id, code, name, phone, address, note, is_active, supplier_type, products(count)", {
      count: "exact",
    })
    .order("code", { ascending: true })
    .range(from, to);

  if (q) {
    const term = escapeOrFilterTerm(q);
    query = query.or(`code.ilike."%${term}%",name.ilike."%${term}%"`);
  }

  const { data, error, count } = await query;
  return { data: data as SupplierListRow[] | null, error, count: count ?? 0 };
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);

  const role = getCurrentRole();
  const canManage = canManageSuppliers(role);

  const { data: suppliers, error, count } = await getSuppliers(q, page);
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Nhà cung cấp</h2>
          <p className="text-muted-foreground">Quản lý danh sách nhà cung cấp.</p>
        </div>
        {canManage && <CreateSupplierButton />}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle>Danh sách nhà cung cấp</CardTitle>
          <SearchInput defaultValue={q} placeholder="Tìm theo mã hoặc tên..." />
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <AlertTriangle className="size-8 text-destructive" />
              <p className="font-medium">Đã xảy ra lỗi khi tải dữ liệu.</p>
              <p className="text-sm text-muted-foreground">Vui lòng tải lại trang để thử lại.</p>
            </div>
          ) : !suppliers || suppliers.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <PackageSearch className="size-8 text-muted-foreground" />
              <p className="font-medium">
                {q ? "Không tìm thấy nhà cung cấp phù hợp." : "Chưa có nhà cung cấp nào."}
              </p>
              {!q && canManage && (
                <p className="text-sm text-muted-foreground">
                  Bấm &quot;Thêm NCC&quot; để tạo nhà cung cấp đầu tiên.
                </p>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã NCC</TableHead>
                    <TableHead>Tên NCC</TableHead>
                    <TableHead>Loại NCC</TableHead>
                    <TableHead>Điện thoại</TableHead>
                    <TableHead>Số sản phẩm</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suppliers.map((supplier) => (
                    <TableRow key={supplier.id}>
                      <TableCell className="font-medium">{supplier.code}</TableCell>
                      <TableCell>{supplier.name}</TableCell>
                      <TableCell>
                        {SUPPLIER_TYPE_LABELS[supplier.supplier_type] ?? supplier.supplier_type}
                      </TableCell>
                      <TableCell>{supplier.phone || "—"}</TableCell>
                      <TableCell>{supplier.products?.[0]?.count ?? 0}</TableCell>
                      <TableCell>
                        <Badge variant={supplier.is_active ? "default" : "secondary"}>
                          {supplier.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage ? (
                          <SupplierRowActions supplier={supplier} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ListPagination
                page={page}
                totalPages={totalPages}
                buildHref={(p) => {
                  const params = new URLSearchParams();
                  if (q) params.set("q", q);
                  if (p > 1) params.set("page", String(p));
                  const qs = params.toString();
                  return qs ? `/suppliers?${qs}` : "/suppliers";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
