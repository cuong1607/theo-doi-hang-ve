// ============================================================
// PHASE UP2: Invoice Financial Snapshot
//
// The ONE place that computes an invoice's money fields (subtotal,
// discount, VAT, final total). Every write path (createInvoice today,
// a future updateInvoice) must call this instead of re-deriving the
// formulas, and every read path (invoice detail page, debt views) must
// display the values this function already computed and persisted —
// never recompute them from invoice_items again.
//
// Pure function, no I/O: safe to call from both the server action (with
// supplierType freshly read from the database — never from client input)
// and the client form (for a live preview only). The server's own call is
// what gets persisted; a client-side preview is never trusted as-is.
// ============================================================

export type SupplierType = "business_household" | "company";
export type DiscountType = "percent" | "fixed_amount";

export type InvoiceLineInput = {
  quantity: number;
  unitPrice: number;
};

export type InvoiceFinancialsInput = {
  supplierType: SupplierType;
  items: InvoiceLineInput[];
  // Only meaningful for business_household. Must be omitted/null for company.
  discountType?: DiscountType | null;
  discountValue?: number | null;
  // Only meaningful for company. Must be omitted/zero for business_household.
  vatRate?: number | null;
};

export type InvoiceFinancials = {
  subtotal: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountAmount: number;
  vatRate: number;
  vatAmount: number;
  finalAmount: number;
};

export type InvoiceFinancialsField = "items" | "discountType" | "discountValue" | "vatRate";

export type InvoiceFinancialsResult =
  | { ok: true; data: InvoiceFinancials }
  | { ok: false; error: string; field?: InvoiceFinancialsField };

const DEFAULT_COMPANY_VAT_RATE = 8;

// JS numbers are floats; rounding to the money scale (2 decimals) after
// every arithmetic step — the same way the DB's numeric(15,2) columns and
// existing views (e.g. v_daily_receipt_summary's ROUND(...,2)) already
// behave — keeps results from drifting away from what gets stored.
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function ok(data: InvoiceFinancials): InvoiceFinancialsResult {
  return { ok: true, data };
}

function fail(error: string, field?: InvoiceFinancialsField): InvoiceFinancialsResult {
  return { ok: false, error, field };
}

export function calculateInvoiceFinancials(
  input: InvoiceFinancialsInput
): InvoiceFinancialsResult {
  if (!input.items || input.items.length === 0) {
    return fail("Hóa đơn phải có ít nhất 1 sản phẩm.", "items");
  }
  for (const item of input.items) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      return fail("Số lượng hóa đơn phải lớn hơn 0.", "items");
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      return fail("Đơn giá phải lớn hơn hoặc bằng 0.", "items");
    }
  }

  const subtotal = round2(
    input.items.reduce((sum, item) => sum + round2(item.quantity * item.unitPrice), 0)
  );

  if (input.supplierType === "company") {
    if (input.discountType != null) {
      return fail("Công ty không được áp dụng chiết khấu.", "discountType");
    }

    const vatRate = input.vatRate ?? DEFAULT_COMPANY_VAT_RATE;
    if (!Number.isFinite(vatRate) || vatRate < 0) {
      return fail("VAT phải lớn hơn hoặc bằng 0.", "vatRate");
    }

    const vatAmount = round2((subtotal * vatRate) / 100);
    const finalAmount = round2(subtotal + vatAmount);

    return ok({
      subtotal,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      vatRate,
      vatAmount,
      finalAmount,
    });
  }

  // business_household
  if (input.vatRate != null && input.vatRate !== 0) {
    return fail("Hộ kinh doanh không áp dụng VAT.", "vatRate");
  }

  if (input.discountType == null) {
    return ok({
      subtotal,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      vatRate: 0,
      vatAmount: 0,
      finalAmount: subtotal,
    });
  }

  const discountValue = input.discountValue;
  if (discountValue == null || !Number.isFinite(discountValue)) {
    return fail("Vui lòng nhập giá trị chiết khấu.", "discountValue");
  }

  let discountAmount: number;
  if (input.discountType === "percent") {
    if (discountValue < 0 || discountValue > 100) {
      return fail("Chiết khấu % phải từ 0 đến 100.", "discountValue");
    }
    discountAmount = round2((subtotal * discountValue) / 100);
  } else {
    if (discountValue < 0 || discountValue > subtotal) {
      return fail("Chiết khấu số tiền phải từ 0 đến giá trị tạm tính.", "discountValue");
    }
    discountAmount = round2(discountValue);
  }

  const finalAmount = Math.max(0, round2(subtotal - discountAmount));

  return ok({
    subtotal,
    discountType: input.discountType,
    discountValue: round2(discountValue),
    discountAmount,
    vatRate: 0,
    vatAmount: 0,
    finalAmount,
  });
}
