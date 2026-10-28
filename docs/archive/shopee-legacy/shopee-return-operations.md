# Hàng hoàn đã giao — vận hành theo ngày (SHOPEE-6B)

Trang `/shopee/returns/operations` trả lời: *hôm nay hãng vận chuyển báo đã giao thành công về shop bao nhiêu đơn hoàn, là những đơn nào, Hoàn Trả hay Hoàn Hủy, thuộc ca giao nào.*

**Chỉ là theo dõi vận hành.** Không nhập kho (`return_in`), không đụng sổ giá vốn / `product_cost_state` / COGS, không đổi doanh thu, thu nhập thực tế, hoàn tiền, lợi nhuận hay payout. Trạng thái tài chính không bao giờ suy ra từ trạng thái vận chuyển. Nhập lại kho vẫn chỉ qua "Cách xử lý" ở `/shopee/returns` (SHOPEE-6). Test hồi quy kiểm tra điều này (`return-operations.integration.test.ts`).

## 1. Định nghĩa

| Loại | `operation_type` | Là gì | Nhận diện |
|---|---|---|---|
| **Hoàn Trả** | `customer_return` | Khách đã nhận, rồi tạo yêu cầu trả hàng | có bản ghi `channel_returns` (Returns API) chưa huỷ và `needs_logistics ≠ false` |
| **Hoàn Hủy** | `failed_delivery_return` | Giao cho khách không thành công, hàng quay về shop | đơn `CANCELLED` **sau khi** đã bàn giao vận chuyển (`pickup_done_time` có, hoặc package `LOGISTICS_PICKUP_DONE / DELIVERY_FAILED / COD_REJECTED / LOST / DELIVERY_DONE`) và **không có** bản ghi return nào |

Một quy tắc duy nhất: `classifyReturnOperation` (`src/lib/return-operations/classify.ts`), bản SQL `return_failed_delivery_candidate()`; test đối chiếu hai bên. Không phân loại: đơn huỷ trước khi giao vận chuyển, đơn hoàn tất bình thường, return chỉ hoàn tiền (không gửi hàng), và **`TO_RETURN` không có return** (chưa rõ ngữ nghĩa — chờ payload thật).

Danh tính (lặp lại đồng bộ không nhân đôi): Hoàn Trả `return:<return_sn>`, Hoàn Hủy `fd:<order_sn>` — duy nhất theo `(shop_id, identity_key)`; cùng mã ở hai shop không đụng nhau.

## 2. `delivered_to_seller_at` và `business_date`

`delivered_to_seller_at` = thời điểm **sự kiện của hãng vận chuyển** "đã giao thành công về người bán". Không dùng ngày tạo return, giờ đồng bộ, `created_at` local hay giờ cập nhật chung.

**Hoàn Trả** (`get_reverse_tracking_info`):
1. Chọn chặng kết thúc ở shop: `post_return` (kho → shop) nếu Shopee có bất kỳ dữ liệu post-return nào hoặc `validation_type` là kho; chặng `reverse` (khách → shop) chỉ khi `validation_type` là người bán.
2. Lấy sự kiện **sớm nhất** của chặng đó mà trạng thái của chính sự kiện nghĩa là đã giao (`delivered_at_source = tracking_event`).
3. **Fallback** chỉ khi trạng thái của chặng nghĩa là đã giao mà không có sự kiện chi tiết: dùng `post_return_logistics_update_time` (`delivered_at_source = status_update_time`, ghi chú `delivered_fallback_update_time`; UI hiện "≈ theo trạng thái").
4. Chặng reverse "đã giao" nhưng **không rõ** validation và không có post-return → **không** coi là về shop (có thể là kho) → trạng thái `unknown`, cần chú ý.

**Hoàn Hủy** (`get_tracking_info`): sự kiện sớm nhất có `logistics_status = RETURNED`. Không fallback. `DELIVERED` ở đây là giao cho **khách** — không bao giờ tính là về shop.

