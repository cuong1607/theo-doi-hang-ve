import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getCostHistory, getProductAnalytics, getProductTrend } from "@/lib/channels/core/analytics";
import { chartNumber, formatMoney, formatPct, formatSignedMoney } from "@/lib/analytics/display";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime, formatQuantity } from "@/lib/ui/format";
import { getAnalyticsContext, periodText, type AnalyticsParams } from "@/components/analytics/context";
import { KpiCard, KpiGrid } from "@/components/analytics/kpi-card";
import { COST_FLAG_LABEL } from "@/components/analytics/labels";
import { AnalyticsSection, loadSection, SectionFailed } from "@/components/analytics/section";
import { TrendChart } from "@/components/analytics/trend-chart";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import { Callout } from "@/components/patterns/callout";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const EVENT_LABEL: Record<string, string> = {
  opening_balance: "Tồn đầu",
  purchase_in: "Nhập hàng",
  sale_out: "Bán",
  sale_reversal_in: "Huỷ bán",
  return_in: "Trả hàng nhập kho",
  adjustment_in: "Điều chỉnh tăng",
  adjustment_out: "Điều chỉnh giảm",
};

export default async function ProductAnalyticsDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<AnalyticsParams> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await getAnalyticsContext(await searchParams, "30d");
  if (!ctx) notFound();
  const db = createAdminClient();
  const { data: product } = await db.from("products").select("id, sku, name, product_type, unit").eq("id", id).maybeSingle<{ id: string; sku: string; name: string; product_type: "atomic" | "combo"; unit: string }>();
  if (!product) notFound();
  const combo = product.product_type === "combo";

  const res = await loadSection("product-detail", () =>
    Promise.all([
      getProductAnalytics(db, ctx.scope, ctx.period, { productId: id, limit: 1 }),
      getProductTrend(db, id, ctx.scope, ctx.period),
      combo ? Promise.resolve([]) : getCostHistory(db, id, 200),
      db.from("product_combo_components").select("quantity::text, component:products!product_combo_components_component_product_id_fkey(id, sku, name)").eq("combo_product_id", id),
      db.from("v_channel_model_listing").select("channel_model_id, shop_name, item_name, model_name, channel_sku, mapping_status, is_active").eq("internal_product_id", id).in("shop_id", ctx.scope.shopIds).limit(50),
      db.from("product_cost_state").select("moving_average_cost::text, quantity_on_hand::text, cost_provisional").eq("product_id", id).maybeSingle(),
    ]),
  );

  return (
    <>
      <Link href={`/shopee/analytics/products${ctx.qs}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="size-4" /> Phân tích sản phẩm
      </Link>
      <PageHeader
        title={<span className="font-mono">{product.sku}</span>}
        description={`${product.name} · ${periodText(ctx.period)}`}
        meta={
          <StatusBadge tone={combo ? "info" : "neutral"} icon={false}>
            {combo ? "Combo" : "Sản phẩm"}
          </StatusBadge>
        }
      />
      <AnalyticsFilters query={ctx.query} shops={ctx.scope.shops.map((s) => ({ id: s.id, name: s.name }))} />
      {!res.ok ? (
        <SectionFailed title="Sản phẩm" />
      ) : (
        (() => {
          const [list, trend, cost, bom, models, state] = res.data;
          const r = list.rows[0];
          const bomRows = (bom.data ?? []) as unknown as Array<{ quantity: string; component: { id: string; sku: string; name: string } | null }>;
          const costState = state.data as { moving_average_cost: string | null; quantity_on_hand: string; cost_provisional: boolean } | null;
          return (
            <>
              {r ? (
                <KpiGrid>
                  <KpiCard label="Đã bán" value={`${formatQuantity(r.units)} ${product.unit}`} sub={`${r.orders} đơn · giá trị ${formatMoney(r.order_value)}`} />
                  <KpiCard label="LN dự kiến" value={formatSignedMoney(r.estimated_profit)} sub={`Margin ${formatPct(r.estimated_margin)} · ${r.estimated_lines}/${r.lines} dòng`} />
                  <KpiCard label="LN thực tế" value={formatSignedMoney(r.actual_profit)} sub={`Margin ${formatPct(r.actual_margin)} · ${r.actual_lines}/${r.lines} dòng final`} />
                  <KpiCard label="Tỷ lệ trả" value={formatPct(r.return_rate)} sub={`${formatQuantity(r.returned_units)}/${formatQuantity(r.units)} sp${r.small_sample ? " · mẫu nhỏ, chưa đủ kết luận" : ""}`} />
                </KpiGrid>
              ) : (
                <Callout tone="info">SKU này không có đơn bán trong kỳ.</Callout>
              )}
              {r?.cost_flag && <Callout tone="warning">Cảnh báo giá vốn: {COST_FLAG_LABEL[r.cost_flag]} — lợi nhuận của các dòng thiếu giá vốn không được tính (không tính một phần).</Callout>}

              <AnalyticsSection title="Bán hàng & lợi nhuận theo ngày" description="Giá trị / lợi nhuận đơn phân bổ cho SKU theo tỷ lệ giá trị dòng.">
                <TrendChart
                  title={`Lợi nhuận ${product.sku}`}
                  points={trend.map((p) => ({
                    label: `${p.bucket.slice(8, 10)}/${p.bucket.slice(5, 7)}`,
                    values: { est: chartNumber(p.estimated_profit), act: chartNumber(p.actual_profit), units: chartNumber(p.units) },
                    display: { est: formatSignedMoney(p.estimated_profit), act: formatSignedMoney(p.actual_profit), units: formatQuantity(p.units) },
                  }))}
                  series={[
                    { key: "est", label: "LN dự kiến", color: "var(--info)", dash: "6 4" },
                    { key: "act", label: "LN thực tế", color: "var(--success)" },
                    { key: "units", label: "Số lượng", color: "var(--muted-foreground)", dash: "2 3" },
                  ]}
                  defaultVisible={["est", "act"]}
                />
              </AnalyticsSection>

              {combo ? (
                <AnalyticsSection title="Thành phần combo (BOM hiện tại)" description="Giá vốn combo của mỗi đơn lấy từ snapshot thành phần lúc bán — không tính lại theo BOM / giá vốn hiện tại. Combo không có sổ giá vốn riêng.">
                  <ul className="space-y-1 text-sm">
                    {bomRows.map((b) =>
                      b.component ? (
                        <li key={b.component.id}>
                          {formatQuantity(b.quantity)} ×{" "}
                          <Link href={`/shopee/analytics/products/${b.component.id}${ctx.qs}`} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                            {b.component.sku}
                          </Link>{" "}
                          <span className="text-muted-foreground">{b.component.name}</span>
                        </li>
                      ) : null,
                    )}
                  </ul>
                </AnalyticsSection>
              ) : (
                <AnalyticsSection
                  title="Lịch sử giá vốn bình quân"
                  description={`Giá vốn bình quân di động sau mỗi biến động kho (sổ giá vốn).${costState?.moving_average_cost ? ` Hiện tại ${formatMoney(costState.moving_average_cost)}${costState.cost_provisional ? " (VAT tạm tính)" : ""}, tồn ${formatQuantity(costState.quantity_on_hand)}.` : ""}`}
                >
                  <TrendChart
                    title={`Giá vốn bình quân ${product.sku}`}
                    points={cost
                      .filter((c) => c.avg_cost_after !== null)
                      .map((c) => ({ label: formatDateTime(c.event_time).slice(0, 5), values: { avg: chartNumber(c.avg_cost_after) }, display: { avg: formatMoney(c.avg_cost_after) } }))}
                    series={[{ key: "avg", label: "Giá vốn bình quân", color: "var(--warning)" }]}
                    emptyText="Chưa có biến động giá vốn."
                  />
                  {cost.length > 0 && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Sổ giá vốn ({cost.length} dòng gần nhất)</summary>
                      <div className="mt-2 max-h-72 overflow-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Thời điểm</TableHead>
                              <TableHead>Loại</TableHead>
                              <TableHead className="text-right">SL</TableHead>
                              <TableHead className="text-right">Đơn giá</TableHead>
                              <TableHead className="text-right">BQ sau</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {[...cost].reverse().map((c, i) => (
                              <TableRow key={i}>
                                <TableCell>{formatDateTime(c.event_time)}</TableCell>
                                <TableCell>{EVENT_LABEL[c.event_type] ?? c.event_type}</TableCell>
                                <TableCell className="text-right">{formatQuantity(c.quantity_change)}</TableCell>
                                <TableCell className="text-right">{formatMoney(c.unit_cost)}</TableCell>
                                <TableCell className="text-right">{formatMoney(c.avg_cost_after)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </details>
                  )}
                </AnalyticsSection>
              )}

              <AnalyticsSection title="Ghép với sản phẩm Shopee">
                {(models.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">Chưa có mẫu Shopee nào ghép với SKU này.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {((models.data ?? []) as Array<{ channel_model_id: string; shop_name: string; item_name: string; model_name: string | null; channel_sku: string | null; is_active: boolean }>).map((m) => (
                      <li key={m.channel_model_id}>
                        {m.item_name}
                        {m.model_name ? ` · ${m.model_name}` : ""} <span className="font-mono text-xs text-muted-foreground">{m.channel_sku}</span>
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          · {m.shop_name}
                          {m.is_active ? "" : " · ngừng bán"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </AnalyticsSection>
            </>
          );
        })()
      )}
    </>
  );
}
