# Financial Policy Reconciliation Report — PHASE UP6

Tạo lúc: 2026-09-25T01:55:56.677Z

Đây là báo cáo **đối soát** cho bước backfill của Phase UP6. Vì mục 3 của
`docs/financial-policy-migration-preview.md` kết luận **0/3 hóa đơn cần backfill** (toàn bộ hóa đơn hiện
có đều đã mang giá trị snapshot thật, không phải placeholder trung tính), báo cáo này đóng vai trò xác
nhận không có gì cần sửa — không phải mô tả một thay đổi sắp xảy ra.

"Old" dưới đây = tổng tiền hàng thô (SUM(invoice_items.line_total), tức là đúng bằng `subtotal` — cách
tính duy nhất tồn tại **trước** khi có discount/VAT ở Phase UP1/UP2). "New" = `final_amount` đang lưu
hiện tại (đã áp dụng chiết khấu/VAT theo policy UP1-UP4).

## Theo invoice

| Số HĐ | NCC | Old (subtotal thô) | Chiết khấu | VAT | New (final_amount) | Chênh lệch (new − old) |
| --- | --- | --- | --- | --- | --- | --- |
| 63 | NCC01 — Bích Đại | 106.145.000 | 0 | 8.491.600 | 114.636.600 | +8.491.600 |
| 00000038 | NCC04 — Minh Hoa | 69.700.000 | 370.400 | 0 | 69.329.600 | −370.400 |
| 29 | NCC05 — Giang Nhàn | 125.900.000 | 0 | 10.072.000 | 135.972.000 | +10.072.000 |

Toàn bộ chênh lệch ở trên là **chênh lệch do policy** (VAT cộng thêm cho công ty, chiết khấu trừ bớt cho
hộ kinh doanh) — đây chính là mục đích của Phase UP1-UP4, không phải lỗi cần sửa. `final_amount` ở cột
"New" đã là giá trị đang thật sự dùng để tính công nợ (`v_invoice_debt`) từ trước, không có gì thay đổi
khi chạy phase này.

## Theo supplier

| NCC | Loại NCC | Subtotal | Chiết khấu | VAT | Final amount |
| --- | --- | --- | --- | --- | --- |
| NCC01 — Bích Đại | company | 106.145.000 | 0 | 8.491.600 | 114.636.600 |
| NCC04 — Minh Hoa | business_household | 69.700.000 | 370.400 | 0 | 69.329.600 |
| NCC05 — Giang Nhàn | company | 125.900.000 | 0 | 10.072.000 | 135.972.000 |

(NCC02, NCC03, NCC06, NCC07 không có hóa đơn nào — không xuất hiện trong bảng này.)

## Overall

| | Số tiền |
| --- | --- |
| Total old (Σ subtotal) | 301.745.000 |
| Total new (Σ final_amount) | 319.938.200 |
| Variance (new − old) | +18.193.200 |
| — trong đó Σ VAT | +18.563.600 |
| — trong đó Σ chiết khấu | −370.400 |

Variance khớp đúng: `18.563.600 − 370.400 = 18.193.200`.

## Debt reconciliation

So sánh remaining debt nếu tính theo "old" (không có discount/VAT, tức old − paid) với "new" (đang dùng
thật sự trong `v_invoice_debt`, tức final_amount − paid):

| Số HĐ | Paid hiện tại | Old remaining (old − paid) | New remaining (final_amount − paid) | Chênh lệch | Flag |
| --- | --- | --- | --- | --- | --- |
| 63 | 0 | 106.145.000 | 114.636.600 | +8.491.600 | ⚠️ Khác — nhưng là chênh lệch **có chủ đích** (VAT), không phải lỗi. `v_invoice_debt` đã dùng đúng cột "New" từ Phase UP4. |
| 00000038 | 0 | 69.700.000 | 69.329.600 | −370.400 | ⚠️ Khác — chênh lệch **có chủ đích** (chiết khấu), không phải lỗi. |
| 29 | 0 | 125.900.000 | 135.972.000 | +10.072.000 | ⚠️ Khác — chênh lệch **có chủ đích** (VAT), không phải lỗi. |

**Không có invoice nào cần flag là lỗi/anomaly.** Cả 3 chênh lệch trên đều là kết quả đúng của việc áp
dụng chiết khấu/VAT theo policy mới, và đây chính xác là các con số `remaining_amount` mà `/debts` và
`/dashboard` đã hiển thị từ Phase UP4/UP5 — không có backfill nào làm thay đổi số nợ hiện tại của bất kỳ
ai. Không có hóa đơn "cũ" nào (theo nghĩa: tạo trước UP2, còn mang giá trị trung tính) tồn tại trong hệ
thống ở thời điểm báo cáo này.

## Kết luận

- Không cần chạy migration backfill nào cho `invoices` (0/3 cần review, 0/3 cần sửa).
- Không cần thêm cột default VAT/discount ở `suppliers` (không đúng kiến trúc hiện tại — xem mục 2 của
  preview report).
- `supplier_type` của NCC07 đã được user xác nhận là `business_household` (2026-09-25, xem preview report
  mục 1 và 4) — không có UPDATE nào cần chạy, không có tác động số liệu vì NCC07 chưa có hóa đơn nào.
