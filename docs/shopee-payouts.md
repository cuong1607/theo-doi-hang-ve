# Giải ngân & payout Shopee (SHOPEE-7)

Ba tầng tách biệt — **hoàn thành ≠ đã giải ngân ≠ đã về ngân hàng**:

| Tầng | Bảng | Trả lời câu hỏi | Nguồn |
|---|---|---|---|
| Tài chính đơn | `order_financials` (không đổi) | Đơn này lời bao nhiêu? | `get_escrow_detail` + giá vốn ròng + trả hàng |
| Giải ngân | `order_income_releases`, view `v_order_income_status` | Shopee đã giải ngân tiền của đơn chưa, bao nhiêu, lúc nào? | `get_escrow_list` (shop local) / `get_payout_detail` (shop CB) |
| Payout | `payout_batches` / `payout_orders` / `payout_adjustments` | Lần chuyển tiền này có khớp tổng giải ngân + điều chỉnh không? | `get_payout_detail` (CB) / `get_wallet_transaction_list` (local) |

Lãi của đơn **không bao giờ** lấy từ API giải ngân / payout. `financial_status` không bị đổi bởi giải ngân (trạng thái giải ngân nằm riêng).

## Sự thật từ Sandbox (17/10/2026, shop VN = shop local)

| API | Kết quả |
|---|---|
| `get_income_overview` | ✅ `{ total_income: { pending_amount, released_amount } }` |
| `get_income_detail` | `income_status` chỉ 1 (Released) / 2 (Pending) — "Local shops do not have the To Release status". Status 2 trả `{}`; status 1 từ chối mọi dạng `release_time_from/to` đã thử (unix giây/ms, `YYYY-MM-DD`, …) → **không dùng** |
| `get_payout_detail`, `get_payout_info` | ❌ "This payment API is only applicable for cross boarder shop" |
| `get_escrow_list` (`release_time_from/to`, `page_no` từ 1) | ✅ `{ escrow_list: [], more }` → **nguồn giải ngân** |
| `get_wallet_transaction_list` (`create_time_from/to`, `page_no` từ 0) | ✅ `{ transaction_list: [], more }` → **nguồn payout của shop local** |

Thăm dò lại: `MSYS_NO_PATHCONV=1 npm run shopee:sandbox -- get /api/v2/payment/<api> '<json>'` (chỉ GET, chỉ host sandbox + DB local).

## Đồng bộ

| Job | Nhịp | Ưu tiên (tự động / thủ công) | Việc |
|---|---|---|---|
| `income` | 20 phút (`SHOPEE_SYNC_INCOME_INTERVAL_MINUTES`) | 22 / 3 | quét `get_escrow_list` theo cửa sổ ≤ 14 ngày từ lần thành công − 24 h (lần đầu: 14 ngày, không trước mốc `orders_from`) → `apply_income_releases`; rồi 1 lần `get_income_overview` → `record_income_overview` |
| `payout` | 60 phút (`SHOPEE_SYNC_PAYOUT_INTERVAL_MINUTES`) | 25 / 3 | phát hiện nguồn (1 lần, lưu `shops.payout_source`) → đọc ví / payout theo cửa sổ 14 ngày (lần đầu 30 ngày) → dựng payout từ ví → lấy đơn thiếu (≤ 20 / job, qua order sync) → đối soát lại payout chưa xong |

Thứ tự hàng đợi: đơn (10) → trả hàng (15) → tài chính (20) → giải ngân (22) → payout (25) → sản phẩm (30). Job có checkpoint, phân trang, ngân sách thời gian như các job khác. Backfill có kiểm soát: chế độ backfill theo số ngày (≤ 90). Không có chế độ sửa lỗi theo mã.

"Chờ giải ngân" là **suy ra** (đơn COMPLETED chưa có dòng giải ngân), không gọi API từng đơn; mỗi lần quét đọc lại 24 h gần nhất → đơn vừa hoàn thành được kiểm tra lại tới khi Shopee báo giải ngân. Cửa sổ lỗi → job `partial`, không tiến checkpoint → lần sau đọc lại.

## Trạng thái giải ngân của đơn

| `income_status` | Nghĩa |
|---|---|
| `not_available` | đơn chưa hoàn thành |
| `pending` | hoàn thành, Shopee chưa báo giải ngân (`release_stale` khi quá `channel_sync_settings.release_stale_days`, mặc định 7) |
| `released` | đã giải ngân, chưa so được (chưa có escrow / khác tiền tệ) |
| `reconciled` | khớp |
| `mismatch` | lệch |

Công thức (`reconcile_order_release`, tự chạy lại khi escrow / trả hàng đổi `actual_shopee_income`):

```
kỳ vọng   = actual_shopee_income (escrow sau điều chỉnh, gồm trả hàng)
thực tế   = released_amount + Σ điều chỉnh payout gắn với đơn xảy ra SAU lúc giải ngân
chênh lệch = thực tế − kỳ vọng ; |chênh lệch| ≤ money_match_tolerance(currency) → reconciled
```

`actual_payout_time` = thời điểm giải ngân của Shopee (`escrow_release_time`), không ghi đè thời điểm hoàn thành. `channel_orders.completed_at_channel` ≈ update_time của lần đồng bộ đầu tiên thấy COMPLETED (Shopee không có complete_time) → `days_to_release`.

