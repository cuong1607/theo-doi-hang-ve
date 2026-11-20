// Builds the "công nợ NCC" report (SUPPLIER_DEBT_REPORT). Read-only: one
// query over v_invoice_debt (migration 00025) for invoices that still have a
// remaining balance — the same source the /debts screen uses, no debt math
// in the app layer.
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { getTodayDateVN } from "./date-vn";
import { groupSupplierDebt, type SupplierDebtReport } from "./supplier-debt-report-message";

export type { SupplierDebtReport } from "./supplier-debt-report-message";

type DebtRow = { supplier_id: string; supplier_name: string; invoice_date: string; remaining_amount: number };

// PostgREST silently caps a response at 1000 rows, so page with a stable
// ORDER BY + range until a short page comes back.
const PAGE_SIZE = 1000;

export async function buildSupplierDebtReport(date: string = getTodayDateVN()): Promise<SupplierDebtReport> {
  const supabase = createAdminClient();
  const rows: DebtRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("v_invoice_debt")
      .select("supplier_id, supplier_name, invoice_date, remaining_amount")
      .gt("remaining_amount", 0)
      .order("supplier_name", { ascending: true })
      .order("supplier_id", { ascending: true })
      .order("invoice_date", { ascending: true })
      .order("invoice_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Không thể đọc công nợ NCC: ${error.message}`);
    }
    const page = (data ?? []) as DebtRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return groupSupplierDebt(date, rows);
}
