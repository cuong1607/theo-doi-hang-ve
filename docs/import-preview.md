# Import Preview Report — Legacy Excel

Nguồn: `src/THEO DOI HANG VE.xlsx` (không sửa file gốc)
Tạo lúc: 2026-09-22T04:04:11.540Z

## 1. Danh Muc → suppliers / products

| | Số lượng |
| --- | --- |
| Nhà cung cấp trong sheet | 5 |
| NCC mới cần tạo | 0 (cả 5 NCC trong sheet đã tồn tại trong DB: Vinh Thủy (Nhất Long), Tuấn Hậu, Minh Hoa, Giang Nhàn, Bích Đại (Công ty Huy Hoàng)) |
| Sản phẩm trong sheet | 148 |
| Sản phẩm đã có trong DB | 141 |
| Sản phẩm mới cần tạo | 0 |
| Sản phẩm bỏ qua (hàng cũ không bán nữa, không có giá) | 7 |

### Sản phẩm mới sẽ được thêm

| SKU | Tên | Đơn vị | Giá |
| --- | --- | --- | --- |


### Sản phẩm bỏ qua (không tạo — xác nhận là hàng cũ không còn bán)

| SKU | Tên | Đơn vị |
| --- | --- | --- |
| nem_topper_1m5x1m9 | Nệm Topper 1m5x1m9 | chiec |
| nem_topper_long_cuu_90cmx1m9 | Nệm Topper Lông Cừu 90cmx1m9 | chiec |
| nem_topper_long_cuu_1m2x2m | Nệm Topper Lông Cừu 1m2x2m | chiec |
| nem_topper_long_cuu_1m6x2m | Nệm Topper Lông Cừu 1m6x2m | chiec |
| nem_topper_long_cuu_1m8x2m | Nệm Topper Lông Cừu 1m8x2m | chiec |
| nem_topper_long_cuu_1mx1m9 | Nệm Topper Lông Cừu 1mx1m9 | chiec |
| nem_topper_long_cuu_2mx2m2 | Nệm Topper Lông Cừu 2mx2m2 | chiec |

## 2. Lich Su → receipts / receipt_items

Chiến lược group (đã được người dùng xác nhận): mỗi tổ hợp **(ngày, ca, nhà cung cấp)** xuất hiện trong sheet trở thành **một phiếu nhập**,
bất kể các dòng của tổ hợp đó nằm rải rác ở đâu trong sheet (đây là giả định group cho dữ liệu legacy, không phải ràng buộc
trong DB — DB vẫn cho phép nhiều phiếu cùng ngày+ca+NCC). Nếu một SKU xuất hiện nhiều lần trong cùng tổ hợp, các dòng đó được
gộp thành 1 dòng hàng (cộng dồn SL giao / SL nhận) — chỉ gộp khi đơn giá giống nhau ở mọi lần xuất hiện.

Cột "Tổng Tiền / VAT(8%) / Tổng Tiền VAT" trong sheet **không được import vào receipt_items** — đây là tổng theo
(ngày, nhà cung cấp) gộp cả 2 ca do sheet tự tính, chỉ dùng để đối soát ở báo cáo reconciliation.

| | Số lượng |
| --- | --- |
| Tổng số dòng trong sheet (không tính dòng trống) | 3646 |
| Dòng chi tiết (detail rows) | 3646 |
| Dòng tổng hợp bị bỏ qua (summary rows) | 0 (sheet không có dòng "cả ngày" riêng — chỉ có các cột tổng hợp bị loại trừ như trên) |
| Không hợp lệ (Invalid — thiếu ngày/trường bắt buộc) | 0 |
| SKU lạ (Unknown SKU — không có trong Danh Muc, cần xem thủ công) | 0 |
| NCC lạ (Unknown supplier) | 0 |
| Trùng SKU nhưng đơn giá khác nhau (cần xem thủ công) | 0 |
| Trùng SKU đã tự gộp (cùng đơn giá) | 42 dòng gộp vào dòng hàng đã có |
| Sẵn sàng import (valid rows) | 3646 |
| → Số phiếu nhập (receipts) sẽ tạo | 757 |
| → Số dòng hàng (receipt_items) sẽ tạo | 3604 |

### Invalid rows

_Không có._


### Unknown SKU rows

_Không có._


### Unknown supplier rows

_Không có._


### Price-conflict duplicate rows

_Không có._


## 3. Lich_Su_Hoa_Don → invoices / invoice_items

Chiến lược group: mỗi giá trị timestamp cột "Ngày Lưu" là một lần lưu hóa đơn → một invoice (đã kiểm chứng: mỗi nhóm
timestamp chỉ có 1 NCC + 1 ngày XH duy nhất, không có SKU trùng trong nhóm).

| | Số lượng |
| --- | --- |
| Tổng số dòng trong sheet | 51 |
| Không hợp lệ | 0 |
| SKU lạ | 0 |
| NCC lạ | 0 |
| → Số hóa đơn (invoices) sẽ tạo | 4 |
| → Số dòng hàng (invoice_items) sẽ tạo | 51 |

## 4. Danh sách phiếu nhập sẽ tạo (tóm tắt)

