# Định nghĩa chỉ số Shopee analytics (SHOPEE-8)

Analytics là **read model**: mọi số liệu đọc từ cột chuẩn do SHOPEE-3…7 ghi, tổng hợp trong SQL (migration `00059`, các hàm `analytics_*`). Không có engine tài chính thứ hai; React chỉ định dạng.

## Quy tắc chung

| Quy tắc | Nội dung |
|---|---|
| **Đơn bán (inclusion)** | `analytics_is_sales_status(order_status)` = tập trạng thái của cost engine (`READY_TO_SHIP, PROCESSED, RETRY_SHIP, SHIPPED, TO_CONFIRM_RECEIVE, COMPLETED`) + `TO_RETURN`. Loại: `UNPAID`, `IN_CANCEL`, `CANCELLED` (huỷ được đếm riêng). Đơn có trả hàng **vẫn là đơn bán** — trả hàng là điều chỉnh. |
| **Ngày** | Bán hàng / lợi nhuận: ngày tạo đơn `created_at_channel` theo giờ Việt Nam (`analytics_tz()` = Asia/Ho_Chi_Minh; khoảng `[ngày 00:00 VN, ngày+1 00:00 VN)`). Dòng tiền: thời điểm giải ngân (`actual_payout_time`) / payout (`payout_time`). Trả hàng: ngày tạo yêu cầu; tỷ lệ trả theo nhóm đơn tạo trong kỳ. |
| **Thiếu dữ liệu ≠ 0** | Mỗi tổng chỉ cộng đơn có số và luôn đi kèm số đơn (coverage). Đơn thiếu không bị tính là 0. Không có "lợi nhuận pha trộn" (thực tế nếu có, không thì dự kiến). |
| **Tiền** | NUMERIC trong SQL, trả về chuỗi; giao diện làm tròn tới đồng bằng thao tác chuỗi (`roundDecimalString`). Không dùng float cho tổng. |
| **Margin** | Luôn có trọng số: Σ lợi nhuận / Σ giá trị đơn **của chính các đơn có lợi nhuận đó** × 100, 1 chữ số (`analytics_margin`). Không bao giờ là trung bình % từng đơn (ví dụ test: 50/100 + 90/900 = **14 %**, không phải 30 %). |
| **Tiền tệ** | Mỗi truy vấn một tiền tệ. "Tất cả shop" lấy tiền tệ phổ biến nhất; shop khác tiền tệ bị loại ra và cảnh báo (không quy đổi). |
| **Phạm vi shop** | Server quyết định (`resolveAnalyticsScope`): mọi shop Shopee người dùng có quyền `channel:view` xem được; `shop` trên URL chỉ được chấp nhận nếu nằm trong tập đó. |
| **So sánh kỳ** | Kỳ trước cùng độ dài (hôm nay ↔ hôm qua; 7 ngày ↔ 7 ngày trước đó; tháng này ↔ cùng số ngày tháng trước; tháng trước ↔ tháng trước nữa). `Δ% = (hiện tại − trước) / |trước| × 100`; trước = 0 → "—". Δ của chỉ số doanh thu / lợi nhuận chỉ hiện khi **cả hai kỳ** có độ phủ ≥ 80 %. Màu theo ý nghĩa (lợi nhuận tăng = tốt; trả hàng / lệch tăng = xấu). |

## Chỉ số

| Chỉ số | Ý nghĩa | Công thức / nguồn | Ngày | Null |
|---|---|---|---|---|
| **Số đơn** (Order Count) | Đơn bán trong kỳ | `count(*)` đơn bán | tạo đơn | — |
| **Số lượng bán** (Units Sold) | Sản phẩm bán (combo tính theo đơn vị combo) | Σ `channel_order_items.quantity` | tạo đơn | — |
| **Giá trị đơn hàng** (Order Value) | Tổng giá trị đơn Shopee — **không phải doanh thu người bán** | Σ `channel_orders.channel_total_amount` | tạo đơn | đơn thiếu giá trị không cộng |
| **DT Shopee ước tính** | "Doanh thu đơn hàng ước tính" của Shopee | Σ `order_financials.estimated_order_revenue`; độ phủ = số đơn có số / số đơn | tạo đơn | không có → không cộng |
| **LN dự kiến** | Lãi dự kiến | Σ (`estimated_order_revenue − internal_cogs`) trên đơn có **cả hai** (cùng quy tắc `v_channel_order_summary`) | tạo đơn | thiếu một trong hai → không cộng |
| **Margin dự kiến** | | Σ LN dự kiến / Σ `channel_total_amount` (đơn có LN dự kiến) × 100 | | base ≤ 0 → null |
| **Thu nhập Shopee thực tế** | Tiền người bán thực nhận theo quyết toán | Σ `actual_shopee_income` (= escrow sau điều chỉnh, đã gồm hoàn tiền) | tạo đơn | chưa quyết toán → không cộng |
| **Giá vốn gốc** (Original COGS) | | Σ `order_financials.internal_cogs` (chỉ đơn đủ giá vốn mọi dòng; combo = snapshot thành phần lúc bán; VAT do cost engine) | tạo đơn | thiếu → đơn "thiếu giá vốn" |
| **Giá vốn hoàn** (Reversed COGS) | Giá vốn thu hồi do hàng trả **nhập lại kho** | Σ `order_financials.reversed_cogs` | tạo đơn | 0 khi không có |
| **Giá vốn ròng** (Net COGS) | | Σ `net_cogs` = gốc − hoàn | tạo đơn | |
| **LN thực tế** (Actual Profit) | Lãi sau quyết toán | Σ `order_financials.actual_profit` (= thu nhập thực tế − giá vốn ròng) — độ phủ "x / y đơn đã final" | tạo đơn | chưa final → không cộng |
| **Margin thực tế** | | Σ LN thực tế / Σ `channel_total_amount` (đơn có LN thực tế) × 100 | | |
| **Tỷ lệ trả (theo sản phẩm)** — chỉ số chính | | Σ SL trả (dòng khớp đơn, yêu cầu chưa huỷ) / Σ SL bán, trên các đơn tạo trong kỳ | tạo đơn | không bán → null |
| Tỷ lệ đơn có trả hàng (phụ, ghi rõ) | | đơn có ≥ 1 yêu cầu trả / đơn bán | tạo đơn | |
| **Chờ giải ngân** (Pending Release) | Tiền của đơn đã hoàn thành mà Shopee chưa báo giải ngân — **số hiện tại**, không theo kỳ | Σ `actual_shopee_income` của đơn `income_status = pending` (`v_order_income_status`) | hiện tại | đơn chưa quyết toán: đếm riêng "chưa có quyết toán" |
| **Đã giải ngân** (Released) | | Σ `order_income_releases.released_amount` | ngày giải ngân | |
| **Payout** (Payout Amount) | Số Shopee chuyển (payout / rút ví) — không xác nhận đã về ngân hàng | Σ `payout_batches.payout_amount` của payout hoàn tất | ngày payout | |
| **Chênh lệch payout** | | `payout_amount − expected_amount` (SHOPEE-7); "lệch chưa xử lý" = Σ \|chênh lệch\| payout `mismatch` có trạng thái xử lý open/investigating | | thiếu dữ liệu → `incomplete`, không tính lệch |

