# Tạo hóa đơn từ lịch sử hàng về (INV-FROM-RECEIPTS)

Migration: `00034_invoice_from_receipts.sql`, `00035_invoice_receipt_days_single_fk.sql`.

## 1. Hai nguồn hóa đơn

Cả hai nằm trong **cùng** bảng `invoices`, cùng danh sách `/invoices`, cùng công nợ. Cột `invoices.source_type` phân biệt:

| source_type | Nhãn UI | Khi nào dùng | Tạo ở đâu |
|---|---|---|---|
| `manual` | Nhập thủ công | Hóa đơn có trước, hàng về sau | `/invoices/new` |
| `from_receipts` | Từ hàng đã nhận | Hàng về trước, NCC xuất hóa đơn sau | `/receipts` → chọn ngày → "Tạo hóa đơn từ hàng đã chọn" |

Mọi hóa đơn cũ có trước phase này đều là `manual` (backfill bằng DEFAULT). Hệ thống **không** tự suy đoán hóa đơn cũ là `from_receipts` và **không** tự gắn ngày hàng về lịch sử vào hóa đơn cũ.

## 2. Tạo hóa đơn from_receipts

1. Ở `/receipts` (mỗi dòng = một NCC trong một ngày, gồm cả ca sáng, ca chiều, mọi phiếu trong ngày), tick các ngày cần lập hóa đơn.
   - Dòng đầu tiên được chọn sẽ cố định NCC; checkbox của NCC khác bị vô hiệu hóa, có tooltip "Một hóa đơn chỉ có thể được tạo từ các ngày hàng về của cùng một nhà cung cấp."
   - Ngày đã lập HĐ hiển thị "Đã lập HĐ · <số HĐ>" (bấm để mở hóa đơn) và không chọn được.
   - Chỉ chọn được trong các dòng đang hiển thị (trang hiện tại theo bộ lọc). Đổi bộ lọc/trang sẽ bỏ chọn. Mẹo: lọc theo NCC.
   - Khi đang lọc theo SKU/tên sản phẩm, hóa đơn vẫn lấy **toàn bộ** hàng của ngày đã chọn, không chỉ SKU đang lọc.
2. Modal hiển thị (read-only) NCC, loại NCC, các ngày đã chọn, ngày hàng về đầu tiên, số ngày, tổng SL nhận, bảng preview; người dùng nhập Số hóa đơn, Ngày lập hóa đơn (+ ghi chú) và chiết khấu/VAT theo loại NCC.
3. Bảng preview không cho sửa từng dòng — mục tiêu là không phải nhập lại hóa đơn.

### Cách dựng dòng hóa đơn

`get_receipt_days_invoice_lines(supplier_id, dates[])` — nguồn duy nhất, dùng cho cả preview lẫn lúc lưu:

- Chỉ đúng các ngày được chọn (`receipt_date = ANY(dates)`), mọi ca, mọi phiếu.
- Dùng `received_qty` (SL nhận), **không** dùng `delivered_qty`.
- Group theo `product_id + unit_price` (giá snapshot trên phiếu nhập, không dùng `products.current_price`). Cùng SKU khác giá → nhiều dòng, không lấy giá bình quân. Cùng SKU cùng giá → cộng SL.
- Nhóm có tổng SL nhận = 0 không tạo dòng.

Ví dụ: SKU A ngày 01/09 SL 10 giá 100.000; ngày 03/09 SL 7 giá 110.000 → hóa đơn có 2 dòng `A | 10 | 100.000` và `A | 7 | 110.000`.

### Tài chính

Giữ nguyên chính sách UP2/UP3 và công thức duy nhất `calculateInvoiceFinancials` (`src/lib/invoices/financials.ts`):

- Công ty: không chiết khấu; VAT % (mặc định 8) → `final = subtotal + subtotal × VAT%`.
- Hộ kinh doanh: VAT = 0; không chiết khấu / chiết khấu % / chiết khấu số tiền → `final = subtotal − discount`.

`supplier_type` luôn được server đọc lại từ DB, không tin client.

### Lưu (server action + RPC)

