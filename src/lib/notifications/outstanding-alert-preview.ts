import { createAdminClient } from "@/lib/supabase/admin";

import { formatOutstandingAlertMessage, type OutstandingAlertItem } from "./outstanding-alert-message";

export type OutstandingAlertPreview = {
  supplierId: string;
  supplierName: string;
  message: string;
  itemCount: number;
};

type OutstandingRow = {
  invoice_item_id: string;
  supplier_id: string;
  supplier_name: string;
  sku: string;
  product_name: string;
  invoice_no: string;
  invoice_qty: number;
  received_qty: number;
  remaining_qty: number;
  status: "need_makeup" | "complete" | "low" | "normal";
};

// PHẦN 7 (ZL7) — "Low-stock alert: có thể preview message, không cần fake
// thay đổi database nếu nguy hiểm." Read-only: queries v_outstanding for
// whatever is CURRENTLY low/need_makeup and formats the message that
// evaluateOutstandingNotifications() would send for it — never writes to
// notification_event_states, never calls sendNotification(). Safe to call
// on every page load.
export async function previewLowStockAlerts(): Promise<OutstandingAlertPreview[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("v_outstanding")
    .select(
      "invoice_item_id, supplier_id, supplier_name, sku, product_name, invoice_no, invoice_qty, received_qty, remaining_qty, status"
    )
    .in("status", ["low", "need_makeup"]);

  if (error || !data) return [];

  const bySupplier = new Map<string, { supplierName: string; items: OutstandingAlertItem[] }>();
  for (const row of data as OutstandingRow[]) {
    const bucket = bySupplier.get(row.supplier_id) ?? { supplierName: row.supplier_name, items: [] };
    bucket.items.push({
      invoiceItemId: row.invoice_item_id,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      sku: row.sku,
      productName: row.product_name,
      invoiceNo: row.invoice_no,
      invoiceQty: row.invoice_qty,
      receivedQty: row.received_qty,
      remainingQty: row.remaining_qty,
      alertState: row.status === "need_makeup" ? "over_received" : "near_empty",
    });
    bySupplier.set(row.supplier_id, bucket);
  }

  return [...bySupplier.entries()].map(([supplierId, bucket]) => ({
    supplierId,
    supplierName: bucket.supplierName,
    message: formatOutstandingAlertMessage(bucket.supplierName, bucket.items),
    itemCount: bucket.items.length,
  }));
}
