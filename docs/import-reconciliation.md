# Import Reconciliation Report — Legacy Excel

Tạo lúc: 2026-09-22T04:04:11.541Z

## Danh mục

| | |
| --- | --- |
| Số NCC | 5 |
| Sản phẩm đã có trong DB | 141 |
| Sản phẩm mới sẽ thêm | 0 |

## Receipts (theo receipt_items tính toán lại từ chi tiết, KHÔNG dùng cột tổng hợp trong sheet)

| | |
| --- | --- |
| Số phiếu nhập | 757 |
| Số dòng hàng | 3604 |
| Tổng SL giao | 43.608 |
| Tổng SL nhận | 43.600 |
| Tổng chênh lệch (nhận - giao) | -8 |
| Tổng line_total | 1.985.264.700 |
| Tổng ca sáng | 1.289.125.700 |
| Tổng ca chiều | 696.139.000 |
| Sáng + Chiều (kiểm tra) | 1.985.264.700 — phải bằng Tổng line_total ở trên |

## Đối soát theo ngày + NCC (so với cột Tổng Tiền / VAT / Tổng Tiền VAT trong sheet)

Tổng 475 tổ hợp (ngày, NCC) có dữ liệu. **Khớp: 471. Lệch: 4.**

⚠️ Có 4 tổ hợp lệch — xem chi tiết bên dưới:

| Ngày | NCC | Tính từ receipt_items | Trong sheet | Lệch | Giải thích |
| --- | --- | --- | --- | --- | --- |
| 2026-07-19 | Bích Đại (Công ty Huy Hoàng) | 2.355.000 | 2.555.000 | -200.000 | ⚠️ Do lỗi gõ tay cột "Thành Tiền" trong sheet gốc — xem bảng bên dưới. |
| 2026-09-01 | Tuấn Hậu | 21.482.000 | 21.446.000 | 36.000 | ⚠️ Do lỗi gõ tay cột "Thành Tiền" trong sheet gốc — xem bảng bên dưới. |
| 2026-09-14 | Giang Nhàn | 3.529.000 | 3.475.000 | 54.000 | ✅ Do sửa ngày 1 dòng thiếu ngày (đã xác nhận với user) — sheet gốc chưa từng tính dòng này vào tổng vì để trống ngày. |
| 2026-09-17 | Tuấn Hậu | 16.417.000 | 16.422.000 | -5.000 | ⚠️ Do lỗi gõ tay cột "Thành Tiền" trong sheet gốc — xem bảng bên dưới. |

### Nguyên nhân lệch (nếu có): lỗi nhập liệu trong file Excel gốc

Cột "Thành Tiền" trong Lich Su về nguyên tắc là công thức Đơn giá × SL Nhận, nhưng 4 dòng trong
file gốc có giá trị **gõ tay khác với công thức** — đây là lỗi có sẵn trong Excel, không phải lỗi import. Toàn bộ số liệu lệch
ở bảng trên đều xuất phát từ các dòng này. Import vẫn đúng vì receipt_items.line_total luôn được tính lại từ
Đơn giá × SL Nhận, không lấy giá trị "Thành Tiền" của sheet.

| Dòng | Ngày | NCC | SKU | Đơn giá | SL Nhận | Đơn giá×SL Nhận | "Thành Tiền" trong sheet | Lệch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 366 | 2026-09-17 | Tuấn Hậu | tham_bali_trai_san_80cmx1m5 | 75.000 | 1 | 75.000 | 80.000 | 5.000 |
| 1406 | 2026-09-01 | Tuấn Hậu | tham_bali_chui_chan_50cmx70cm | 16.000 | 12 | 192.000 | 180.000 | -12.000 |
| 1430 | 2026-09-01 | Tuấn Hậu | tham_bali_chui_chan_50cmx70cm | 16.000 | 24 | 384.000 | 360.000 | -24.000 |
| 2190 | 2026-07-19 | Bích Đại (Công ty Huy Hoàng) | ga_chong_tham_1m6x2mx10cm | 40.000 | 10 | 400.000 | 600.000 | 200.000 |

## Invoices

| | |
| --- | --- |
| Số hóa đơn | 4 |
| Số dòng hàng hóa đơn | 51 |
| Tổng tiền hóa đơn | 301.745.000 |
