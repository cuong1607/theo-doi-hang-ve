# Financial Policy Migration Preview — PHASE UP6

Tạo lúc: 2026-09-25T01:55:56.677Z
Dữ liệu lấy trực tiếp từ Supabase cloud project (project ref `qjaopxeuftpsrcvrevyo`) tại thời điểm tạo báo cáo.

Đây là **preview** — không có dòng nào trong `suppliers`/`invoices` bị sửa khi tạo báo cáo này.
Không migration nào chạy cho tới khi user duyệt phần "Đề xuất backfill" bên dưới (mục 4).

## 1. Supplier audit

7 nhà cung cấp hiện có. `supplier_type` được thêm ở migration `00021_supplier_financial_type.sql`
(Phase UP1) bằng một `UPDATE ... CASE code WHEN 'NCC01' THEN 'company' ... ELSE 'business_household' END`
— tức là 6 mã đầu (NCC01–NCC06) có type **thật, do user xác nhận lúc đó**; bất kỳ NCC nào không nằm
trong danh sách 6 mã đó đều rơi vào nhánh `ELSE` (mặc định im lặng, không phải do user xác nhận).

| Mã NCC | Tên | supplier_type hiện tại | Nguồn | invoice_count | Trạng thái |
| --- | --- | --- | --- | --- | --- |
| NCC01 | Bích Đại (Công ty Huy Hoàng) | company | Mapping tường minh (00021) | 1 | ✅ CONFIRMED |
| NCC02 | Vinh Thủy (Nhất Long) | business_household | Mapping tường minh (00021) | 0 | ✅ CONFIRMED |
| NCC03 | Tuấn Hậu | company | Mapping tường minh (00021) | 0 | ✅ CONFIRMED |
| NCC04 | Minh Hoa | business_household | Mapping tường minh (00021) | 1 | ✅ CONFIRMED |
| NCC05 | Giang Nhàn | company | Mapping tường minh (00021) | 1 | ✅ CONFIRMED |
| NCC06 | A Phong | company | Tạo mới sau UP1, qua form `/suppliers` (user tự chọn "Công ty") | 0 | ✅ CONFIRMED |
| NCC07 | Gụ Hiền | business_household | Tạo mới sau UP1, qua form `/suppliers` — ban đầu không rõ có phải user chủ động chọn hay chỉ để mặc định của form | 0 | ✅ CONFIRMED (2026-09-25, user xác nhận giữ nguyên `business_household`) |

**Vì sao NCC07 ban đầu bị flag, dù đã có `supplier_type` khác NULL:**
Form tạo NCC (`supplier-form-dialog.tsx`) tự chọn sẵn `"business_household"` làm giá trị mặc định
của dropdown loại NCC (`useState(... || "business_household")`). NCC06 được tạo cùng đợt nhưng
kết thúc ở `"company"` — chứng tỏ user *có* đổi dropdown cho NCC06. NCC07 vẫn ở giá trị mặc định
`"business_household"`, nên ban đầu **không thể phân biệt** giữa "user xác nhận đúng là hộ kinh doanh"
và "user bấm lưu mà quên đổi dropdown". Theo đúng nguyên tắc của phase này — "KHÔNG tự động đoán loại
NCC nếu chưa có mapping rõ ràng" — báo cáo này đã hỏi lại thay vì mặc nhiên tin giá trị đang lưu.

**Đã xác nhận (2026-09-25):** user xác nhận NCC07 đúng là `business_household`, giữ nguyên giá trị đang
lưu — không cần UPDATE nào. Không có invoice nào của NCC07 nên dù thế nào cũng không có tác động số liệu
tài chính/công nợ đã ghi nhận.

## 2. Supplier-level discount/VAT defaults

