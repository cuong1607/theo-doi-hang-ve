// SHOPEE-6 §49: returns of one order on the order detail page — return count,
// returned quantity, refund, disposition, reversed / net COGS. Streams in
// (Suspense) like the financial section; renders nothing without returns.
import Link from "next/link";

import { getReturnItems, listOrderReturns } from "@/lib/channels/core/returns";
import { DISPOSITION_INFO, returnStatusInfo } from "@/lib/channels/shopee/return-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatQuantity } from "@/lib/ui/format";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export async function OrderReturnsSectionAsync({ orderId }: { orderId: string }) {
  const db = createAdminClient();
  const returns = await listOrderReturns(db, orderId);
  if (returns.length === 0) return null;
  const [items, { data: f }] = await Promise.all([
    getReturnItems(db, returns.map((r) => r.returnId)),
    db.from("order_financials").select("internal_cogs::text, reversed_cogs::text, net_cogs::text").eq("order_id", orderId).maybeSingle<{ internal_cogs: string | null; reversed_cogs: string; net_cogs: string | null }>(),
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trả hàng ({returns.length})</CardTitle>
        <CardDescription>
          Giá vốn gốc {f?.internal_cogs ? formatCurrency(f.internal_cogs) : "chưa tính"} − hoàn lại {formatCurrency(f?.reversed_cogs ?? "0")} = giá vốn ròng{" "}
          {f?.net_cogs ? formatCurrency(f.net_cogs) : "chưa tính"}. Chỉ hàng “Nhập lại kho” mới hoàn giá vốn.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {returns.map((r) => {
          const st = returnStatusInfo(r.status);
          return (
            <div key={r.returnId} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/shopee/returns/${r.returnId}`} className="font-mono text-primary underline-offset-4 hover:underline">
                  {r.externalReturnSn}
                </Link>
                <StatusBadge tone={st.tone} icon={false}>
                  {st.label}
                </StatusBadge>
                <span className="text-muted-foreground">
                  SL trả {r.totalQuantity === null ? "—" : formatQuantity(r.totalQuantity)}
                  {r.refundAmount ? ` · hoàn ${formatCurrency(r.refundAmount)}` : ""}
                  {r.reversedCogs !== "0" && r.reversedCogs !== "0.00" ? ` · hoàn giá vốn ${formatCurrency(r.reversedCogs)}` : ""}
                </span>
              </div>
              <ul className="mt-2 space-y-1 text-xs">
                {(items.get(r.returnId) ?? []).map((it) => (
                  <li key={it.id} className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge tone={DISPOSITION_INFO[it.disposition].tone} icon={false}>
                      {DISPOSITION_INFO[it.disposition].label}
                    </StatusBadge>
                    <span>
                      {it.orderLine?.internalSku ?? it.itemName ?? `#${it.externalItemId}`} × {formatQuantity(it.quantity)}
                    </span>
                    {it.orderLine?.productType === "combo" && <span className="text-muted-foreground">(combo: {it.orderLine.components.map((c) => `${c.sku} × ${formatQuantity(c.quantityPerCombo)}`).join(" + ")})</span>}
                    {it.restocks.map((rs) => (
                      <span key={rs.id} className="text-success-text">
                        · Nhập lại {rs.sku} × {formatQuantity(rs.quantity)}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