| Ngày | Ca | NCC | Số dòng hàng | receipt_no |
| --- | --- | --- | --- | --- |
| 2026-03-16 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260316-S-NCC05 |
| 2026-03-23 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260323-S-NCC01 |
| 2026-03-24 | Sáng | Bích Đại (Công ty Huy Hoàng) | 11 | LEGACY-PN-20260324-S-NCC01 |
| 2026-03-25 | Sáng | Bích Đại (Công ty Huy Hoàng) | 12 | LEGACY-PN-20260325-S-NCC01 |
| 2026-03-25 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260325-S-NCC05 |
| 2026-03-27 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260327-S-NCC01 |
| 2026-03-27 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260327-S-NCC05 |
| 2026-03-28 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260328-S-NCC05 |
| 2026-03-30 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260330-C-NCC05 |
| 2026-03-30 | Sáng | Bích Đại (Công ty Huy Hoàng) | 9 | LEGACY-PN-20260330-S-NCC01 |
| 2026-03-30 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260330-S-NCC05 |
| 2026-03-31 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260331-S-NCC01 |
| 2026-04-01 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260401-C-NCC01 |
| 2026-04-01 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260401-S-NCC01 |
| 2026-04-01 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260401-S-NCC05 |
| 2026-04-02 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260402-C-NCC01 |
| 2026-04-02 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260402-C-NCC05 |
| 2026-04-03 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260403-S-NCC05 |
| 2026-04-04 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260404-S-NCC01 |
| 2026-04-05 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260405-S-NCC01 |
| 2026-04-05 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260405-S-NCC05 |
| 2026-04-06 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260406-S-NCC01 |
| 2026-04-06 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260406-S-NCC05 |
| 2026-04-07 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260407-S-NCC01 |
| 2026-04-07 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260407-S-NCC05 |
| 2026-04-08 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260408-C-NCC01 |
| 2026-04-08 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260408-S-NCC01 |
| 2026-04-08 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260408-S-NCC05 |
| 2026-04-09 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260409-C-NCC01 |
| 2026-04-09 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260409-S-NCC01 |
| 2026-04-09 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260409-S-NCC05 |
| 2026-04-10 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260410-C-NCC01 |
| 2026-04-10 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260410-S-NCC01 |
| 2026-04-10 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260410-S-NCC05 |
| 2026-04-11 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260411-C-NCC01 |
| 2026-04-11 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260411-S-NCC01 |
| 2026-04-11 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260411-S-NCC05 |
| 2026-04-12 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260412-S-NCC01 |
| 2026-04-12 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260412-S-NCC05 |
| 2026-04-13 | Chiều | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260413-C-NCC01 |
| 2026-04-13 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260413-S-NCC01 |
| 2026-04-14 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260414-S-NCC01 |
| 2026-04-15 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260415-C-NCC01 |
| 2026-04-15 | Sáng | Bích Đại (Công ty Huy Hoàng) | 9 | LEGACY-PN-20260415-S-NCC01 |
| 2026-04-15 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260415-S-NCC05 |
| 2026-04-16 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260416-S-NCC01 |
| 2026-04-16 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260416-S-NCC05 |
| 2026-04-17 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260417-S-NCC01 |
| 2026-04-17 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260417-S-NCC05 |
| 2026-04-18 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260418-S-NCC01 |
| 2026-04-18 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260418-S-NCC05 |
| 2026-04-20 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260420-S-NCC01 |
| 2026-04-20 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260420-S-NCC05 |
| 2026-04-21 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260421-S-NCC05 |
| 2026-04-22 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260422-C-NCC01 |
| 2026-04-22 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260422-S-NCC01 |
| 2026-04-22 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260422-S-NCC05 |
| 2026-04-23 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260423-S-NCC01 |
| 2026-04-23 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260423-S-NCC05 |
| 2026-04-24 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260424-C-NCC01 |
| 2026-04-24 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260424-S-NCC01 |
| 2026-04-24 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260424-S-NCC05 |
| 2026-04-25 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260425-C-NCC01 |
| 2026-04-25 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260425-S-NCC05 |
| 2026-04-27 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260427-C-NCC01 |
| 2026-04-27 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260427-S-NCC01 |
| 2026-04-27 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260427-S-NCC05 |
| 2026-04-28 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260428-S-NCC05 |
| 2026-04-29 | Chiều | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260429-C-NCC01 |
| 2026-04-29 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260429-S-NCC01 |
| 2026-04-29 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260429-S-NCC05 |
| 2026-05-02 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260502-C-NCC01 |
| 2026-05-02 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260502-C-NCC05 |
| 2026-05-02 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260502-S-NCC01 |
| 2026-05-02 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260502-S-NCC05 |
| 2026-05-03 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260503-S-NCC01 |
| 2026-05-03 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260503-S-NCC05 |
| 2026-05-04 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260504-C-NCC01 |
| 2026-05-04 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260504-C-NCC05 |
| 2026-05-04 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260504-S-NCC01 |
| 2026-05-04 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260504-S-NCC05 |
| 2026-05-05 | Chiều | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260505-C-NCC01 |
| 2026-05-05 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260505-C-NCC05 |
| 2026-05-05 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260505-S-NCC01 |
| 2026-05-05 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260505-S-NCC05 |
| 2026-05-06 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260506-C-NCC01 |
| 2026-05-06 | Chiều | Giang Nhàn | 1 | LEGACY-PN-20260506-C-NCC05 |
| 2026-05-06 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260506-S-NCC01 |
| 2026-05-06 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260506-S-NCC05 |
| 2026-05-07 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260507-C-NCC01 |
| 2026-05-07 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260507-C-NCC05 |
| 2026-05-07 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260507-S-NCC01 |
| 2026-05-07 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260507-S-NCC05 |
| 2026-05-08 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260508-C-NCC05 |
| 2026-05-08 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260508-S-NCC01 |
| 2026-05-08 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260508-S-NCC05 |
| 2026-05-09 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260509-S-NCC05 |
| 2026-05-10 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260510-S-NCC01 |
| 2026-05-10 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260510-S-NCC05 |
| 2026-05-11 | Sáng | Bích Đại (Công ty Huy Hoàng) | 12 | LEGACY-PN-20260511-S-NCC01 |
| 2026-05-11 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260511-S-NCC05 |
| 2026-05-12 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260512-C-NCC01 |
| 2026-05-12 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260512-C-NCC05 |
| 2026-05-12 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260512-S-NCC01 |
| 2026-05-12 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260512-S-NCC05 |
| 2026-05-13 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260513-C-NCC05 |
| 2026-05-13 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260513-S-NCC05 |
| 2026-05-14 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260514-C-NCC05 |
| 2026-05-14 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260514-S-NCC01 |
| 2026-05-14 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260514-S-NCC05 |
| 2026-05-15 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260515-C-NCC01 |
| 2026-05-15 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260515-C-NCC05 |
| 2026-05-15 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260515-S-NCC05 |
| 2026-05-16 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260516-C-NCC01 |
| 2026-05-16 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260516-C-NCC05 |
| 2026-05-16 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260516-S-NCC05 |
| 2026-05-17 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260517-S-NCC01 |
| 2026-05-18 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260518-C-NCC01 |
| 2026-05-18 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260518-C-NCC05 |
| 2026-05-18 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260518-S-NCC01 |
| 2026-05-18 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260518-S-NCC05 |
| 2026-05-19 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260519-C-NCC05 |
| 2026-05-19 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260519-S-NCC05 |
| 2026-05-20 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260520-C-NCC01 |
| 2026-05-20 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260520-C-NCC05 |
| 2026-05-20 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260520-S-NCC05 |
| 2026-05-21 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260521-C-NCC05 |
| 2026-05-21 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260521-S-NCC01 |
| 2026-05-21 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260521-S-NCC04 |
| 2026-05-21 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260521-S-NCC05 |
| 2026-05-22 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260522-C-NCC05 |
| 2026-05-22 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260522-S-NCC01 |
| 2026-05-22 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260522-S-NCC05 |
| 2026-05-23 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260523-S-NCC01 |
| 2026-05-23 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260523-S-NCC05 |
| 2026-05-24 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260524-S-NCC01 |
| 2026-05-24 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260524-S-NCC04 |
| 2026-05-24 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260524-S-NCC05 |
| 2026-05-25 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260525-C-NCC04 |
| 2026-05-25 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260525-S-NCC01 |
| 2026-05-25 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260525-S-NCC05 |
| 2026-05-26 | Chiều | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260526-C-NCC01 |
| 2026-05-26 | Sáng | Bích Đại (Công ty Huy Hoàng) | 9 | LEGACY-PN-20260526-S-NCC01 |
| 2026-05-26 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260526-S-NCC04 |
| 2026-05-26 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260526-S-NCC05 |
| 2026-05-27 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260527-S-NCC01 |
| 2026-05-27 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260527-S-NCC05 |
| 2026-05-28 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260528-S-NCC01 |
| 2026-05-28 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260528-S-NCC05 |
| 2026-05-29 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260529-C-NCC01 |
| 2026-05-29 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260529-S-NCC01 |
| 2026-05-29 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260529-S-NCC04 |
| 2026-05-29 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260529-S-NCC05 |
| 2026-05-30 | Chiều | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260530-C-NCC01 |
| 2026-05-30 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260530-S-NCC05 |
| 2026-05-31 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260531-S-NCC05 |
| 2026-06-01 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260601-C-NCC01 |
| 2026-06-01 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260601-C-NCC05 |
| 2026-06-01 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260601-S-NCC01 |
| 2026-06-01 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260601-S-NCC04 |
| 2026-06-01 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260601-S-NCC05 |
| 2026-06-02 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260602-C-NCC01 |
| 2026-06-02 | Chiều | Giang Nhàn | 1 | LEGACY-PN-20260602-C-NCC05 |
| 2026-06-02 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260602-S-NCC05 |
| 2026-06-03 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260603-C-NCC05 |
| 2026-06-03 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260603-S-NCC01 |
| 2026-06-03 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260603-S-NCC04 |
| 2026-06-03 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260603-S-NCC05 |
| 2026-06-04 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260604-C-NCC04 |
| 2026-06-04 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260604-C-NCC05 |
| 2026-06-04 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260604-S-NCC01 |
| 2026-06-04 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260604-S-NCC04 |
| 2026-06-04 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260604-S-NCC05 |
| 2026-06-05 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260605-C-NCC05 |
| 2026-06-05 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260605-S-NCC01 |
| 2026-06-05 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260605-S-NCC04 |
| 2026-06-05 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260605-S-NCC05 |
| 2026-06-06 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260606-C-NCC04 |
| 2026-06-06 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260606-C-NCC05 |
| 2026-06-06 | Sáng | Bích Đại (Công ty Huy Hoàng) | 10 | LEGACY-PN-20260606-S-NCC01 |
| 2026-06-06 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260606-S-NCC04 |
| 2026-06-06 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260606-S-NCC05 |
| 2026-06-07 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260607-S-NCC01 |
| 2026-06-07 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260607-S-NCC04 |
| 2026-06-07 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260607-S-NCC05 |
| 2026-06-08 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260608-C-NCC04 |
| 2026-06-08 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260608-C-NCC05 |
| 2026-06-08 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260608-S-NCC01 |
| 2026-06-08 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260608-S-NCC05 |
| 2026-06-09 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260609-C-NCC04 |
| 2026-06-09 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260609-C-NCC05 |
| 2026-06-09 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260609-S-NCC01 |
| 2026-06-09 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260609-S-NCC05 |
| 2026-06-10 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260610-C-NCC01 |
| 2026-06-10 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260610-C-NCC04 |
| 2026-06-10 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260610-C-NCC05 |
| 2026-06-10 | Sáng | Bích Đại (Công ty Huy Hoàng) | 11 | LEGACY-PN-20260610-S-NCC01 |
| 2026-06-10 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260610-S-NCC04 |
| 2026-06-10 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260610-S-NCC05 |
| 2026-06-11 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260611-C-NCC04 |
| 2026-06-11 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260611-C-NCC05 |
| 2026-06-11 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260611-S-NCC01 |
| 2026-06-11 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260611-S-NCC04 |
| 2026-06-11 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260611-S-NCC05 |
| 2026-06-12 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260612-C-NCC01 |
| 2026-06-12 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260612-C-NCC04 |
| 2026-06-12 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260612-C-NCC05 |
| 2026-06-12 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260612-S-NCC01 |
| 2026-06-12 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260612-S-NCC05 |
| 2026-06-13 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260613-C-NCC05 |
| 2026-06-13 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260613-S-NCC04 |
| 2026-06-13 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260613-S-NCC05 |
| 2026-06-14 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260614-S-NCC01 |
| 2026-06-14 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260614-S-NCC04 |
| 2026-06-14 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260614-S-NCC05 |
| 2026-06-15 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260615-C-NCC01 |
| 2026-06-15 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260615-C-NCC05 |
| 2026-06-15 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260615-S-NCC01 |
| 2026-06-15 | Sáng | Minh Hoa | 7 | LEGACY-PN-20260615-S-NCC04 |
| 2026-06-16 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260616-C-NCC04 |
| 2026-06-16 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260616-C-NCC05 |
| 2026-06-16 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260616-S-NCC01 |
| 2026-06-16 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260616-S-NCC05 |
| 2026-06-17 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260617-C-NCC04 |
| 2026-06-17 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260617-C-NCC05 |
| 2026-06-17 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260617-S-NCC01 |
| 2026-06-17 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260617-S-NCC04 |
| 2026-06-17 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260617-S-NCC05 |
| 2026-06-18 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260618-C-NCC01 |
| 2026-06-18 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260618-C-NCC05 |
| 2026-06-18 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260618-S-NCC05 |
| 2026-06-19 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260619-C-NCC04 |
| 2026-06-19 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260619-C-NCC05 |
| 2026-06-19 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260619-S-NCC01 |
| 2026-06-19 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260619-S-NCC04 |
| 2026-06-19 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260619-S-NCC05 |
| 2026-06-20 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260620-C-NCC01 |
| 2026-06-20 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260620-C-NCC05 |
| 2026-06-20 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260620-S-NCC01 |
| 2026-06-20 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260620-S-NCC04 |
| 2026-06-20 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260620-S-NCC05 |
| 2026-06-21 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260621-S-NCC01 |
| 2026-06-21 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260621-S-NCC04 |
| 2026-06-21 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260621-S-NCC05 |
| 2026-06-22 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260622-C-NCC04 |
| 2026-06-22 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260622-C-NCC05 |
| 2026-06-22 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260622-S-NCC01 |
| 2026-06-22 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260622-S-NCC04 |
| 2026-06-22 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260622-S-NCC05 |
| 2026-06-23 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260623-C-NCC04 |
| 2026-06-23 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260623-C-NCC05 |
| 2026-06-23 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260623-S-NCC01 |
| 2026-06-23 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260623-S-NCC04 |
| 2026-06-23 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260623-S-NCC05 |
| 2026-06-24 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260624-C-NCC01 |
| 2026-06-24 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260624-C-NCC04 |
| 2026-06-24 | Chiều | Giang Nhàn | 1 | LEGACY-PN-20260624-C-NCC05 |
| 2026-06-24 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260624-S-NCC04 |
| 2026-06-24 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260624-S-NCC05 |
| 2026-06-25 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260625-C-NCC01 |
| 2026-06-25 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260625-C-NCC05 |
| 2026-06-25 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260625-S-NCC01 |
| 2026-06-25 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260625-S-NCC04 |
| 2026-06-25 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260625-S-NCC05 |
| 2026-06-26 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260626-C-NCC05 |
| 2026-06-26 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260626-S-NCC01 |
| 2026-06-26 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260626-S-NCC04 |
| 2026-06-26 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260626-S-NCC05 |
| 2026-06-27 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260627-C-NCC01 |
| 2026-06-27 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260627-C-NCC04 |
| 2026-06-27 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260627-C-NCC05 |
| 2026-06-27 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260627-S-NCC01 |
| 2026-06-27 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260627-S-NCC04 |
| 2026-06-27 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260627-S-NCC05 |
| 2026-06-28 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260628-S-NCC04 |
| 2026-06-28 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260628-S-NCC05 |
| 2026-06-29 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260629-C-NCC05 |
| 2026-06-29 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260629-S-NCC01 |
| 2026-06-29 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260629-S-NCC04 |
| 2026-06-29 | Sáng | Giang Nhàn | 7 | LEGACY-PN-20260629-S-NCC05 |
| 2026-06-30 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260630-C-NCC01 |
| 2026-06-30 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260630-C-NCC04 |
| 2026-06-30 | Chiều | Giang Nhàn | 6 | LEGACY-PN-20260630-C-NCC05 |
| 2026-06-30 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260630-S-NCC01 |
| 2026-06-30 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260630-S-NCC04 |
| 2026-06-30 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260630-S-NCC05 |
| 2026-07-01 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260701-C-NCC05 |
| 2026-07-01 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260701-S-NCC01 |
| 2026-07-01 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260701-S-NCC04 |
| 2026-07-01 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260701-S-NCC05 |
| 2026-07-02 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260702-C-NCC01 |
| 2026-07-02 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260702-C-NCC05 |
| 2026-07-02 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260702-S-NCC01 |
| 2026-07-02 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260702-S-NCC04 |
| 2026-07-02 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260702-S-NCC05 |
| 2026-07-03 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260703-C-NCC04 |
| 2026-07-03 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260703-C-NCC05 |
| 2026-07-03 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260703-S-NCC04 |
| 2026-07-03 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260703-S-NCC05 |
| 2026-07-04 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260704-C-NCC04 |
| 2026-07-04 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260704-C-NCC05 |
| 2026-07-04 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260704-S-NCC01 |
| 2026-07-04 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260704-S-NCC04 |
| 2026-07-04 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260704-S-NCC05 |
| 2026-07-05 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260705-S-NCC04 |
| 2026-07-05 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260705-S-NCC05 |
| 2026-07-06 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260706-C-NCC04 |
| 2026-07-06 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260706-C-NCC05 |
| 2026-07-06 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260706-S-NCC01 |
| 2026-07-06 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260706-S-NCC04 |
| 2026-07-06 | Sáng | Giang Nhàn | 7 | LEGACY-PN-20260706-S-NCC05 |
| 2026-07-07 | Chiều | Bích Đại (Công ty Huy Hoàng) | 9 | LEGACY-PN-20260707-C-NCC01 |
| 2026-07-07 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260707-C-NCC04 |
| 2026-07-07 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260707-C-NCC05 |
| 2026-07-07 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260707-S-NCC01 |
| 2026-07-07 | Sáng | Minh Hoa | 8 | LEGACY-PN-20260707-S-NCC04 |
| 2026-07-07 | Sáng | Giang Nhàn | 7 | LEGACY-PN-20260707-S-NCC05 |
| 2026-07-08 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260708-C-NCC04 |
| 2026-07-08 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260708-C-NCC05 |
| 2026-07-08 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260708-S-NCC01 |
| 2026-07-08 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260708-S-NCC04 |
| 2026-07-08 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260708-S-NCC05 |
| 2026-07-09 | Chiều | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260709-C-NCC01 |
| 2026-07-09 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260709-C-NCC04 |
| 2026-07-09 | Chiều | Giang Nhàn | 6 | LEGACY-PN-20260709-C-NCC05 |
| 2026-07-09 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260709-S-NCC01 |
| 2026-07-09 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260709-S-NCC04 |
| 2026-07-09 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260709-S-NCC05 |
| 2026-07-10 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260710-C-NCC01 |
| 2026-07-10 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260710-C-NCC04 |
| 2026-07-10 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260710-C-NCC05 |
| 2026-07-10 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260710-S-NCC01 |
| 2026-07-10 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260710-S-NCC05 |
| 2026-07-11 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260711-C-NCC01 |
| 2026-07-11 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260711-C-NCC04 |
| 2026-07-11 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260711-C-NCC05 |
| 2026-07-11 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260711-S-NCC01 |
| 2026-07-11 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260711-S-NCC04 |
| 2026-07-11 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260711-S-NCC05 |
| 2026-07-12 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260712-S-NCC04 |
| 2026-07-12 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260712-S-NCC05 |
| 2026-07-13 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260713-C-NCC05 |
| 2026-07-13 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260713-S-NCC01 |
| 2026-07-13 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260713-S-NCC04 |
| 2026-07-13 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260713-S-NCC05 |
| 2026-07-14 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260714-C-NCC01 |
| 2026-07-14 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260714-C-NCC05 |
| 2026-07-14 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260714-S-NCC01 |
| 2026-07-14 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260714-S-NCC04 |
| 2026-07-14 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260714-S-NCC05 |
| 2026-07-15 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260715-C-NCC01 |
| 2026-07-15 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260715-C-NCC04 |
| 2026-07-15 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260715-C-NCC05 |
| 2026-07-15 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260715-S-NCC01 |
| 2026-07-15 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260715-S-NCC04 |
| 2026-07-15 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260715-S-NCC05 |
| 2026-07-16 | Chiều | Bích Đại (Công ty Huy Hoàng) | 9 | LEGACY-PN-20260716-C-NCC01 |
| 2026-07-16 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260716-C-NCC05 |
| 2026-07-16 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260716-S-NCC04 |
| 2026-07-16 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260716-S-NCC05 |
| 2026-07-17 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260717-C-NCC04 |
| 2026-07-17 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260717-C-NCC05 |
| 2026-07-17 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260717-S-NCC01 |
| 2026-07-17 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260717-S-NCC04 |
| 2026-07-17 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260717-S-NCC05 |
| 2026-07-18 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260718-C-NCC01 |
| 2026-07-18 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260718-C-NCC04 |
| 2026-07-18 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260718-S-NCC01 |
| 2026-07-18 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260718-S-NCC04 |
| 2026-07-18 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260718-S-NCC05 |
| 2026-07-19 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260719-S-NCC01 |
| 2026-07-19 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260719-S-NCC04 |
| 2026-07-19 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260719-S-NCC05 |
| 2026-07-20 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260720-C-NCC05 |
| 2026-07-20 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260720-S-NCC01 |
| 2026-07-20 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260720-S-NCC04 |
| 2026-07-20 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260720-S-NCC05 |
| 2026-07-21 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260721-C-NCC01 |
| 2026-07-21 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260721-C-NCC04 |
| 2026-07-21 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260721-C-NCC05 |
| 2026-07-21 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260721-S-NCC01 |
| 2026-07-21 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260721-S-NCC04 |
| 2026-07-21 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260721-S-NCC05 |
| 2026-07-22 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260722-C-NCC01 |
| 2026-07-22 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260722-C-NCC04 |
| 2026-07-22 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260722-C-NCC05 |
| 2026-07-22 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260722-S-NCC01 |
| 2026-07-22 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260722-S-NCC04 |
| 2026-07-22 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260722-S-NCC05 |
| 2026-07-23 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260723-C-NCC04 |
| 2026-07-23 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260723-C-NCC05 |
| 2026-07-23 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260723-S-NCC01 |
| 2026-07-23 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260723-S-NCC04 |
| 2026-07-23 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260723-S-NCC05 |
| 2026-07-24 | Chiều | Giang Nhàn | 6 | LEGACY-PN-20260724-C-NCC05 |
| 2026-07-24 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260724-S-NCC01 |
| 2026-07-24 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260724-S-NCC04 |
| 2026-07-24 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260724-S-NCC05 |
| 2026-07-25 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260725-C-NCC01 |
| 2026-07-25 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260725-C-NCC04 |
| 2026-07-25 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260725-C-NCC05 |
| 2026-07-25 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260725-S-NCC01 |
| 2026-07-25 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260725-S-NCC04 |
| 2026-07-25 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260725-S-NCC05 |
| 2026-07-26 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260726-S-NCC01 |
| 2026-07-26 | Sáng | Minh Hoa | 6 | LEGACY-PN-20260726-S-NCC04 |
| 2026-07-26 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260726-S-NCC05 |
| 2026-07-27 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260727-C-NCC04 |
| 2026-07-27 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260727-C-NCC05 |
| 2026-07-27 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260727-S-NCC01 |
| 2026-07-27 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260727-S-NCC04 |
| 2026-07-27 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260727-S-NCC05 |
| 2026-07-28 | Chiều | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260728-C-NCC01 |
| 2026-07-28 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260728-C-NCC05 |
| 2026-07-28 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260728-S-NCC04 |
| 2026-07-28 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260728-S-NCC05 |
| 2026-07-29 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260729-C-NCC01 |
| 2026-07-29 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260729-C-NCC04 |
| 2026-07-29 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260729-C-NCC05 |
| 2026-07-29 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260729-S-NCC04 |
| 2026-07-29 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260729-S-NCC05 |
| 2026-07-30 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260730-C-NCC01 |
| 2026-07-30 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260730-C-NCC04 |
| 2026-07-30 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260730-C-NCC05 |
| 2026-07-30 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260730-S-NCC01 |
| 2026-07-30 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260730-S-NCC04 |
| 2026-07-30 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260730-S-NCC05 |
| 2026-07-31 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260731-C-NCC01 |
| 2026-07-31 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260731-C-NCC04 |
| 2026-07-31 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260731-C-NCC05 |
| 2026-07-31 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260731-S-NCC01 |
| 2026-07-31 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260731-S-NCC04 |
| 2026-07-31 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260731-S-NCC05 |
| 2026-08-01 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260801-C-NCC04 |
| 2026-08-01 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260801-C-NCC05 |
| 2026-08-01 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260801-S-NCC01 |
| 2026-08-01 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260801-S-NCC04 |
| 2026-08-01 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260801-S-NCC05 |
| 2026-08-02 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260802-S-NCC01 |
| 2026-08-02 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260802-S-NCC04 |
| 2026-08-02 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260802-S-NCC05 |
| 2026-08-03 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260803-C-NCC05 |
| 2026-08-03 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260803-S-NCC01 |
| 2026-08-03 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260803-S-NCC04 |
| 2026-08-03 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260803-S-NCC05 |
| 2026-08-04 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260804-C-NCC01 |
| 2026-08-04 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260804-C-NCC04 |
| 2026-08-04 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260804-C-NCC05 |
| 2026-08-04 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260804-S-NCC01 |
| 2026-08-04 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260804-S-NCC04 |
| 2026-08-04 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260804-S-NCC05 |
| 2026-08-05 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260805-C-NCC04 |
| 2026-08-05 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260805-C-NCC05 |
| 2026-08-05 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260805-S-NCC01 |
| 2026-08-05 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260805-S-NCC04 |
| 2026-08-05 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260805-S-NCC05 |
| 2026-08-06 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260806-C-NCC04 |
| 2026-08-06 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260806-C-NCC05 |
| 2026-08-06 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260806-S-NCC01 |
| 2026-08-06 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260806-S-NCC04 |
| 2026-08-06 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260806-S-NCC05 |
| 2026-08-07 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260807-C-NCC01 |
| 2026-08-07 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260807-C-NCC04 |
| 2026-08-07 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260807-C-NCC05 |
| 2026-08-07 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260807-S-NCC01 |
| 2026-08-07 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260807-S-NCC04 |
| 2026-08-07 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260807-S-NCC05 |
| 2026-08-08 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260808-C-NCC01 |
| 2026-08-08 | Chiều | Minh Hoa | 5 | LEGACY-PN-20260808-C-NCC04 |
| 2026-08-08 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260808-C-NCC05 |
| 2026-08-08 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260808-S-NCC01 |
| 2026-08-08 | Sáng | Minh Hoa | 6 | LEGACY-PN-20260808-S-NCC04 |
| 2026-08-08 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260808-S-NCC05 |
| 2026-08-09 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260809-S-NCC01 |
| 2026-08-09 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260809-S-NCC04 |
| 2026-08-09 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260809-S-NCC05 |
| 2026-08-10 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260810-C-NCC01 |
| 2026-08-10 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260810-C-NCC04 |
| 2026-08-10 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260810-C-NCC05 |
| 2026-08-10 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260810-S-NCC01 |
| 2026-08-10 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260810-S-NCC05 |
| 2026-08-11 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260811-C-NCC04 |
| 2026-08-11 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260811-C-NCC05 |
| 2026-08-11 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260811-S-NCC04 |
| 2026-08-11 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260811-S-NCC05 |
| 2026-08-12 | Chiều | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260812-C-NCC01 |
| 2026-08-12 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260812-C-NCC05 |
| 2026-08-12 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260812-S-NCC01 |
| 2026-08-12 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260812-S-NCC04 |
| 2026-08-12 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260812-S-NCC05 |
| 2026-08-13 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260813-C-NCC01 |
| 2026-08-13 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260813-C-NCC04 |
| 2026-08-13 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260813-C-NCC05 |
| 2026-08-13 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260813-S-NCC01 |
| 2026-08-13 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260813-S-NCC04 |
| 2026-08-13 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260813-S-NCC05 |
| 2026-08-14 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260814-C-NCC01 |
| 2026-08-14 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260814-C-NCC04 |
| 2026-08-14 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260814-C-NCC05 |
| 2026-08-14 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260814-S-NCC01 |
| 2026-08-14 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260814-S-NCC04 |
| 2026-08-14 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260814-S-NCC05 |
| 2026-08-15 | Chiều | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260815-C-NCC01 |
| 2026-08-15 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260815-C-NCC04 |
| 2026-08-15 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260815-C-NCC05 |
| 2026-08-15 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260815-S-NCC01 |
| 2026-08-15 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260815-S-NCC04 |
| 2026-08-15 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260815-S-NCC05 |
| 2026-08-16 | Sáng | Minh Hoa | 6 | LEGACY-PN-20260816-S-NCC04 |
| 2026-08-16 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260816-S-NCC05 |
| 2026-08-17 | Chiều | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260817-C-NCC01 |
| 2026-08-17 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260817-C-NCC04 |
| 2026-08-17 | Chiều | Giang Nhàn | 6 | LEGACY-PN-20260817-C-NCC05 |
| 2026-08-17 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260817-S-NCC01 |
| 2026-08-17 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260817-S-NCC04 |
| 2026-08-17 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260817-S-NCC05 |
| 2026-08-18 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260818-C-NCC01 |
| 2026-08-18 | Chiều | Minh Hoa | 5 | LEGACY-PN-20260818-C-NCC04 |
| 2026-08-18 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260818-C-NCC05 |
| 2026-08-18 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260818-S-NCC01 |
| 2026-08-18 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260818-S-NCC04 |
| 2026-08-18 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260818-S-NCC05 |
| 2026-08-19 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260819-C-NCC04 |
| 2026-08-19 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260819-C-NCC05 |
| 2026-08-19 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260819-S-NCC01 |
| 2026-08-19 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260819-S-NCC04 |
| 2026-08-19 | Sáng | Giang Nhàn | 1 | LEGACY-PN-20260819-S-NCC05 |
| 2026-08-20 | Chiều | Minh Hoa | 5 | LEGACY-PN-20260820-C-NCC04 |
| 2026-08-20 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260820-C-NCC05 |
| 2026-08-20 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260820-S-NCC01 |
| 2026-08-20 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260820-S-NCC04 |
| 2026-08-20 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260820-S-NCC05 |
| 2026-08-21 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260821-C-NCC01 |
| 2026-08-21 | Chiều | Minh Hoa | 5 | LEGACY-PN-20260821-C-NCC04 |
| 2026-08-21 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260821-C-NCC05 |
| 2026-08-21 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260821-S-NCC01 |
| 2026-08-21 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260821-S-NCC04 |
| 2026-08-21 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260821-S-NCC05 |
| 2026-08-22 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260822-C-NCC04 |
| 2026-08-22 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260822-C-NCC05 |
| 2026-08-22 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260822-S-NCC01 |
| 2026-08-22 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260822-S-NCC04 |
| 2026-08-22 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260822-S-NCC05 |
| 2026-08-24 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260824-C-NCC01 |
| 2026-08-24 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260824-C-NCC04 |
| 2026-08-24 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260824-C-NCC05 |
| 2026-08-24 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260824-S-NCC01 |
| 2026-08-24 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260824-S-NCC04 |
| 2026-08-24 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260824-S-NCC05 |
| 2026-08-25 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260825-C-NCC04 |
| 2026-08-25 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260825-C-NCC05 |
| 2026-08-25 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260825-S-NCC01 |
| 2026-08-25 | Sáng | Minh Hoa | 7 | LEGACY-PN-20260825-S-NCC04 |
| 2026-08-25 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260825-S-NCC05 |
| 2026-08-26 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260826-C-NCC01 |
| 2026-08-26 | Chiều | Giang Nhàn | 1 | LEGACY-PN-20260826-C-NCC05 |
| 2026-08-26 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260826-S-NCC04 |
| 2026-08-26 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260826-S-NCC05 |
| 2026-08-27 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260827-C-NCC01 |
| 2026-08-27 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260827-C-NCC04 |
| 2026-08-27 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260827-C-NCC05 |
| 2026-08-27 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260827-S-NCC01 |
| 2026-08-27 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260827-S-NCC04 |
| 2026-08-27 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260827-S-NCC05 |
| 2026-08-28 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260828-C-NCC01 |
| 2026-08-28 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260828-C-NCC04 |
| 2026-08-28 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260828-C-NCC05 |
| 2026-08-28 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260828-S-NCC04 |
| 2026-08-28 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260828-S-NCC05 |
| 2026-08-29 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260829-C-NCC01 |
| 2026-08-29 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260829-C-NCC04 |
| 2026-08-29 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260829-C-NCC05 |
| 2026-08-29 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260829-S-NCC01 |
| 2026-08-29 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260829-S-NCC04 |
| 2026-08-29 | Sáng | Giang Nhàn | 2 | LEGACY-PN-20260829-S-NCC05 |
| 2026-08-31 | Chiều | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260831-C-NCC01 |
| 2026-08-31 | Chiều | Minh Hoa | 5 | LEGACY-PN-20260831-C-NCC04 |
| 2026-08-31 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260831-C-NCC05 |
| 2026-08-31 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260831-S-NCC01 |
| 2026-08-31 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260831-S-NCC04 |
| 2026-08-31 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260831-S-NCC05 |
| 2026-09-01 | Chiều | Vinh Thủy (Nhất Long) | 8 | LEGACY-PN-20260901-C-NCC02 |
| 2026-09-01 | Chiều | Tuấn Hậu | 20 | LEGACY-PN-20260901-C-NCC03 |
| 2026-09-01 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260901-C-NCC04 |
| 2026-09-01 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260901-C-NCC05 |
| 2026-09-01 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260901-S-NCC01 |
| 2026-09-01 | Sáng | Vinh Thủy (Nhất Long) | 13 | LEGACY-PN-20260901-S-NCC02 |
| 2026-09-01 | Sáng | Tuấn Hậu | 19 | LEGACY-PN-20260901-S-NCC03 |
| 2026-09-01 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260901-S-NCC04 |
| 2026-09-01 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260901-S-NCC05 |
| 2026-09-03 | Chiều | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260903-C-NCC01 |
| 2026-09-03 | Chiều | Vinh Thủy (Nhất Long) | 19 | LEGACY-PN-20260903-C-NCC02 |
| 2026-09-03 | Chiều | Tuấn Hậu | 21 | LEGACY-PN-20260903-C-NCC03 |
| 2026-09-03 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260903-C-NCC04 |
| 2026-09-03 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260903-C-NCC05 |
| 2026-09-03 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260903-S-NCC01 |
| 2026-09-03 | Sáng | Vinh Thủy (Nhất Long) | 19 | LEGACY-PN-20260903-S-NCC02 |
| 2026-09-03 | Sáng | Tuấn Hậu | 19 | LEGACY-PN-20260903-S-NCC03 |
| 2026-09-03 | Sáng | Minh Hoa | 6 | LEGACY-PN-20260903-S-NCC04 |
| 2026-09-03 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260903-S-NCC05 |
| 2026-09-04 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260904-C-NCC01 |
| 2026-09-04 | Chiều | Vinh Thủy (Nhất Long) | 13 | LEGACY-PN-20260904-C-NCC02 |
| 2026-09-04 | Chiều | Tuấn Hậu | 12 | LEGACY-PN-20260904-C-NCC03 |
| 2026-09-04 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260904-C-NCC04 |
| 2026-09-04 | Chiều | Giang Nhàn | 1 | LEGACY-PN-20260904-C-NCC05 |
| 2026-09-04 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260904-S-NCC01 |
| 2026-09-04 | Sáng | Vinh Thủy (Nhất Long) | 17 | LEGACY-PN-20260904-S-NCC02 |
| 2026-09-04 | Sáng | Tuấn Hậu | 21 | LEGACY-PN-20260904-S-NCC03 |
| 2026-09-04 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260904-S-NCC04 |
| 2026-09-04 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260904-S-NCC05 |
| 2026-09-05 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260905-C-NCC01 |
| 2026-09-05 | Chiều | Vinh Thủy (Nhất Long) | 8 | LEGACY-PN-20260905-C-NCC02 |
| 2026-09-05 | Chiều | Tuấn Hậu | 16 | LEGACY-PN-20260905-C-NCC03 |
| 2026-09-05 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260905-C-NCC04 |
| 2026-09-05 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260905-C-NCC05 |
| 2026-09-05 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260905-S-NCC01 |
| 2026-09-05 | Sáng | Vinh Thủy (Nhất Long) | 11 | LEGACY-PN-20260905-S-NCC02 |
| 2026-09-05 | Sáng | Tuấn Hậu | 17 | LEGACY-PN-20260905-S-NCC03 |
| 2026-09-05 | Sáng | Minh Hoa | 6 | LEGACY-PN-20260905-S-NCC04 |
| 2026-09-05 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260905-S-NCC05 |
| 2026-09-06 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260906-S-NCC01 |
| 2026-09-06 | Sáng | Vinh Thủy (Nhất Long) | 14 | LEGACY-PN-20260906-S-NCC02 |
| 2026-09-06 | Sáng | Tuấn Hậu | 19 | LEGACY-PN-20260906-S-NCC03 |
| 2026-09-06 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260906-S-NCC04 |
| 2026-09-06 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260906-S-NCC05 |
| 2026-09-07 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260907-C-NCC01 |
| 2026-09-07 | Chiều | Vinh Thủy (Nhất Long) | 6 | LEGACY-PN-20260907-C-NCC02 |
| 2026-09-07 | Chiều | Tuấn Hậu | 15 | LEGACY-PN-20260907-C-NCC03 |
| 2026-09-07 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260907-C-NCC04 |
| 2026-09-07 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260907-C-NCC05 |
| 2026-09-07 | Sáng | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260907-S-NCC01 |
| 2026-09-07 | Sáng | Vinh Thủy (Nhất Long) | 15 | LEGACY-PN-20260907-S-NCC02 |
| 2026-09-07 | Sáng | Tuấn Hậu | 15 | LEGACY-PN-20260907-S-NCC03 |
| 2026-09-07 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260907-S-NCC04 |
| 2026-09-07 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260907-S-NCC05 |
| 2026-09-08 | Chiều | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260908-C-NCC01 |
| 2026-09-08 | Chiều | Vinh Thủy (Nhất Long) | 9 | LEGACY-PN-20260908-C-NCC02 |
| 2026-09-08 | Chiều | Tuấn Hậu | 15 | LEGACY-PN-20260908-C-NCC03 |
| 2026-09-08 | Chiều | Minh Hoa | 8 | LEGACY-PN-20260908-C-NCC04 |
| 2026-09-08 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260908-C-NCC05 |
| 2026-09-08 | Sáng | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260908-S-NCC01 |
| 2026-09-08 | Sáng | Vinh Thủy (Nhất Long) | 17 | LEGACY-PN-20260908-S-NCC02 |
| 2026-09-08 | Sáng | Tuấn Hậu | 26 | LEGACY-PN-20260908-S-NCC03 |
| 2026-09-08 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260908-S-NCC04 |
| 2026-09-08 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260908-S-NCC05 |
| 2026-09-09 | Chiều | Bích Đại (Công ty Huy Hoàng) | 11 | LEGACY-PN-20260909-C-NCC01 |
| 2026-09-09 | Chiều | Vinh Thủy (Nhất Long) | 13 | LEGACY-PN-20260909-C-NCC02 |
| 2026-09-09 | Chiều | Tuấn Hậu | 18 | LEGACY-PN-20260909-C-NCC03 |
| 2026-09-09 | Chiều | Minh Hoa | 8 | LEGACY-PN-20260909-C-NCC04 |
| 2026-09-09 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260909-C-NCC05 |
| 2026-09-09 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260909-S-NCC01 |
| 2026-09-09 | Sáng | Vinh Thủy (Nhất Long) | 17 | LEGACY-PN-20260909-S-NCC02 |
| 2026-09-09 | Sáng | Tuấn Hậu | 26 | LEGACY-PN-20260909-S-NCC03 |
| 2026-09-09 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260909-S-NCC04 |
| 2026-09-09 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260909-S-NCC05 |
| 2026-09-10 | Chiều | Vinh Thủy (Nhất Long) | 9 | LEGACY-PN-20260910-C-NCC02 |
| 2026-09-10 | Chiều | Tuấn Hậu | 18 | LEGACY-PN-20260910-C-NCC03 |
| 2026-09-10 | Chiều | Minh Hoa | 7 | LEGACY-PN-20260910-C-NCC04 |
| 2026-09-10 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260910-C-NCC05 |
| 2026-09-10 | Sáng | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260910-S-NCC01 |
| 2026-09-10 | Sáng | Vinh Thủy (Nhất Long) | 22 | LEGACY-PN-20260910-S-NCC02 |
| 2026-09-10 | Sáng | Tuấn Hậu | 25 | LEGACY-PN-20260910-S-NCC03 |
| 2026-09-10 | Sáng | Minh Hoa | 10 | LEGACY-PN-20260910-S-NCC04 |
| 2026-09-10 | Sáng | Giang Nhàn | 6 | LEGACY-PN-20260910-S-NCC05 |
| 2026-09-11 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260911-C-NCC01 |
| 2026-09-11 | Chiều | Vinh Thủy (Nhất Long) | 11 | LEGACY-PN-20260911-C-NCC02 |
| 2026-09-11 | Chiều | Tuấn Hậu | 12 | LEGACY-PN-20260911-C-NCC03 |
| 2026-09-11 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260911-C-NCC04 |
| 2026-09-11 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260911-C-NCC05 |
| 2026-09-11 | Sáng | Bích Đại (Công ty Huy Hoàng) | 10 | LEGACY-PN-20260911-S-NCC01 |
| 2026-09-11 | Sáng | Vinh Thủy (Nhất Long) | 18 | LEGACY-PN-20260911-S-NCC02 |
| 2026-09-11 | Sáng | Tuấn Hậu | 17 | LEGACY-PN-20260911-S-NCC03 |
| 2026-09-11 | Sáng | Minh Hoa | 4 | LEGACY-PN-20260911-S-NCC04 |
| 2026-09-11 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260911-S-NCC05 |
| 2026-09-12 | Chiều | Bích Đại (Công ty Huy Hoàng) | 1 | LEGACY-PN-20260912-C-NCC01 |
| 2026-09-12 | Chiều | Vinh Thủy (Nhất Long) | 12 | LEGACY-PN-20260912-C-NCC02 |
| 2026-09-12 | Chiều | Tuấn Hậu | 17 | LEGACY-PN-20260912-C-NCC03 |
| 2026-09-12 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260912-C-NCC04 |
| 2026-09-12 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260912-C-NCC05 |
| 2026-09-12 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260912-S-NCC01 |
| 2026-09-12 | Sáng | Vinh Thủy (Nhất Long) | 12 | LEGACY-PN-20260912-S-NCC02 |
| 2026-09-12 | Sáng | Tuấn Hậu | 22 | LEGACY-PN-20260912-S-NCC03 |
| 2026-09-12 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260912-S-NCC04 |
| 2026-09-12 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260912-S-NCC05 |
| 2026-09-13 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260913-S-NCC01 |
| 2026-09-13 | Sáng | Vinh Thủy (Nhất Long) | 16 | LEGACY-PN-20260913-S-NCC02 |
| 2026-09-13 | Sáng | Tuấn Hậu | 27 | LEGACY-PN-20260913-S-NCC03 |
| 2026-09-13 | Sáng | Minh Hoa | 8 | LEGACY-PN-20260913-S-NCC04 |
| 2026-09-13 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260913-S-NCC05 |
| 2026-09-14 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260914-C-NCC01 |
| 2026-09-14 | Chiều | Vinh Thủy (Nhất Long) | 15 | LEGACY-PN-20260914-C-NCC02 |
| 2026-09-14 | Chiều | Tuấn Hậu | 16 | LEGACY-PN-20260914-C-NCC03 |
| 2026-09-14 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260914-C-NCC04 |
| 2026-09-14 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260914-C-NCC05 |
| 2026-09-14 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260914-S-NCC01 |
| 2026-09-14 | Sáng | Vinh Thủy (Nhất Long) | 20 | LEGACY-PN-20260914-S-NCC02 |
| 2026-09-14 | Sáng | Tuấn Hậu | 19 | LEGACY-PN-20260914-S-NCC03 |
| 2026-09-14 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260914-S-NCC04 |
| 2026-09-14 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260914-S-NCC05 |
| 2026-09-15 | Chiều | Bích Đại (Công ty Huy Hoàng) | 3 | LEGACY-PN-20260915-C-NCC01 |
| 2026-09-15 | Chiều | Vinh Thủy (Nhất Long) | 18 | LEGACY-PN-20260915-C-NCC02 |
| 2026-09-15 | Chiều | Tuấn Hậu | 19 | LEGACY-PN-20260915-C-NCC03 |
| 2026-09-15 | Chiều | Minh Hoa | 1 | LEGACY-PN-20260915-C-NCC04 |
| 2026-09-15 | Chiều | Giang Nhàn | 3 | LEGACY-PN-20260915-C-NCC05 |
| 2026-09-15 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260915-S-NCC01 |
| 2026-09-15 | Sáng | Vinh Thủy (Nhất Long) | 16 | LEGACY-PN-20260915-S-NCC02 |
| 2026-09-15 | Sáng | Tuấn Hậu | 26 | LEGACY-PN-20260915-S-NCC03 |
| 2026-09-15 | Sáng | Minh Hoa | 3 | LEGACY-PN-20260915-S-NCC04 |
| 2026-09-15 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260915-S-NCC05 |
| 2026-09-16 | Chiều | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-PN-20260916-C-NCC01 |
| 2026-09-16 | Chiều | Vinh Thủy (Nhất Long) | 8 | LEGACY-PN-20260916-C-NCC02 |
| 2026-09-16 | Chiều | Tuấn Hậu | 23 | LEGACY-PN-20260916-C-NCC03 |
| 2026-09-16 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260916-C-NCC04 |
| 2026-09-16 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260916-C-NCC05 |
| 2026-09-16 | Sáng | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260916-S-NCC01 |
| 2026-09-16 | Sáng | Vinh Thủy (Nhất Long) | 15 | LEGACY-PN-20260916-S-NCC02 |
| 2026-09-16 | Sáng | Tuấn Hậu | 22 | LEGACY-PN-20260916-S-NCC03 |
| 2026-09-16 | Sáng | Minh Hoa | 2 | LEGACY-PN-20260916-S-NCC04 |
| 2026-09-16 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260916-S-NCC05 |
| 2026-09-17 | Chiều | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260917-C-NCC01 |
| 2026-09-17 | Chiều | Vinh Thủy (Nhất Long) | 10 | LEGACY-PN-20260917-C-NCC02 |
| 2026-09-17 | Chiều | Tuấn Hậu | 18 | LEGACY-PN-20260917-C-NCC03 |
| 2026-09-17 | Chiều | Minh Hoa | 4 | LEGACY-PN-20260917-C-NCC04 |
| 2026-09-17 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260917-C-NCC05 |
| 2026-09-17 | Sáng | Bích Đại (Công ty Huy Hoàng) | 4 | LEGACY-PN-20260917-S-NCC01 |
| 2026-09-17 | Sáng | Vinh Thủy (Nhất Long) | 13 | LEGACY-PN-20260917-S-NCC02 |
| 2026-09-17 | Sáng | Tuấn Hậu | 20 | LEGACY-PN-20260917-S-NCC03 |
| 2026-09-17 | Sáng | Minh Hoa | 5 | LEGACY-PN-20260917-S-NCC04 |
| 2026-09-17 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260917-S-NCC05 |
| 2026-09-18 | Chiều | Vinh Thủy (Nhất Long) | 9 | LEGACY-PN-20260918-C-NCC02 |
| 2026-09-18 | Chiều | Tuấn Hậu | 13 | LEGACY-PN-20260918-C-NCC03 |
| 2026-09-18 | Chiều | Minh Hoa | 3 | LEGACY-PN-20260918-C-NCC04 |
| 2026-09-18 | Chiều | Giang Nhàn | 2 | LEGACY-PN-20260918-C-NCC05 |
| 2026-09-18 | Sáng | Bích Đại (Công ty Huy Hoàng) | 5 | LEGACY-PN-20260918-S-NCC01 |
| 2026-09-18 | Sáng | Vinh Thủy (Nhất Long) | 13 | LEGACY-PN-20260918-S-NCC02 |
| 2026-09-18 | Sáng | Tuấn Hậu | 22 | LEGACY-PN-20260918-S-NCC03 |
| 2026-09-18 | Sáng | Minh Hoa | 7 | LEGACY-PN-20260918-S-NCC04 |
| 2026-09-18 | Sáng | Giang Nhàn | 3 | LEGACY-PN-20260918-S-NCC05 |
| 2026-09-19 | Chiều | Bích Đại (Công ty Huy Hoàng) | 2 | LEGACY-PN-20260919-C-NCC01 |
| 2026-09-19 | Chiều | Vinh Thủy (Nhất Long) | 11 | LEGACY-PN-20260919-C-NCC02 |
| 2026-09-19 | Chiều | Tuấn Hậu | 17 | LEGACY-PN-20260919-C-NCC03 |
| 2026-09-19 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260919-C-NCC04 |
| 2026-09-19 | Chiều | Giang Nhàn | 4 | LEGACY-PN-20260919-C-NCC05 |
| 2026-09-19 | Sáng | Bích Đại (Công ty Huy Hoàng) | 8 | LEGACY-PN-20260919-S-NCC01 |
| 2026-09-19 | Sáng | Vinh Thủy (Nhất Long) | 12 | LEGACY-PN-20260919-S-NCC02 |
| 2026-09-19 | Sáng | Tuấn Hậu | 23 | LEGACY-PN-20260919-S-NCC03 |
| 2026-09-19 | Sáng | Minh Hoa | 1 | LEGACY-PN-20260919-S-NCC04 |
| 2026-09-19 | Sáng | Giang Nhàn | 4 | LEGACY-PN-20260919-S-NCC05 |
| 2026-09-21 | Chiều | Vinh Thủy (Nhất Long) | 11 | LEGACY-PN-20260921-C-NCC02 |
| 2026-09-21 | Chiều | Tuấn Hậu | 17 | LEGACY-PN-20260921-C-NCC03 |
| 2026-09-21 | Chiều | Minh Hoa | 2 | LEGACY-PN-20260921-C-NCC04 |
| 2026-09-21 | Chiều | Giang Nhàn | 5 | LEGACY-PN-20260921-C-NCC05 |
| 2026-09-21 | Sáng | Bích Đại (Công ty Huy Hoàng) | 7 | LEGACY-PN-20260921-S-NCC01 |
| 2026-09-21 | Sáng | Vinh Thủy (Nhất Long) | 20 | LEGACY-PN-20260921-S-NCC02 |
| 2026-09-21 | Sáng | Tuấn Hậu | 29 | LEGACY-PN-20260921-S-NCC03 |
| 2026-09-21 | Sáng | Minh Hoa | 6 | LEGACY-PN-20260921-S-NCC04 |
| 2026-09-21 | Sáng | Giang Nhàn | 5 | LEGACY-PN-20260921-S-NCC05 |

## 5. Danh sách hóa đơn sẽ tạo

| Ngày XH | NCC | Số dòng hàng | invoice_no |
| --- | --- | --- | --- |
| 2026-09-14 | Giang Nhàn | 7 | LEGACY-HD-20260914-NCC05-1735 |
| 2026-09-16 | Minh Hoa | 12 | LEGACY-HD-20260916-NCC04-1737 |
| 2026-09-21 | Bích Đại (Công ty Huy Hoàng) | 26 | LEGACY-HD-20260921-NCC01-0947 |
| 2026-09-21 | Bích Đại (Công ty Huy Hoàng) | 6 | LEGACY-HD-20260921-NCC01-0949 |