Nội dung mô tả (description) chỉ để hiển thị, không bao giờ được phân tích.

`business_date = DATE(delivered_to_seller_at theo shops.timezone)` (mặc định `Asia/Ho_Chi_Minh`) — không dùng ngày UTC (23:59 và 00:01 giờ VN đã test). Shopee sửa lại thời điểm giao → `business_date` và ca đi theo; ảnh chụp thông báo cũ giữ nguyên.

### Đơn vị vận chuyển (ĐVVC) của đơn hoàn — sửa ở 00061

- **Hoàn Trả** = ĐVVC của **chiều hoàn**: `get_return_detail.reverse_logistics_channel_name` (lưu ở `channel_returns.reverse_logistics_channel_name`). **Không** dùng `shipping_carrier` của đơn: trên prod, đơn giao bằng GHN / beDelivery / SPX Instant vẫn hoàn về bằng "SPX Express". Chưa biết → để trống ("Không rõ ĐVVC"), không lấy ĐVVC chiều giao. `get_reverse_tracking_info` không có tên ĐVVC.
- **Hoàn Hủy** = ĐVVC của kiện hàng: chính kiện đó, cùng mã vận đơn, quay về shop; `get_tracking_info` không có tên ĐVVC.

## 3. Ca giao (`return_delivery_windows`)

- Cấu hình được (tên, giờ bắt đầu/kết thúc, thứ tự, bật/tắt) ở `/shopee/returns/operations/settings`; mặc định chung: Ca sáng 08:00–11:59, Ca chiều 12:00–16:59, Ca tối 17:00–21:00.
- Bộ ca áp dụng — cụ thể nhất thắng: **ĐVVC + shop → ĐVVC → shop → mặc định chung** (ĐVVC so không phân biệt hoa thường). Ví dụ SPX 3 ca, J&T 2 ca.
- Thuộc ca: **phút local** của thời điểm giao nằm trong `[start, end]`, tính cả phút cuối (08:00–11:59 gồm tới 11:59:59). Ca chồng giờ bị từ chối khi lưu; nếu vẫn tồn tại thì ca có thứ tự nhỏ hơn thắng → mỗi đơn đúng một ca. Không thuộc ca nào → **"Khác / Ngoài ca"** (không bao giờ bị bỏ).
- Ca được gán **lúc truy vấn** (`v_return_operations.window_id`, hàm `return_assign_window`) từ giờ giao → đồng bộ muộn không đổi ca. Đổi cấu hình ca áp dụng cho cả số liệu ngày cũ trên trang.
- Đối chiếu: Tổng ngày = Σ các ca + Ngoài ca (cấu trúc tổng hợp đảm bảo, có test).

## 4. Dữ liệu (migration 00060)

| Bảng / đối tượng | Vai trò |
|---|---|
| `channel_return_operations` | đơn hoàn canonical (loại, mã đơn, return_sn, tracking / RTS tracking, ĐVVC, trạng thái provider + canonical, chặng, delivered_at + nguồn, business_date, người phụ trách, đã nhận, cần chú ý) |
| `channel_return_operation_items` | ảnh chụp sản phẩm (tên, phân loại, SKU, SL) — Hoàn Trả = SL trả thực tế; Hoàn Hủy = toàn bộ dòng đơn (cả kiện quay về) |
| `channel_return_logistics_events` | lịch sử tracking, idempotent theo `md5(chặng|giờ|trạng thái|mô tả)` |
| `return_delivery_windows`, `return_operation_assignments`, `return_operation_settings` | ca giao, người nhận mặc định theo loại, ngưỡng |
| `return_notification_settings / _schedules / _runs / _run_operations` | lịch thông báo, mỗi lần gửi + danh sách đơn chính xác |
| `channel_orders.cancel_reason / logistics_status / package_number / package_count`, `shops.timezone` | đầu vào phân loại / múi giờ |
| `apply_return_operation` | một giao dịch: op + items + events + cảnh báo |
| `get_return_operations_daily_summary`, `list_return_operations`, `get_return_operations_counters`, `v_return_operations` | đọc (summary gộp trong SQL, list phân trang server) |