Spec chuẩn của phase này yêu cầu backfill `default_vat_rate` (8% cho company, 0% cho hộ kinh doanh)
lên từng supplier. **Không áp dụng cho schema hiện tại**: từ migration `00021` (comment gốc), quyết định
kiến trúc là chiết khấu/VAT **không** được cấu hình mặc định ở cấp supplier — chúng được chọn và snapshot
theo từng invoice (`calculateInvoiceFinancials`, `src/lib/invoices/financials.ts`). Bảng `suppliers` không
có cột `default_vat_rate`/`default_discount_*` nào cả. VAT 8% cho company chỉ là **hằng số mặc định của
form tạo hóa đơn** (`DEFAULT_COMPANY_VAT_RATE = 8`), có thể chỉnh lại theo từng hóa đơn — không phải giá
trị lưu trên supplier. Không có gì để backfill ở mục này; nêu ra để tường minh là đã xem xét, không bỏ sót.

## 3. Invoice audit

3 hóa đơn hiện có trong `invoices`. Với mỗi hóa đơn, câu hỏi cần trả lời là: **giá trị
`subtotal`/`discount_*`/`vat_*`/`final_amount` đang lưu có phải là snapshot thật (do
`calculateInvoiceFinancials` tính từ lựa chọn thật của user), hay là placeholder trung tính mà migration
`00022_invoice_financial_snapshot.sql` gán cho dữ liệu cũ (`discount_amount = 0, vat_amount = 0,
subtotal = final_amount = SUM(line_total)`)?**

| Số HĐ | NCC | Loại NCC | Tạm tính | Chiết khấu | VAT | Tổng phải trả | Nguồn dữ liệu | Trạng thái |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 63 | NCC01 — Bích Đại | company | 106.145.000 | 0 | 8.491.600 (8%) | 114.636.600 | VAT 8% khớp đúng rule công ty, không phải giá trị 0 trung tính | ✅ Không cần backfill |
| 00000038 | NCC04 — Minh Hoa | business_household | 69.700.000 | 370.400 (fixed_amount) | 0 | 69.329.600 | Có `discount_type`/`discount_value` cụ thể, không phải NULL/0 trung tính | ✅ Không cần backfill |
| 29 | NCC05 — Giang Nhàn | company | 125.900.000 | 0 | 10.072.000 (8%) | 135.972.000 | VAT 8% khớp đúng rule công ty, không phải giá trị 0 trung tính | ✅ Không cần backfill |

**Kết luận: 0/3 hóa đơn cần backfill.** Cả 3 hóa đơn hiện có đều đã được tạo (hoặc được sửa lại qua
`update_invoice`, Phase UP3) SAU khi financial snapshot (UP2) đi vào hoạt động, với discount/VAT thật do
user nhập — không có hóa đơn nào còn đứng ở trạng thái placeholder trung tính của migration `00022`.
Không có hóa đơn nào bị đánh dấu `NEEDS_REVIEW`.

(Ghi chú lịch sử: đợt import Excel legacy — `docs/import-run-result.json` — từng tạo 4 hóa đơn
`LEGACY-HD-*`. Không hóa đơn nào trong 4 hóa đơn đó còn tồn tại với đúng invoice_no đó ở thời điểm báo
cáo này — dữ liệu 3 hóa đơn hiện tại đã được user tạo/sửa lại bằng số hóa đơn thật (`63`, `00000038`,
`29`) qua form, không phải bản ghi legacy nguyên trạng.)

## 4. Đề xuất backfill — đã duyệt, kết quả: không cần chạy gì

| # | Hành động | Phạm vi | Kết quả |
| --- | --- | --- | --- |
| 1 | Xác nhận `suppliers.supplier_type` cho NCC07 | 1 dòng, 0 invoice liên quan | User xác nhận `business_household` đúng (2026-09-25) — **không UPDATE**, giá trị đang lưu giữ nguyên |
| — | Backfill `invoices.subtotal/discount_*/vat_*/final_amount` | *Không áp dụng — 0 hóa đơn cần (mục 3)* | Không chạy |
| — | Backfill `suppliers.default_vat_rate` | *Không áp dụng — cột này không tồn tại theo thiết kế (mục 2)* | Không chạy |

**Kết luận:** Phase UP6 không cần một migration SQL nào — mọi dữ liệu tài chính hiện có (7 suppliers,
3 invoices) đã ở trạng thái đúng/đã xác nhận. Không có thay đổi nào được áp dụng lên `suppliers` hay
`invoices`. Xem `docs/financial-policy-reconciliation.md` để đối soát số liệu chi tiết.
