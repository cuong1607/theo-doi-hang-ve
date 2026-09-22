# Debt Module (Công nợ nhà cung cấp)

Phase CN1 — database only. Không có UI/actions trong phase này; đây là nền
tảng schema + query/service layer để các phase sau (UI ghi nhận thanh toán,
màn hình công nợ) build lên.

## Nguyên tắc

Giống `v_daily_receipt_summary` và `v_outstanding` ở các phase trước:
**không lưu số dư cố định**. `paid_amount`, `remaining_amount`,
`payment_status`, và các số tổng theo NCC đều **tính động** từ
`payment_items` mỗi lần query, qua 2 view SQL. `invoices` không có cột nào
bị thêm/sửa ở phase này.

## Bảng: payments

Một lượt thanh toán cho một NCC, có thể trả gộp cho nhiều hóa đơn.

| Column | Type | Constraint |
|--------|------|------------|
| id | uuid | PK, DEFAULT gen_random_uuid() |
| supplier_id | uuid | NOT NULL, FK → suppliers(id) |
| payment_date | date | NOT NULL |
| total_amount | numeric(15,2) | NOT NULL, CHECK > 0 |
| note | text | nullable |
| created_by | uuid | FK → profiles(id) |
| created_at | timestamptz | NOT NULL, DEFAULT now() |
| updated_at | timestamptz | NOT NULL, DEFAULT now(), auto-trigger |

**Indexes:** `supplier_id`, `payment_date`

> `total_amount` là số tiền của lượt thanh toán (theo phiếu chi thực tế),
> không bắt buộc phải bằng tổng các `payment_items.amount` của nó ở tầng
> database — validation "khớp tổng" (nếu cần) thuộc về app layer khi build
> UI ghi nhận thanh toán.

## Bảng: payment_items

Một dòng thanh toán = số tiền của một `payment` phân bổ cho một `invoice`.

| Column | Type | Constraint |
|--------|------|------------|
| id | uuid | PK, DEFAULT gen_random_uuid() |
| payment_id | uuid | NOT NULL, FK → payments(id) ON DELETE CASCADE |
| invoice_id | uuid | NOT NULL, FK → invoices(id) |
| amount | numeric(15,2) | NOT NULL, CHECK > 0 |
| created_at | timestamptz | NOT NULL, DEFAULT now() |

**Unique:** `(payment_id, invoice_id)` — một payment không trả trùng 1 hóa đơn 2 dòng.
**Indexes:** `invoice_id`, `payment_id`

> Không có ràng buộc `amount <= remaining_amount` ở tầng database — số tiền
> trả vượt tổng nợ hóa đơn (overpayment) vẫn insert được, và sẽ khiến
> `payment_status` là `paid` (không có trạng thái "trả dư" riêng ở phase
> này). Nếu cần chặn overpayment, đó là validation ở app layer của phase UI.

## RLS

Bật RLS cho cả 2 bảng, policy giống `invoices`/`invoice_items` (tạm thời
cho phép mọi `authenticated` user, sẽ siết theo role khi Phase 5 xong):

- `payments`: SELECT, INSERT, UPDATE (không có DELETE — giống `invoices`)
- `payment_items`: SELECT, INSERT, UPDATE, DELETE (giống `invoice_items`,
  hỗ trợ sửa diff-based các dòng của 1 payment)

## Tính công nợ hóa đơn — view `v_invoice_debt`

```
invoice_total    = SUM(invoice_items.line_total) theo invoice
paid_amount      = SUM(payment_items.amount) theo invoice
remaining_amount = invoice_total - paid_amount

payment_status:
  paid_amount <= 0                    -> unpaid
  paid_amount >= invoice_total        -> paid
  ngược lại (0 < paid_amount < total) -> partial
```

Cách tính: 2 subquery độc lập (`invoice_items` GROUP BY `invoice_id`,
`payment_items` GROUP BY `invoice_id`) rồi LEFT JOIN theo `invoice_id` —
tránh fan-out join trực tiếp giữa `invoice_items` và `payment_items` (sẽ
nhân đôi dữ liệu vì cả hai đều có nhiều dòng trên 1 invoice).

| Field | Mô tả |
|-------|-------|
| invoice_id, invoice_no, invoice_date | Thông tin hóa đơn |
| supplier_id, supplier_code, supplier_name | NCC |
| invoice_total | Tổng tiền hóa đơn |
| paid_amount | Đã trả |
| remaining_amount | Còn phải trả |
| payment_status | `unpaid` \| `partial` \| `paid` |

Hóa đơn chưa có `invoice_items` (invoice_total = 0) hoặc chưa có
`payment_items` (paid_amount = 0) đều được `COALESCE` về 0, không trả `NULL`.

## Tổng hợp công nợ theo NCC — view `v_supplier_debt_summary`

Rollup `v_invoice_debt` theo `supplier_id`, LEFT JOIN từ `suppliers` nên NCC
chưa có hóa đơn nào vẫn xuất hiện với các số 0 (không bị ẩn khỏi danh sách).

```
supplier_invoice_total    = SUM(v_invoice_debt.invoice_total) theo NCC
supplier_paid_total       = SUM(v_invoice_debt.paid_amount) theo NCC
supplier_remaining_total  = SUM(v_invoice_debt.remaining_amount) theo NCC
supplier_open_invoice_count = COUNT hóa đơn có payment_status <> 'paid'
                               (tức unpaid + partial)
```

| Field | Mô tả |
|-------|-------|
| supplier_id, supplier_code, supplier_name | NCC |
| supplier_invoice_total | Tổng tiền tất cả hóa đơn của NCC |
| supplier_paid_total | Tổng đã trả |
| supplier_remaining_total | Tổng còn nợ |
| supplier_open_invoice_count | Số hóa đơn chưa trả đủ (unpaid + partial) |

## Service layer (`src/lib/debt/`)

Đọc trực tiếp 2 view trên, không tính toán lại trong app — theo đúng pattern
`src/lib/outstanding/list.ts` / `src/lib/dashboard/queries.ts` của các phase
trước.

- `invoice-debt.ts`
  - `getInvoiceDebtList(filters, page, pageSize)` — danh sách công nợ hóa
    đơn, lọc theo `supplierId` / `paymentStatus`, phân trang.
  - `getInvoiceDebt(invoiceId)` — công nợ 1 hóa đơn.
- `supplier-debt.ts`
  - `getSupplierDebtSummaryList()` — công nợ tất cả NCC, sắp theo
    `supplier_remaining_total` giảm dần.
  - `getSupplierDebtSummary(supplierId)` — công nợ 1 NCC.

Chưa có action tạo/sửa `payments` (`createPayment` v.v.) — đó là phần UI của
phase kế tiếp, ngoài phạm vi CN1.

## Migration

`supabase/migrations/00017_payments_debt.sql` — tables, indexes, trigger,
RLS, 2 views. Đã verify trên DB thật: 4 hóa đơn hiện có đều `unpaid` với
`remaining_amount = invoice_total`; test insert 1 payment 100đ cho 1 hóa đơn
thì `paid_amount`/`remaining_amount`/`payment_status` cập nhật đúng ngay
(không cần cache invalidation vì view tính động), sau đó đã xóa dữ liệu test.
