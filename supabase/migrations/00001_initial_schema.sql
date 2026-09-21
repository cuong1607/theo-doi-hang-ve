-- ============================================================
-- PHASE 3: Database Schema Migration
-- Hệ thống Theo Dõi Hàng Về
-- ============================================================

-- ------------------------------------------------------------
-- 1. REUSABLE TRIGGER FUNCTION: updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ------------------------------------------------------------
-- 2. TABLE: profiles
-- ------------------------------------------------------------
CREATE TABLE public.profiles (
  id          uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 3. TABLE: suppliers
-- ------------------------------------------------------------
CREATE TABLE public.suppliers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        UNIQUE NOT NULL,
  name        text        NOT NULL,
  phone       text,
  address     text,
  note        text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_suppliers_updated_at
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 4. TABLE: products
-- ------------------------------------------------------------
CREATE TABLE public.products (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           text          UNIQUE NOT NULL,
  name          text          NOT NULL,
  unit          text          NOT NULL,
  current_price numeric(15,2) NOT NULL DEFAULT 0,
  supplier_id   uuid          NOT NULL REFERENCES public.suppliers(id),
  is_active     boolean       NOT NULL DEFAULT true,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_sku         ON public.products (sku);
CREATE INDEX idx_products_supplier_id ON public.products (supplier_id);

CREATE TRIGGER set_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 5. TABLE: receipts
-- ------------------------------------------------------------
CREATE TABLE public.receipts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no    text        UNIQUE NOT NULL,
  receipt_date  date        NOT NULL,
  shift         text        NOT NULL CHECK (shift IN ('morning', 'afternoon')),
  supplier_id   uuid        NOT NULL REFERENCES public.suppliers(id),
  receiver_name text        NOT NULL,
  note          text,
  created_by    uuid        REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Không có unique(receipt_date, supplier_id, shift)
-- vì có thể có nhiều phiếu cùng ngày + NCC + ca

CREATE INDEX idx_receipts_receipt_date ON public.receipts (receipt_date);
CREATE INDEX idx_receipts_supplier_id  ON public.receipts (supplier_id);
CREATE INDEX idx_receipts_shift        ON public.receipts (shift);
CREATE INDEX idx_receipts_date_supplier ON public.receipts (receipt_date, supplier_id);

CREATE TRIGGER set_receipts_updated_at
  BEFORE UPDATE ON public.receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 6. TABLE: receipt_items
-- difference_qty và line_total là generated columns
-- để bảo vệ tính toàn vẹn dữ liệu
-- ------------------------------------------------------------
CREATE TABLE public.receipt_items (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id      uuid          NOT NULL REFERENCES public.receipts(id) ON DELETE CASCADE,
  product_id      uuid          NOT NULL REFERENCES public.products(id),
  unit_price      numeric(15,2) NOT NULL,
  delivered_qty   numeric(15,2) NOT NULL DEFAULT 0,
  received_qty    numeric(15,2) NOT NULL DEFAULT 0,
  difference_qty  numeric(15,2) NOT NULL GENERATED ALWAYS AS (received_qty - delivered_qty) STORED,
  line_total      numeric(15,2) NOT NULL GENERATED ALWAYS AS (received_qty * unit_price) STORED,
  created_at      timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (receipt_id, product_id)
);

CREATE INDEX idx_receipt_items_product_id ON public.receipt_items (product_id);

ALTER TABLE public.receipt_items ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 7. TABLE: invoices
-- ------------------------------------------------------------
CREATE TABLE public.invoices (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    text        NOT NULL,
  supplier_id   uuid        NOT NULL REFERENCES public.suppliers(id),
  invoice_date  date        NOT NULL,
  note          text,
  created_by    uuid        REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (supplier_id, invoice_no)
);

CREATE INDEX idx_invoices_invoice_date ON public.invoices (invoice_date);
CREATE INDEX idx_invoices_supplier_id  ON public.invoices (supplier_id);

CREATE TRIGGER set_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 8. TABLE: invoice_items
-- line_total là generated column
-- ------------------------------------------------------------
CREATE TABLE public.invoice_items (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid          NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  product_id  uuid          NOT NULL REFERENCES public.products(id),
  unit_price  numeric(15,2) NOT NULL,
  quantity    numeric(15,2) NOT NULL,
  line_total  numeric(15,2) NOT NULL GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at  timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (invoice_id, product_id)
);

CREATE INDEX idx_invoice_items_product_id ON public.invoice_items (product_id);

ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- 9. RLS POLICIES
-- Cho phép authenticated users truy cập tất cả app tables.
-- Sẽ được tinh chỉnh thêm khi implement role-based access.
-- ============================================================

-- profiles
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- suppliers
CREATE POLICY "Authenticated users can view suppliers"
  ON public.suppliers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert suppliers"
  ON public.suppliers FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update suppliers"
  ON public.suppliers FOR UPDATE
  TO authenticated
  USING (true);

-- products
CREATE POLICY "Authenticated users can view products"
  ON public.products FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert products"
  ON public.products FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update products"
  ON public.products FOR UPDATE
  TO authenticated
  USING (true);

-- receipts
CREATE POLICY "Authenticated users can view receipts"
  ON public.receipts FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert receipts"
  ON public.receipts FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update receipts"
  ON public.receipts FOR UPDATE
  TO authenticated
  USING (true);

-- receipt_items
CREATE POLICY "Authenticated users can view receipt_items"
  ON public.receipt_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert receipt_items"
  ON public.receipt_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update receipt_items"
  ON public.receipt_items FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can delete receipt_items"
  ON public.receipt_items FOR DELETE
  TO authenticated
  USING (true);

-- invoices
CREATE POLICY "Authenticated users can view invoices"
  ON public.invoices FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert invoices"
  ON public.invoices FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update invoices"
  ON public.invoices FOR UPDATE
  TO authenticated
  USING (true);

-- invoice_items
CREATE POLICY "Authenticated users can view invoice_items"
  ON public.invoice_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert invoice_items"
  ON public.invoice_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update invoice_items"
  ON public.invoice_items FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can delete invoice_items"
  ON public.invoice_items FOR DELETE
  TO authenticated
  USING (true);


-- ============================================================
-- 10. VIEWS: Daily Aggregation (tính động, không lưu table)
-- ============================================================

-- ------------------------------------------------------------
-- 10a. VIEW: v_daily_receipt_summary
-- Tổng hợp theo ngày + nhà cung cấp (supplier-level)
-- Pivot morning/afternoon bằng FILTER
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_daily_receipt_summary AS
SELECT
  r.receipt_date,
  r.supplier_id,
  s.name AS supplier_name,

  -- Sáng
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'morning'), 0) AS morning_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'morning'), 0) AS morning_received_qty,
  COALESCE(SUM(ri.difference_qty) FILTER (WHERE r.shift = 'morning'), 0) AS morning_difference_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'morning'), 0) AS morning_total_amount,

  -- Chiều
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_received_qty,
  COALESCE(SUM(ri.difference_qty) FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_difference_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_total_amount,

  -- Cả ngày
  COALESCE(SUM(ri.delivered_qty),  0) AS total_delivered_qty,
  COALESCE(SUM(ri.received_qty),   0) AS total_received_qty,
  COALESCE(SUM(ri.difference_qty), 0) AS total_difference_qty,
  COALESCE(SUM(ri.line_total),     0) AS total_amount,

  -- VAT & Grand Total
  ROUND(COALESCE(SUM(ri.line_total), 0) * 0.08, 2) AS vat_amount,
  ROUND(COALESCE(SUM(ri.line_total), 0) * 1.08, 2) AS grand_total

FROM public.receipts r
JOIN public.receipt_items ri ON ri.receipt_id = r.id
JOIN public.suppliers s      ON s.id = r.supplier_id
GROUP BY r.receipt_date, r.supplier_id, s.name;


-- ------------------------------------------------------------
-- 10b. VIEW: v_daily_receipt_product_summary
-- Tổng hợp theo ngày + nhà cung cấp + sản phẩm (product-level)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_daily_receipt_product_summary AS
SELECT
  r.receipt_date,
  r.supplier_id,
  ri.product_id,
  p.sku,
  p.name  AS product_name,
  p.unit,

  -- Sáng
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'morning'), 0) AS morning_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'morning'), 0) AS morning_received_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'morning'), 0) AS morning_line_total,

  -- Chiều
  COALESCE(SUM(ri.delivered_qty)  FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_delivered_qty,
  COALESCE(SUM(ri.received_qty)   FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_received_qty,
  COALESCE(SUM(ri.line_total)     FILTER (WHERE r.shift = 'afternoon'), 0) AS afternoon_line_total,

  -- Cả ngày
  COALESCE(SUM(ri.delivered_qty),  0) AS total_delivered_qty,
  COALESCE(SUM(ri.received_qty),   0) AS total_received_qty,
  COALESCE(SUM(ri.difference_qty), 0) AS total_difference_qty,
  COALESCE(SUM(ri.line_total),     0) AS total_line_total

FROM public.receipts r
JOIN public.receipt_items ri ON ri.receipt_id = r.id
JOIN public.products p       ON p.id = ri.product_id
GROUP BY r.receipt_date, r.supplier_id, ri.product_id, p.sku, p.name, p.unit;