Dung sai: **một chỗ duy nhất** `money_match_tolerance(currency)` — VND (và tiền không có số lẻ) 1, còn lại 0,01.

## Payout

- Khoá: `(shop_id, provider_payout_id)`. CB: `get_payout_detail` không có id → id suy ra từ thời điểm + số tiền + tiền tệ + payee (ổn định). Local: id = `withdrawal_id` của lần rút.
- **Số tiền payout bất biến** (trigger PO001). Đồng bộ sau báo số khác → `last_provider_amount`, không ghi đè.
- Shop local: mỗi `WITHDRAWAL_CREATED` là một payout; khoảng (lần rút trước, lần rút này] → `ESCROW_VERIFIED_ADD` có mã đơn = đơn, mọi giao dịch tiền khác = điều chỉnh. Trạng thái: hoàn tất nếu có `WITHDRAWAL_COMPLETED` cùng `withdrawal_id` hoặc status giao dịch COMPLETED; huỷ nếu có `WITHDRAWAL_CANCELLED`.

```
kỳ vọng = Σ giải ngân đơn + Σ điều chỉnh (+ số dư ví trước kỳ − số dư còn lại sau khi rút, chỉ shop local)
chênh lệch = số Shopee chuyển − kỳ vọng
```

| `reconciliation_status` | Khi |
|---|---|
| `pending` | payout chưa hoàn tất / đã huỷ |
| `incomplete` | có đơn chưa có trong hệ thống, không rõ số dư ví, khác tiền tệ — **không** báo lệch |
| `matched` / `mismatch` | theo dung sai |

Payout "đóng băng" (khớp + đã hoàn tất, hoặc đã giải quyết / chấp nhận) không bao giờ dựng lại. Đơn về sau (trigger trên `channel_orders`) tự liên kết và đối soát lại.

**Quy ước dấu** (một chỗ: `walletSignedAmount` trong `income-adapter.ts`): + tiền vào, − tiền ra. Giữ dấu Shopee gửi; số không dấu → theo `money_flow`, rồi theo loại (`_MINUS`, `_DEDUCT`, `_CHARGE`, `WITHDRAWAL_CREATED`); không bao giờ theo mô tả.

**Điều chỉnh muộn / trả hàng**: hoàn tiền trước khi giải ngân → đã nằm trong escrow sau điều chỉnh → kỳ vọng tự đúng. Điều chỉnh sau khi đã chuyển tiền → nằm trong payout **sau**; payout cũ giữ nguyên; đối soát đơn cộng điều chỉnh muộn gắn với đơn → không trừ hai lần. Bồi thường không gắn đơn chỉ là điều chỉnh của payout.

**Ghi chú / xử lý** (`add_payout_reconciliation_note`, quyền `payout:reconcile` = admin): ghi chú + trạng thái `open / investigating / resolved / accepted` (đóng phải có lý do). Số tiền và chênh lệch **không bao giờ** bị sửa; mỗi ghi chú lưu chênh lệch tại thời điểm ghi.

Wording: "giải ngân" / "Shopee chuyển" — hệ thống **không** xác nhận tiền đã về ngân hàng.

## Dữ liệu thô

- `channel_api_snapshots` `entity_type = 'income'`: một bản cho mỗi lần số giải ngân của đơn thay đổi (không ghi lại khi không đổi).
- `channel_wallet_transactions.payload`: giao dịch ví đã bỏ tên người mua; không cấp quyền đọc cho `authenticated`.
- `channel_income_overviews`: giữ 90 ngày.

## Checklist payload thật (chưa xác nhận — sandbox không có giải ngân / giao dịch ví)

- [ ] `get_escrow_list`: entry `order_sn`, `payout_amount`, `escrow_release_time`; một đơn có xuất hiện lại khi điều chỉnh sau giải ngân không (nếu có → cần đổi cách cộng điều chỉnh muộn)
- [ ] `get_wallet_transaction_list`: tên trường `transaction_id`, `current_balance`, `withdrawal_id`, `money_flow`; amount có dấu không; `WITHDRAWAL_COMPLETED` có amount 0 không; tên loại giao dịch hoàn tiền / phí quảng cáo
- [ ] `get_income_overview`: kỳ của `released_amount` (toàn bộ? tháng này?) — chênh lệch tổng quan hiện chỉ để tham khảo
- [ ] `get_income_detail`: định dạng `release_time_from/to` cho Released
- [ ] ≥ 5 đơn đã giải ngân: `released_amount` = `actual_shopee_income`? ≥ 1 lần rút tiền: khớp công thức số dư?

## Triển khai production

1. `npx supabase db push --linked` (00058), rồi `NOTIFY pgrst, 'reload schema';`
2. Deploy code.
3. Scheduler tự xếp job `income` (20 phút) và `payout` (60 phút). Lần đầu: giải ngân 14 ngày (không trước mốc `orders_from`), ví 30 ngày. Không có backfill tự động; muốn xa hơn → `requestBackfillAction(shopId, "income" | "payout", days ≤ 90)` (server action có sẵn, admin; chưa có nút riêng trên `/shopee/sync`).
4. Payout chứa đơn trước mốc `orders_from` sẽ là **Thiếu dữ liệu** (đúng — không phải lệch).
