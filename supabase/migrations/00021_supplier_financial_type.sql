-- ============================================================
-- PHASE UP1: Supplier Financial Type
-- Bổ sung loại nhà cung cấp (hộ kinh doanh / công ty).
--
-- Chiết khấu và VAT KHÔNG được cấu hình mặc định ở supplier —
-- chúng được chọn/snapshot theo từng invoice (UP2/UP3), nên
-- supplier chỉ lưu supplier_type.
-- ============================================================

ALTER TABLE public.suppliers
  ADD COLUMN supplier_type text;

-- Backfill: loại NCC thực tế do người dùng cung cấp cho các NCC hiện có.
-- NCC nào không nằm trong danh sách này mặc định là "hộ kinh doanh" — an
-- toàn, không đổi hành vi hiện tại; admin cập nhật lại sau qua UI /suppliers.
UPDATE public.suppliers
SET supplier_type = CASE code
  WHEN 'NCC01' THEN 'company'
  WHEN 'NCC02' THEN 'business_household'
  WHEN 'NCC03' THEN 'company'
  WHEN 'NCC04' THEN 'business_household'
  WHEN 'NCC05' THEN 'company'
  WHEN 'NCC06' THEN 'company'
  ELSE 'business_household'
END
WHERE supplier_type IS NULL;

ALTER TABLE public.suppliers
  ALTER COLUMN supplier_type SET NOT NULL;

ALTER TABLE public.suppliers
  ADD CONSTRAINT suppliers_supplier_type_check
    CHECK (supplier_type IN ('business_household', 'company'));
