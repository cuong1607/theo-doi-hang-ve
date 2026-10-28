# Trả hàng / hoàn tiền Shopee (SHOPEE-6)

Ba lớp tách biệt — **hoàn tiền ≠ nhập lại kho**:

| Lớp | Nguồn | Tác động |
|---|---|---|
| Vận hành | `v2.returns.get_return_list` / `get_return_detail` → `channel_returns`, `channel_return_items` | trạng thái, lý do, sản phẩm trả — **không** đụng tồn kho / giá vốn |
| Tài chính | escrow (`order_financials.actual_shopee_income` = `escrow_amount_after_adjustment`) | đã gồm hoàn tiền / điều chỉnh → **không trừ hoàn tiền lần nữa**; bồi thường người bán là cột riêng `seller_compensation_amount` |
| Tồn kho / giá vốn | cách xử lý (disposition) do admin chọn | chỉ **Nhập lại kho** tạo `return_in` + hoàn giá vốn |

## Đồng bộ

- Loại job `return`, ưu tiên: đơn (10) → **trả hàng (15)** → tài chính (20) → sản phẩm (30); thủ công 2. Nhịp `SHOPEE_SYNC_RETURN_INTERVAL_MINUTES` (mặc định 15).
- Mỗi job: (1) nạp lại các return trong `channel_return_sync_retries` + return **chưa kết thúc** chưa làm mới trong `SHOPEE_SYNC_RETURN_OPEN_TTL_HOURS` (6 h); (2) quét `update_time` theo cửa sổ 15 ngày từ lần thành công − chồng lấn (không trước mốc `channel_sync_settings.orders_from`), phân trang `page_no`; (3) lấy chi tiết những return mới / đổi `update_time` / chưa kết thúc, ≤ `SHOPEE_SYNC_RETURN_CONCURRENCY` (2) song song, checkpoint mỗi vòng. Return đã kết thúc và không đổi → không gọi lại.
- **Đơn phải có trước**: return của đơn chưa có ở local → lấy đơn qua order sync trước (cùng job, đếm vào API calls) rồi mới lưu return. Không lấy được → dòng `channel_return_sync_retries` (`reason = order_missing`) và thử lại ở job sau. Đơn tạo trước mốc `orders_from` → bỏ qua (không lỗi).
- Mỗi return lỗi chỉ ảnh hưởng chính nó (ghi `failures` của job); lỗi job-level (auth, rate limit) mới dừng job.
- Snapshot `channel_api_snapshots` (`entity_type = 'return'`): giữ bản mới nhất + lịch sử khi thay đổi có nghĩa (trạng thái / thời gian / sản phẩm / số tiền); **đã loại** thông tin người mua, địa chỉ, ảnh/video.
- Trạng thái: một bảng duy nhất `src/lib/channels/shopee/return-status.ts` (REQUESTED, ACCEPTED, PROCESSING, JUDGING, SELLER_DISPUTE → chưa kết thúc; REFUND_PAID, CLOSED, CANCELLED → kết thúc). Trạng thái lạ: hiển thị nguyên văn, coi là chưa kết thúc (tiếp tục đồng bộ).

## Khớp dòng đơn gốc

`apply_channel_return` khớp mỗi sản phẩm trả với **dòng đơn gốc** theo `item_id` + `model_id` (không theo tên); cùng mẫu trên nhiều dòng → phân bổ theo thứ tự dòng, mỗi dòng tối đa SL đã bán trừ SL đã trả ở các return khác (return đã huỷ không tính). Phần vượt → dòng "không khớp" (hiển thị, không nhập kho được). Mapping dùng `channel_order_items.internal_product_id` lịch sử, không dùng mapping hiện tại.

## Cách xử lý (disposition)

`set_return_item_disposition` (một giao dịch: audit + tồn kho + tài chính), quyền `return:disposition` (admin):

| Chuyển | Tồn kho | Giá vốn |
|---|---|---|
| → Nhập lại kho | `return_in` (nguồn `channel_return_restock`) theo **giá vốn snapshot gốc** của dòng đơn; combo: từng thành phần theo `channel_order_item_cogs_components` (BOM + giá lúc bán) | `reversed_cogs` += |
| Nhập lại kho → khác | `adjustment_out` bù, cùng SL, cùng giá gốc (lịch sử giữ nguyên) | `reversed_cogs` −= |
| giữa Chờ xử lý / Hỏng / Thất lạc / Huỷ bỏ | không | không |

- Mỗi lần nhập lại là một dòng `channel_return_restocks` (id ổn định) → khóa unique sổ cái chống trùng; tối đa một lần nhập "đang hiệu lực" cho mỗi (dòng trả, sản phẩm).
- Σ SL đã nhập lại của một dòng đơn ≤ SL đã bán (khóa dòng đơn, an toàn khi đồng thời). Dòng đơn chưa có giá vốn gốc (RT003) hoặc đơn đã huỷ & hoàn kho (RT002) → không nhập lại.
- Replay sổ giá vốn: `adjustment_out` của return đi ra đúng giá gốc (lấy lại đúng giá trị đã nhập).

## Tài chính

`net_cogs = internal_cogs − reversed_cogs`; `actual_profit = actual_shopee_income − net_cogs`. COGS gốc của dòng đơn không bao giờ bị sửa. `financial_status = return_adjusted` khi đơn có return chưa huỷ và đã có quyết toán (về lại `settlement_available` / `mismatch` nếu mọi return bị huỷ). Lợi nhuận dự kiến giữ nguyên quy tắc cũ.

Ví dụ (đã test): thu nhập sau hoàn 150.000, COGS 180.000 → Nhập lại kho: 150.000 − 0 = **150.000**; Thất lạc: 150.000 − 180.000 = **−30.000**.

## Checklist payload thật (chưa xác nhận — sandbox chưa có return)

Sandbox xác nhận envelope `get_return_list`: `{ response: { return: [], more } }`. Cần đối chiếu trên return thật:
- [ ] `get_return_list`: tham số `page_no`/`page_size`/`update_time_from`/`update_time_to`, giới hạn 15 ngày
- [ ] `get_return_detail`: `return_sn` (số/chuỗi), `item[].amount` là SL trả, `model_id = 0` khi không biến thể
- [ ] `status` thực tế + thứ tự chuyển; `seller_compensation.compensation_amount`, `negotiation.negotiation_status`, `reverse_logistic_status`
- [ ] escrow của đơn có trả hàng: `escrow_amount_after_adjustment` / `seller_return_refund` khớp số hoàn

## Triển khai production

1. `npx supabase db push --linked` (00057), rồi `NOTIFY pgrst, 'reload schema';`
2. Deploy code.
3. Job `return` tự chạy theo lịch (mỗi 15 phút); return cũ hơn mốc `orders_from` không được kéo về.
4. Mọi return mới mặc định **Chờ xử lý** — không tự giả định đã nhập lại kho. Admin chọn cách xử lý ở `/shopee/returns`.
