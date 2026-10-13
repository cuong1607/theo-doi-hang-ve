// ============================================================
// PHASE SHOPEE-0: Financial Engine — interface only.
//
// The future single place that turns a canonical OrderFinancialsInput into
// profit / margin / settlement variance (like src/lib/invoices/financials.ts
// is for invoices). Formulas are NOT part of SHOPEE-0: calling it throws.
//
// Pipeline: provider API → mapper → canonical model → this engine.
// ============================================================
import { NotImplementedError } from "../channels/core/errors.ts";
import type { OrderFinancialsInput, OrderFinancialsResult } from "./types.ts";

export function calculateOrderFinancials(input: OrderFinancialsInput): OrderFinancialsResult {
  void input;
  throw new NotImplementedError("calculateOrderFinancials");
}