`createInvoiceFromReceiptDays` (`src/lib/invoices/from-receipts-actions.ts`) chỉ nhận `supplierId`, `receiptDates[]`, số/ngày HĐ, ghi chú và input chiết khấu/VAT. Server tự tải lại phiếu nhập, tự tính tiền, rồi gọi RPC `create_invoice_from_receipts`, trong **một transaction**:

1. chuẩn hóa ngày (bỏ trùng, sắp xếp); rỗng → lỗi
2. NCC phải tồn tại
3. khóa advisory theo từng (NCC, ngày) — thứ tự cố định
4. mỗi ngày phải thực sự có phiếu của NCC đó (không trộn NCC)
5. chưa ngày nào nằm trong `invoice_receipt_days`
6. tính lại dòng hóa đơn từ DB và so khớp tuyệt đối với dòng server đã dùng để tính tiền (dữ liệu vừa đổi → báo tải lại)
7. kiểm tra snapshot tài chính khớp tạm tính và chính sách loại NCC
8. insert `invoices` (`source_type = from_receipts`, `receipt_start_date = MIN(ngày)`), `invoice_items` (từ dòng DB tính lại, không từ client), `invoice_receipt_days` (một dòng/ngày)

Bất kỳ bước nào lỗi → rollback toàn bộ, không có hóa đơn "nửa vời" (đã kiểm chứng bằng cách tiêm lỗi vào insert `invoice_items`).

### Chống trùng khi 2 người cùng lập

- Khóa advisory ở bước 3 tuần tự hóa hai request cùng ngày: request sau thấy ngày đã được liên kết.
- `UNIQUE(supplier_id, receipt_date)` trên `invoice_receipt_days` là lớp bảo vệ cuối.
- Người dùng nhận thông báo thân thiện ("… vừa được sử dụng để lập hóa đơn khác. Vui lòng tải lại dữ liệu.") + nút "Tải lại dữ liệu"; không bao giờ lộ lỗi constraint thô.

## 3. receipt_start_date KHÔNG phải khoảng truy vấn

`receipt_start_date` = ngày hàng về sớm nhất trong các ngày đã chọn, chỉ để hiển thị/nghiệp vụ. `invoice_date` là ngày trên hóa đơn NCC — hai trường khác nhau.

Ví dụ liên kết 01/09, 03/09, 04/09 → `receipt_start_date = 01/09`, nhưng **ngày 02/09 không bao giờ được tính** vào hóa đơn này, kể cả khi có hàng về ngày 02/09.

## 4. Hàng còn phải về (outstanding)

`v_outstanding` rẽ nhánh theo `source_type`:

| Nguồn | received_qty của một dòng hóa đơn |
|---|---|
| `manual` | **Giữ nguyên logic cũ** (migration 00014): tổng SL nhận cùng NCC + cùng SKU với `receipt_date >= invoice_date`. Không có FIFO/phân bổ. Hạn chế đã biết: có thể đếm trùng giữa các hóa đơn chồng khoảng ngày — kể cả với ngày đã liên kết cho hóa đơn `from_receipts`. |
| `from_receipts` | Chỉ phiếu thuộc **đúng các ngày trong `invoice_receipt_days`** của hóa đơn đó, cùng SKU **và cùng đơn giá**. Không dùng `invoice_date` hay `receipt_start_date`. |

Hóa đơn `from_receipts` vừa tạo thường có `received = invoice_qty`, `remaining = 0`.

Tiền (Tiền hóa đơn / đã nhận / còn lại) giữ nguyên cách OUTSTANDING-FINANCE: phân bổ `final_amount` theo tỷ lệ `line_total / subtotal` (đã gồm VAT/chiết khấu), phần đã nhận theo tỷ lệ `received_qty / invoice_qty`.

Trang chi tiết outstanding (`get_outstanding_contributing_receipts`) dùng đúng cùng quy tắc rẽ nhánh.

### Trạng thái (thay đổi toàn cục)

| remaining_qty | status | Nhãn |
|---|---|---|
| < 0 | `need_makeup` | Cần xuất bù |
| = 0 | `complete` (**mới**) | Đã đủ |
| 0 < x < 15 | `low` | Sắp hết |
| ≥ 15 | `normal` | Bình thường |

