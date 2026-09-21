import { createAdminClient } from "@/lib/supabase/admin";
import type { OutstandingRow } from "./list";

export type ContributingReceipt = {
  receipt_id: string;
  receipt_no: string;
  receipt_date: string;
  shift: string;
  received_qty: number;
};

// The header numbers come straight from v_outstanding (not recomputed here)
// so the detail page can never drift from the list page's totals. The
// contributing receipts come from get_outstanding_contributing_receipts,
// which uses the exact same WHERE clause the view's LATERAL join uses.
export async function getOutstandingDetail(invoiceItemId: string): Promise<{
  row: OutstandingRow | null;
  contributingReceipts: ContributingReceipt[];
}> {
  const supabase = createAdminClient();

  const [{ data: row }, { data: contributingReceipts }] = await Promise.all([
    supabase.from("v_outstanding").select("*").eq("invoice_item_id", invoiceItemId).maybeSingle(),
    supabase.rpc("get_outstanding_contributing_receipts", { p_invoice_item_id: invoiceItemId }),
  ]);

  return {
    row: (row ?? null) as OutstandingRow | null,
    contributingReceipts: (contributingReceipts ?? []) as ContributingReceipt[],
  };
}