### Theo SKU (phân bổ)

SKU bán = `internal_product_id` của dòng đơn; **combo là một SKU riêng** (không tách thành phần trong xếp hạng). Số cấp đơn (giá trị, DT ước tính, thu nhập thực tế) được **phân bổ cho dòng** theo tỷ lệ `discounted_unit_price × quantity` của dòng trong đơn — chỉ để hiển thị, không ghi ngược. Một dòng có LN dự kiến / thực tế chỉ khi **đơn** của nó có, và mọi dòng của đơn có giá → Σ các SKU = tổng các đơn đã ghép. LN thực tế dòng = thu nhập phân bổ − (giá vốn dòng − giá vốn hoàn của dòng). Dòng chưa ghép SKU bị loại (đếm ở chất lượng dữ liệu). "SKU thật đã tiêu thụ" (phụ) = SL bán lẻ + SL thành phần theo snapshot BOM lúc bán (`channel_order_item_cogs_components`).

Cờ giá vốn: `cogs_missing` (có dòng chưa có giá vốn → không tính lợi nhuận một phần), `no_cost_state`, `negative_stock`, `provisional` (VAT tạm tính).

## Cấu hình (`analytics_settings`, một dòng — sửa bằng SQL)

| Cột | Mặc định | Dùng cho |
|---|---|---|
| `low_margin_threshold_pct` | 10 | "SKU cần chú ý" (LN âm hoặc margin < ngưỡng); trang Lợi nhuận cho phép đổi tạm qua `?margin=` |
| `margin_band_edges` | {0,10,20,30} | Phân bố margin: < 0, 0–10, 10–20, 20–30, ≥ 30 (mỗi đơn đúng một khoảng) |
| `release_aging_edges_days` | {1,3,7} | Nhóm chờ giải ngân theo **số ngày nguyên** từ khi hoàn thành: 0–1, 2–3, 4–7, > 7 |
| `min_sample_units` | 5 | Đánh dấu "mẫu nhỏ" cho tỷ lệ trả / margin của SKU bán ít |

Xếp hạng SKU mặc định theo LN thực tế khi ≥ 80 % đơn trong kỳ đã final (`ACTUAL_COVERAGE_FOR_RANKING`), ngược lại theo LN dự kiến (ghi rõ trên giao diện).

## Độ tươi dữ liệu

Mỗi mảng (đơn, tài chính, trả hàng, giải ngân, payout) lấy lần đồng bộ thành công **cũ nhất** trong các shop đang xem; cũ khi quá `max(30 phút, 3 × chu kỳ)`. Banner cảnh báo khi một mảng cũ hoặc scheduler dừng.

## Hiệu năng

Không có bảng tổng hợp sẵn: truy vấn SQL trên index sẵn có (`channel_orders (shop_id, created_at_channel)`, dòng đơn theo `order_id`, …) + 1 index mới `inventory_cost_ledger (product_id, event_time)`. Đo local (4.000 đơn / 8.000 dòng / 30 ngày): tổng quan 80 ms, xu hướng 70 ms, SKU 125–150 ms, đơn lỗ 90 ms, chất lượng dữ liệu 80 ms. Kết quả luôn giới hạn (≤ 500 dòng / trang, biểu đồ ≤ ~92 điểm: giờ ≤ 2 ngày, ngày ≤ 92 ngày, tuần ≤ 370, tháng). Không cache (trang `force-dynamic`, số liệu theo quyền).

## Ngoài phạm vi / giới hạn

- Mẫu số margin `channel_total_amount` gồm cả phí ship người mua trả (quy tắc hiện có của engine) — nếu muốn đổi mẫu số, đổi một chỗ ở `analytics_margin` + view đơn.
- Chưa có phân quyền theo shop (mọi người có `channel:view` thấy mọi shop) — `resolveAnalyticsScope` là chỗ để thêm.
- Ads / ROAS / CRM / dự báo: phase sau.
