import { AlertTriangle, PackageSearch } from "lucide-react";
import { requirePermission } from "@/lib/auth/session";

import { canManageProducts } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";
import { formatCurrency } from "@/lib/format";
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

import { CreateProductButton } from "./create-product-button";
import { ProductFilters } from "./product-filters";
import { ProductRowActions } from "./product-row-actions";

const PAGE_SIZE = 10;

type ProductListRow = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  current_price: number;
  supplier_id: string;
  is_active: boolean;
  suppliers: { id: string; code: string; name: string; is_active: boolean } | null;
};

type SupplierRef = { id: string; code: string; name: string; is_active: boolean };

async function getSuppliers() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, code, name, is_active")
    .order("code", { ascending: true });
  return { data: (data as SupplierRef[] | null) ?? [], error };
}

async function getProducts({
  sku,
  name,
  supplierId,
  status,
  page,
}: {
  sku: string;
  name: string;
  supplierId: string;
  status: string;
  page: number;
}) {
  const supabase = createAdminClient();
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("products")
    .select(
      "id, sku, name, unit, current_price, is_active, supplier_id, suppliers(id, code, name, is_active)",
      { count: "exact" }
    )
    .order("sku", { ascending: true })
    .range(from, to);

  if (sku) query = query.ilike("sku", `%${escapeIlikeTerm(sku)}%`);
  if (name) query = query.ilike("name", `%${escapeIlikeTerm(name)}%`);
  if (supplierId) query = query.eq("supplier_id", supplierId);
  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);

  const { data, error, count } = await query;
  return { data: data as unknown as ProductListRow[] | null, error, count: count ?? 0 };
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string; name?: string; supplier?: string; status?: string; page?: string }>;
}) {
  const auth = await requirePermission("product:view");
  const params = await searchParams;
  const sku = (params.sku ?? "").trim();
  const name = (params.name ?? "").trim();
  const supplierId = (params.supplier ?? "").trim();
  const status = (params.status ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);
  const hasFilter = !!(sku || name || supplierId || status);

  const role = auth.profile.role;
  const canManage = canManageProducts(role);

  const [{ data: suppliers }, { data: products, error, count }] = await Promise.all([
    getSuppliers(),
    getProducts({ sku, name, supplierId, status, page }),
  ]);
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Sản phẩm</h2>
          <p className="text-muted-foreground">Quản lý danh mục sản phẩm trong hệ thống.</p>
        </div>
        {canManage && <CreateProductButton suppliers={suppliers} />}
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 space-y-0">
          <CardTitle>Danh sách sản phẩm</CardTitle>
          <ProductFilters
            sku={sku}
            name={name}
            supplierId={supplierId}
            status={status}
            suppliers={suppliers}
          />
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <AlertTriangle className="size-8 text-destructive" />
              <p className="font-medium">Đã xảy ra lỗi khi tải dữ liệu.</p>
              <p className="text-sm text-muted-foreground">Vui lòng tải lại trang để thử lại.</p>
            </div>
          ) : !products || products.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <PackageSearch className="size-8 text-muted-foreground" />
              <p className="font-medium">
                {hasFilter ? "Không tìm thấy sản phẩm phù hợp." : "Chưa có sản phẩm nào."}
              </p>
              {!hasFilter && canManage && (
                <p className="text-sm text-muted-foreground">
                  Bấm &quot;Thêm sản phẩm&quot; để tạo sản phẩm đầu tiên.
                </p>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Tên sản phẩm</TableHead>
                    <TableHead>Đơn vị</TableHead>
                    <TableHead>Đơn giá hiện tại</TableHead>
                    <TableHead>Nhà cung cấp</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="font-medium">{product.sku}</TableCell>
                      <TableCell>{product.name}</TableCell>
                      <TableCell>{product.unit}</TableCell>
                      <TableCell>{formatCurrency(product.current_price)}</TableCell>
                      <TableCell>
                        {product.suppliers ? (
                          <span className="inline-flex items-center gap-1.5">
                            {product.suppliers.code}
                            {!product.suppliers.is_active && (
                              <Badge variant="secondary">Ngừng HĐ</Badge>
                            )}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={product.is_active ? "default" : "secondary"}>
                          {product.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage ? (
                          <ProductRowActions product={product} suppliers={suppliers} />
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
                  const searchParams = new URLSearchParams();
                  if (sku) searchParams.set("sku", sku);
                  if (name) searchParams.set("name", name);
                  if (supplierId) searchParams.set("supplier", supplierId);
                  if (status) searchParams.set("status", status);
                  if (p > 1) searchParams.set("page", String(p));
                  const qs = searchParams.toString();
                  return qs ? `/products?${qs}` : "/products";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
