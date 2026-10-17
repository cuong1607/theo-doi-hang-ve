import { Boxes, Coins, Link2, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getComboOverview } from "@/lib/products/combo";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatDateTime, formatQuantity } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { ComboActions } from "../combo-actions";

export const dynamic = "force-dynamic";

export default async function ComboDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("product:view");
  const canManage = hasPermission(auth.profile.role, "product:manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = createAdminClient();
  const combo = await getComboOverview(db, id);
  if (!combo) notFound();

  const [{ data: mappings }, { data: lines }] = await Promise.all([
    db
      .from("channel_product_models")
      .select("id, model_sku, model_name, mapping_status, channel_products!inner(item_name, item_sku, shops!inner(shop_name))")
      .eq("internal_product_id", id)
      .limit(50),
    db
      .from("channel_order_items")
      .select("id, order_id, quantity::text, total_cogs::text, cost_provisional, cogs_reversed_at, channel_orders!inner(external_order_sn, order_status, created_at_channel)")
      .eq("internal_product_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  type Mapping = { id: string; model_sku: string | null; model_name: string | null; mapping_status: string; channel_products: { item_name: string; item_sku: string | null; shops: { shop_name: string } } };
  type Line = {
    id: string;
    order_id: string;
    quantity: string;
    total_cogs: string | null;
    cost_provisional: boolean;
    cogs_reversed_at: string | null;
    channel_orders: { external_order_sn: string; order_status: string; created_at_channel: string | null };
  };

  return (
    <PageContainer>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {combo.name}
            <StatusBadge tone="info" icon={false}>
              Combo
            </StatusBadge>
            {!combo.isActive && (
              <StatusBadge tone="neutral" icon={false}>
                Ngừng hoạt động
              </StatusBadge>
            )}
          </span>
        }
        description={
          <span>
            <span className="font-mono">{combo.sku}</span>
            {combo.note ? ` · ${combo.note}` : ""}
          </span>
        }
        actions={canManage ? <ComboActions id={combo.comboProductId} sku={combo.sku} isActive={combo.isActive} used={combo.orderLines > 0} /> : undefined}
      />

      <Callout tone="info">
        Combo không có tồn kho và giá vốn riêng. Khi bán, hệ thống trừ kho và tính giá vốn trên từng sản phẩm thành phần, và lưu lại thành phần + giá vốn đã dùng cho
        từng đơn (sửa combo sau này không làm đổi đơn cũ).
      </Callout>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Giá vốn hiện tại (suy ra)"
          icon={Coins}
          value={combo.currentUnitCost === null ? <span className="text-muted-foreground">Chưa đủ giá vốn</span> : formatCurrency(combo.currentUnitCost)}
          tone={combo.currentUnitCost === null || combo.costProvisional ? "warning" : "neutral"}
          hint={combo.costProvisional ? "Tạm tính — có thành phần chưa có hóa đơn VAT" : "Σ giá vốn bình quân thành phần × số lượng"}
        />
        <MetricCard label="Có thể bán (suy ra)" icon={Boxes} value={combo.availableQty === null ? "—" : formatQuantity(combo.availableQty)} hint="theo tồn kho tính giá vốn của thành phần" />
        <MetricCard label="Mapping Shopee" icon={Link2} value={combo.mappedModels} hint="mẫu Shopee ghép với combo" />
        <MetricCard label="Dòng đơn đã bán" icon={ShoppingCart} value={combo.orderLines} hint="dòng đơn ghi nhận combo này" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thành phần ({combo.componentCount})</CardTitle>
          <CardDescription>Thành phần hiện tại — áp dụng cho đơn được tính giá vốn từ bây giờ.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Tên sản phẩm</TableHead>
                <TableHead className="text-right">SL / combo</TableHead>
                <TableHead className="text-right">Giá vốn BQ</TableHead>
                <TableHead className="text-right">Tồn (tính giá vốn)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {combo.components.map((c) => (
                <TableRow key={c.productId}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/inventory/costs/${c.productId}`} className="text-primary underline-offset-4 hover:underline">
                      {c.sku}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {c.name}
                    {!c.isActive && (
                      <StatusBadge tone="neutral" icon={false} className="ml-1.5">
                        Ngừng HĐ
                      </StatusBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatQuantity(c.quantity)}</TableCell>
                  <TableCell className="text-right">
                    {c.movingAverageCost === null ? <span className="text-muted-foreground">Chưa có</span> : formatCurrency(c.movingAverageCost)}
                    {c.costProvisional && c.movingAverageCost !== null && <span className="block text-xs text-warning-text">Tạm tính</span>}
                  </TableCell>
                  <TableCell className="text-right">{c.quantityOnHand === null ? "—" : formatQuantity(c.quantityOnHand)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mapping Shopee</CardTitle>
        </CardHeader>
        <CardContent>
          {(mappings ?? []).length === 0 ? (
            <EmptyState title="Chưa có mẫu Shopee nào ghép với combo này." description="Tự động ghép SKU khi SKU Shopee trùng SKU combo, hoặc ghép tay ở trang Sản phẩm Shopee." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shop</TableHead>
                  <TableHead>Sản phẩm Shopee</TableHead>
                  <TableHead>SKU Shopee</TableHead>
                  <TableHead>Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {((mappings ?? []) as unknown as Mapping[]).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-xs">{m.channel_products.shops.shop_name}</TableCell>
                    <TableCell className="text-xs">
                      {m.channel_products.item_name}
                      {m.model_name ? ` — ${m.model_name}` : ""}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{m.model_sku ?? m.channel_products.item_sku ?? "—"}</TableCell>
                    <TableCell className="text-xs">{m.mapping_status === "auto_mapped" ? "Tự động" : m.mapping_status === "manual_mapped" ? "Ghép tay" : m.mapping_status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Đơn hàng gần đây</CardTitle>
          <CardDescription>20 dòng đơn mới nhất bán combo này — giá vốn là snapshot theo thành phần lúc tính.</CardDescription>
        </CardHeader>
        <CardContent>
          {(lines ?? []).length === 0 ? (
            <EmptyState title="Combo chưa có đơn hàng nào." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày đơn</TableHead>
                  <TableHead>Mã đơn</TableHead>
                  <TableHead className="text-right">SL</TableHead>
                  <TableHead className="text-right">COGS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {((lines ?? []) as unknown as Line[]).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs">{formatDateTime(l.channel_orders.created_at_channel)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/shopee/orders/${l.order_id}`} className="text-primary underline-offset-4 hover:underline">
                        {l.channel_orders.external_order_sn}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">{formatQuantity(l.quantity)}</TableCell>
                    <TableCell className="text-right">
                      {l.total_cogs === null ? <span className="text-muted-foreground">Chưa tính</span> : formatCurrency(l.total_cogs)}
                      {l.cost_provisional && l.total_cogs !== null && <span className="block text-xs text-warning-text">Tạm tính</span>}
                      {l.cogs_reversed_at && <span className="block text-xs text-muted-foreground">đã hoàn kho (huỷ)</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