Combo: hiển thị SKU combo đã bán, không tách thành phần (phase này theo dõi kiện, không khôi phục tồn kho).

## 5. Trạng thái canonical (`return-logistics-status.ts`)

`pending · in_transit_to_seller · out_for_delivery_to_seller · delivered_to_seller · delivery_failed · lost · cancelled · unknown`. Giá trị lạ → `unknown` (hiện nguyên văn, cần chú ý), không đoán.

| Nguồn | Giá trị (ỨNG VIÊN — từ enum tài liệu) | → |
|---|---|---|
| Hoàn Trả (reverse / post-return) | `LOGISTICS_PENDING_ARRANGE`, `LOGISTICS_READY`, `LOGISTICS_REQUEST_CREATED`, `LOGISTICS_PICKUP_RETRY` | pending |
| | `LOGISTICS_PICKUP_DONE`, `LOGISTICS_IN_TRANSIT` | in_transit_to_seller |
| | `LOGISTICS_DELIVERY_DONE` | delivered_to_seller |
| | `LOGISTICS_DELIVERY_FAILED`, `LOGISTICS_PICKUP_FAILED` · `LOGISTICS_LOST` · `LOGISTICS_REQUEST_CANCELED` | delivery_failed · lost · cancelled |
| Hoàn Hủy (sự kiện tracking) | `PICKED_UP`, `FAILED_DELIVERED`, `TIMEOUT`, … (chiều đi) | pending |
| | `RETURN_INITIATED`, `RETURN_STARTED`, `RETURN_PENDING` | in_transit_to_seller |
| | `RETURNED` | delivered_to_seller |
| | `FAILED_RETURNED`, `FAILED_RETURN_STARTED` · `LOST` | delivery_failed · lost |

## 6. Cần chú ý (không tự gửi khiếu nại)

Theo thứ tự: `delivered_but_not_confirmed` (đã giao > N giờ mà chưa "Đã nhận", khi bật xác nhận) · `lost` · `delivery_failed` · `unknown_status` · `tracking_missing` (Hoàn Hủy chưa có mã vận đơn sau N giờ) · `stuck_in_return_transit` (không cập nhật > N ngày). Ngưỡng ở `return_operation_settings` (UI cấu hình); tính lại sau mỗi job và khi xác nhận.

**"Đã nhận"** (quyền `return:receive` — admin + nhân viên): chỉ ghi `received_confirmed_at/by`. Không nhập kho, không giá vốn, không tiền.

## 7. Đồng bộ

| Job | API | Nhịp | Ưu tiên |
|---|---|---|---|
| `return` (SHOPEE-6, giữ nguyên) | get_return_list / detail | 15 phút | 15 |
| `return_logistics` | get_reverse_tracking_info | 10 phút (`SHOPEE_SYNC_RETURN_LOGISTICS_INTERVAL_MINUTES`) | 16 |
| `failed_delivery` | get_tracking_number (1 lần) + get_tracking_info | 15 phút (`SHOPEE_SYNC_FAILED_DELIVERY_INTERVAL_MINUTES`) | 17 |

Ứng viên lấy từ SQL: chưa giao → poll khi cũ hơn `SHOPEE_SYNC_RETURN_LOGISTICS_OPEN_TTL_MINUTES` (20); đã giao trong 2 ngày → poll lại khi cũ hơn `…_DELIVERED_TTL_HOURS` (6) để bắt Shopee sửa giờ; chỉ đơn trong `tracking_lookback_days` (45). Mỗi đơn lỗi chỉ ảnh hưởng chính nó; lần đầu gặp mà API lỗi vẫn tạo op "chờ vận chuyển" kèm `sync_notes` để không đơn nào vô hình. Payload thô lưu `channel_api_snapshots` (`entity_type = return_logistics`).

