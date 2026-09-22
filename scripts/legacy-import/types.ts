export type DanhMucRow = {
  row: number;
  sku: string;
  name: string;
  unit: string;
  price: number | null;
  supplierName: string;
};

export type LichSuRow = {
  row: number;
  date: string; // YYYY-MM-DD
  shift: "morning" | "afternoon";
  shiftRaw: string;
  sku: string;
  productName: string;
  price: number;
  deliveredQty: number;
  receivedQty: number;
  supplierName: string;
};

export type HoaDonRow = {
  row: number;
  savedAt: string; // ISO timestamp, ngay luu — the invoice-batch key
  invoiceDate: string; // YYYY-MM-DD
  sku: string;
  productName: string;
  price: number;
  quantity: number;
  supplierName: string;
};

export type RowIssue = {
  sheet: string;
  row: number;
  reason: "missing_date" | "unknown_sku" | "unknown_supplier" | "missing_core_field" | "duplicate_price_conflict";
  detail: Record<string, unknown>;
};

export type ReceiptItemLine = {
  sku: string;
  unitPrice: number;
  deliveredQty: number;
  receivedQty: number;
  sourceRows: number[];
};

export type ReceiptGroup = {
  legacyRef: string;
  receiptNo: string;
  receiptDate: string;
  shift: "morning" | "afternoon";
  supplierName: string;
  items: ReceiptItemLine[];
  sourceRows: number[];
};

export type InvoiceItemLine = {
  sku: string;
  unitPrice: number;
  quantity: number;
  sourceRow: number;
};

export type InvoiceGroup = {
  legacyRef: string;
  invoiceNo: string;
  invoiceDate: string;
  supplierName: string;
  items: InvoiceItemLine[];
  sourceRows: number[];
  savedAt: string;
};

export type NewProduct = {
  sku: string;
  name: string;
  unit: string;
  price: number;
  priceWasMissing: boolean;
  supplierName: string;
  sourceRow: number;
};

export type ParsedImport = {
  danhMucRows: DanhMucRow[];
  newProducts: NewProduct[];
  skippedProducts: NewProduct[];
  receiptGroups: ReceiptGroup[];
  invoiceGroups: InvoiceGroup[];
  issues: RowIssue[];
  mergedDuplicates: { sheet: string; sku: string; rows: number[]; groupKey: string }[];
  stats: {
    lichSuTotalRows: number;
    lichSuDetailRows: number;
    hoaDonTotalRows: number;
  };
};