Trước phase này `remaining = 0` hiển thị "Sắp hết" — dễ hiểu nhầm, nhất là với hóa đơn from_receipts. Áp dụng cho **cả** hóa đơn manual. Đã đồng bộ: bộ lọc `/outstanding`, badge, thẻ dashboard "HĐ đang theo dõi" (giờ chỉ đếm `low`/`need_makeup`, không đếm `complete`), types.

**Zalo LOW_STOCK (ZL4):** `complete` được ánh xạ về trạng thái theo dõi `normal` → không bao giờ gửi cảnh báo "Sắp hết" cho SKU đã đủ; nếu sau đó SL còn lại quay về 1–14, đó là chuyển `normal → near_empty` và cảnh báo như bình thường. Tạo hóa đơn from_receipts không gọi đánh giá ZL4 (mọi dòng sinh ra đã ở `complete`).

## 5. Khóa sửa hàng về đã lập hóa đơn

Khi một ngày (NCC + ngày) đã được dùng cho hóa đơn from_receipts, dữ liệu hàng về của ngày đó bị khóa để hóa đơn không bị lệch âm thầm (ví dụ SL nhận 100 → 120 trong khi hóa đơn vẫn 100). Thực thi bằng **trigger DB** trên `receipts` và `receipt_items` nên áp dụng cho mọi đường ghi (form tạo/sửa phiếu, RPC, script):

Bị chặn:
- tạo phiếu mới vào ngày đã khóa
- xóa phiếu / xóa dòng hàng của ngày đã khóa
- chuyển phiếu **ra khỏi** ngày đã khóa hoặc **vào** ngày đã khóa (kiểm tra cả NCC/ngày CŨ và MỚI)
- thêm/xóa/sửa dòng hàng (sản phẩm, đơn giá, SL giao, SL nhận)

Vẫn cho phép: sửa người nhận, ca, ghi chú (không ảnh hưởng hóa đơn).

Thông báo: "Ngày hàng về này đã được sử dụng để lập hóa đơn {số HĐ}. Không thể thay đổi dữ liệu hàng về trực tiếp." Hệ thống **không** tự sửa hóa đơn và **không** tính lại hóa đơn cũ. Nghiệp vụ điều chỉnh (nếu cần) sẽ là phase riêng.

Trigger dùng cùng khóa advisory với RPC tạo hóa đơn, nên một phiếu lưu đồng thời với lúc lập hóa đơn cho cùng ngày sẽ hoặc được tính vào hóa đơn, hoặc bị chặn — không bao giờ lọt ra ngoài.

## 6. Sửa / xóa hóa đơn from_receipts

- Sửa (`/invoices/[id]/edit`, cùng quyền `canEditInvoices`): chỉ số HĐ, ngày HĐ, ghi chú, chiết khấu/VAT. NCC, `receipt_start_date`, ngày liên kết, dòng hàng bị khóa (form hiển thị read-only; server bỏ qua mọi supplier/items client gửi và dùng RPC riêng `update_invoice_from_receipts_header`; RPC sửa thủ công `update_invoice` từ chối hóa đơn from_receipts). Muốn đổi ngày hàng về: xóa hóa đơn và tạo lại.
- Xóa: `invoice_receipt_days` xóa theo cascade → các ngày trở lại "Chưa lập HĐ", chọn lại được; dữ liệu phiếu nhập không mất. **Lưu ý:** hiện ứng dụng **chưa có** chức năng xóa hóa đơn trên UI (cho cả hai nguồn) — hành vi cascade đã có sẵn ở DB và đã được kiểm thử, nhưng nút xóa / quyền xóa cần một quyết định riêng.

## 7. Không thay đổi

- Công nợ / dashboard dùng `invoices.final_amount` như mọi hóa đơn khác — không đếm trùng.
- Lịch sử hàng về vẫn hiển thị mọi ngày (đã lập HĐ hay chưa). (Hiện dự án chưa có Excel export lịch sử hàng về — Phase 10b vẫn hoãn.)
- Phân quyền: dùng lại `canCreateInvoices` (admin, staff) / `canEditInvoices`; viewer chỉ xem (không có checkbox, server action từ chối).

## 8. Ngoài phạm vi

FIFO/phân bổ cho hóa đơn manual, chọn một phần ngày hoặc từng SKU, tách một ngày cho nhiều hóa đơn, tự khớp hóa đơn cũ, thông báo Zalo cho sự kiện này, OCR, PDF.