**Làm mới dữ liệu hoàn** (quyền `channel:sync`): chỉ enqueue 3 job `manual` (shop đang lọc, `focusDate` = ngày đang xem → ưu tiên đơn đang mở + đơn của ngày đó), worker chạy sau phản hồi, trang tự làm mới 5 giây/lần tới khi xong. Không gọi Shopee khi render trang.

Độ mới: trang hiện giờ đồng bộ của Return API / vận chuyển Hoàn Trả / vận chuyển Hoàn Hủy (job xong gần nhất, thành công hoặc một phần), cảnh báo khi cũ hơn `sync_stale_warn_minutes` (30).

## 8. Thông báo (Zalo, qua `notifications/service.ts`)

- Cấu hình: `return_notification_settings` (shop / ĐVVC / loại, kèm delta, kèm vài mã đơn, số phút đồng bộ trước) + nhiều giờ gửi (`return_notification_schedules`, ví dụ 10:30, 14:30, 18:30). Mặc định tắt.
- Chạy trong tick scheduler mỗi phút (pg_cron → `/api/internal/shopee/sync-scheduler`):
  - **Đồng bộ trước**: trong `presync_minutes` (10) trước giờ gửi, nếu dữ liệu chưa làm mới kể từ đầu khoảng đó → enqueue 3 job manual.
  - **Gửi**: từ giờ gửi tới +45 phút; quá 45 phút (hệ thống ngừng) thì bỏ qua, không gửi bù. Một lần gửi duy nhất cho (setting, ngày, giờ) — khoá unique `return_notification_runs`; lần chạy treo > 5 phút được nhận lại.
- Ảnh chụp: `return_notification_run_operations` = **đúng danh sách op** tại lúc gửi + số đếm; không bao giờ sửa về sau.
- **Delta chính xác**: tập hiện tại − tập của lần gửi **thành công** gần nhất (sent / partial) cùng setting + ngày (SQL), không phải trừ số lượng. Lần đầu trong ngày: "Phát sinh từ đầu ngày". Lần gửi lỗi không làm mốc delta. Sang ngày mới delta tự reset.
- Nội dung: các ca đã bắt đầu (ca hiện tại "đến hiện tại"), Ngoài ca nếu có, TỔNG TỪ ĐẦU NGÀY, mới từ lần trước (+ tối đa 5 mã đơn nếu bật), giờ dữ liệu. Không gửi hàng trăm dòng — danh sách đầy đủ ở trang.
- Kiến trúc kênh: `NotificationSender` được inject (`server.ts` → Zalo); thêm Email/kênh khác = một sender mới. `dedupeKey = RETURN_OPERATIONS_SUMMARY:<run_id>`.

## 9. Truy vấn / hỏi đáp

Mọi câu hỏi ("Hôm nay SPX giao bao nhiêu đơn hoàn?", "Ca sáng SPX bao nhiêu?", "Liệt kê Hoàn Hủy SPX ca chiều") đọc DB canonical qua `getDailyReturnOperationsSummary({ date, shopId?, carrier?, operationType?, deliveryWindowId? })` và `getDailyReturnOperationsList({ …, status?, search?, page?, pageSize? })` (`src/lib/return-operations/queries.ts`). Không gọi Shopee.

Xuất Excel: `/api/shopee/returns/operations/export` theo đúng bộ lọc, tên file `<ĐVVC>_<HoanTra|HoanHuy|HangHoan>_<ngày>[_<Ca>].xlsx`, tối đa 5 000 đơn.

## 10. Xác nhận payload thật

**Đã xác nhận trên prod (đọc snapshot, 2026-10-20):**
- `get_reverse_tracking_info` (VN, `validation_type = seller_validation`): lịch sử nằm ở `tracking_info[]`, mỗi sự kiện chỉ có `update_time` + `tracking_description` (không có trạng thái) → ngày giao lấy theo fallback `reverse_logistics_update_time` khi `reverse_logistics_status = LOGISTICS_DELIVERY_DONE`. Không có trường post-return / RTS và không có tên ĐVVC.
- `get_return_detail`: `reverse_logistics_status` (có "s"; tài liệu ghi `reverse_logistic_status`), `reverse_logistics_channel_name`, `validation_type`, `logistics_status`.
- `get_tracking_info` (Hoàn Hủy): `tracking_info[].logistics_status` có thật — `PICKED_UP`, `RETURN_INITIATED`, `RETURN_STARTED`, `RETURNED` ("Trả hàng thành công"); package `LOGISTICS_DELIVERY_FAILED`; đơn `CANCELLED`.

**Phần còn lại cần kiểm (checklist cũ):**

Mọi tên trường và giá trị trạng thái trên lấy từ tài liệu Shopee. Sandbox xác nhận: `get_reverse_tracking_info` với return không tồn tại trả `returns.return_not_found`. Cần chạy trên shop thật (chỉ đọc, không refresh token, không ghi cloud):

```
npm run shopee:live -- returns --days 15 --limit 10 --save   # Hoàn Trả: detail + reverse tracking
npm run shopee:live -- failed --limit 10 --save              # Hoàn Hủy: đơn huỷ sau lấy hàng → order detail + tracking
npm run shopee:live -- reverse <return_sn> / tracking <order_sn>
```
(cần `SHOPEE_PARTNER_ID/KEY` + `APP_ENCRYPTION_KEY` của prod trong `.env.local`; payload lưu `.shopee-live/`, đã lọc thông tin người mua.)

Checklist:
- [ ] `get_reverse_tracking_info`: tên trường thật; giá trị `post_return_logistics_status` khi đã giao về shop; sự kiện trong `post_return_logistics_tracking_info` có trường trạng thái không (nếu không → mọi đơn đi đường fallback); `validation_type` thật; có tên ĐVVC không
- [ ] Return giao thẳng về shop (không qua kho) dùng chặng nào
- [ ] Đơn giao thất bại: `order_status` thật (`CANCELLED`? `TO_RETURN`?), `cancel_reason`, `package_list[].logistics_status`
- [ ] `get_tracking_info`: `tracking_info[].logistics_status` có giá trị `RETURNED` khi về shop không; giờ sự kiện
- [ ] Đơn nhiều kiện (`package_count > 1`): hiện coi cả đơn là một Hoàn Hủy, lấy kiện đầu tiên
- [ ] Sau khi có payload: cập nhật bảng ở `return-logistics-status.ts` / adapter (chỉ ở đó), thêm fixture thật vào `tests/fixtures/shopee/return-logistics/`

## 11. Triển khai production

1. `npx supabase db push --linked` (00060), rồi `npx supabase db query --linked "notify pgrst, 'reload schema';"`.
2. Deploy code (job mới tự được scheduler lên lịch; không cần env mới — các biến `SHOPEE_SYNC_RETURN_LOGISTICS_*` / `…FAILED_DELIVERY…` là tuỳ chọn).
3. Kiểm tra `/shopee/sync`: hai hàng "Vận chuyển Hoàn Trả / Hoàn Hủy" chạy thành công.
4. Chạy tool đọc thật (§10), gửi payload để chốt mapping trước khi tin số liệu.
5. Cấu hình ca giao theo thực tế từng ĐVVC, người phụ trách, rồi bật lịch thông báo (đảm bảo người nhận Zalo đang bật).
6. Theo dõi sau deploy: log `shopee-return-logistics` (`customer_return_logistics_synced` / `failed_delivery_logistics_synced`, ghi chú `delivered_fallback_update_time`, `reverse_delivered_unknown_validation`), số đơn "Cần chú ý → Trạng thái lạ", log `return-notifications` (`notification_tick`), lịch sử thông báo ở trang cấu hình.
