# Runbook — Kết nối shop Shopee (SHOPEE-1)

Dành cho admin hệ thống. Chi tiết kỹ thuật: [`shopee-financial-core.md`](shopee-financial-core.md#shopee-connection--auth-shopee-1).

## 0. Chuẩn bị trên Shopee Open Platform

1. Đăng nhập https://open.shopee.com bằng tài khoản developer, mở App đã được duyệt.
2. Ghi lại **Partner ID** và **Partner Key** của môi trường muốn dùng
   (Live hoặc Test/Sandbox — hai bộ khác nhau, **không trộn**).
3. Khai báo redirect domain của app: `theo-doi-hang-ve.vercel.app`
   (callback đầy đủ: `https://theo-doi-hang-ve.vercel.app/api/shopee/auth/callback`).

## 1. Đặt biến môi trường

Trên **Vercel → Project → Settings → Environment Variables** (Production, và
Preview nếu cần). **Không** đặt tiền tố `NEXT_PUBLIC_`, **không** commit vào git.

| Biến | Giá trị |
|---|---|
| `SHOPEE_PARTNER_ID` | Partner ID |
| `SHOPEE_PARTNER_KEY` | Partner Key |
| `SHOPEE_API_BASE_URL` | Bỏ trống cho Live; sandbox: `https://partner.test-stable.shopeemobile.com` |
| `SHOPEE_REDIRECT_URL` | Bỏ trống (tự suy ra từ `APP_URL`) hoặc URL callback đầy đủ |
| `APP_ENCRYPTION_KEY` | Kết quả của `openssl rand -base64 32` — **lưu vào trình quản lý mật khẩu**; mất/đổi key = phải kết nối lại mọi shop |
| `APP_URL` | `https://theo-doi-hang-ve.vercel.app` (đã có) |

Local (`.env.local`, chỉ khi test sandbox): như trên, `APP_URL=http://localhost:3000`
— chỉ chạy được nếu `localhost` được Shopee chấp nhận làm redirect domain của app test.

## 2. Deploy

1. Áp migration lên Supabase cloud: `npx supabase db push --linked`
   (gồm `00038_shopee_financial_core.sql`, `00039_shop_connection_refresh_lock.sql`).
2. Deploy lên Vercel (biến môi trường chỉ có hiệu lực sau khi deploy lại).

## 3. Kết nối shop

1. Đăng nhập app bằng tài khoản **admin** → menu **Hệ thống → Tích hợp Shopee**
   (`/settings/shopee`).
2. Nếu trang báo "Cấu hình chưa đầy đủ": sửa biến môi trường theo danh sách hiển thị, deploy lại.
3. Bấm **Kết nối shop Shopee** → chuyển sang trang Shopee (link có hiệu lực ~5 phút,
   state có hiệu lực 10 phút — làm liền một mạch).
4. Đăng nhập bằng tài khoản **shop** (không phải main account), chọn shop thí điểm, bấm đồng ý.

## 4. Callback

Shopee chuyển về `/api/shopee/auth/callback`, hệ thống đổi code lấy token rồi quay về
`/settings/shopee` với thông báo:

| Thông báo | Ý nghĩa / xử lý |
|---|---|
| Đã kết nối / Đã kết nối lại | Thành công |
| State không khớp | Phiên quá 10 phút, mở ở trình duyệt khác, hoặc Shopee bỏ `?state=` khỏi redirect → bấm kết nối lại; nếu lặp lại mãi, báo dev (xem "Real payload validation") |
| Tài khoản chính (main account) | Đăng nhập lại bằng tài khoản shop |
| Shopee từ chối đổi token (mã …) | Code hết hạn/đã dùng (bấm lại), hoặc sai partner id/key/host (`error_sign`, `error_param`) |
| Thiếu cấu hình | Xem bước 1 |

## 5. Kiểm tra kết nối

Bấm **Kiểm tra kết nối** → gọi `get_shop_info`. Thành công hiển thị tên shop,
độ trễ và `request_id`. Thất bại hiển thị `[mã lỗi] thông điệp · request_id`.

## 6. Đọc trạng thái

| Mục | Ý nghĩa |
|---|---|
| Đã kết nối | Bình thường; access token (~4 giờ) tự làm mới trước hạn 10 phút khi có lời gọi API |
| Lỗi | Lỗi gần nhất được ghi ở "Lỗi gần nhất"; hệ thống vẫn thử lại ở lần gọi sau |
| Hết hạn / Đã bị thu hồi | Refresh token bị Shopee từ chối → **phải kết nối lại** |
| Access token "đã hết hạn (tự làm mới khi gọi API)" | Bình thường khi lâu không có lời gọi API — chưa có sync/cron ở SHOPEE-1 |

Refresh token của Shopee sống ~30 ngày. Khi chưa có sync định kỳ, nếu không gọi
API (vd bấm "Kiểm tra kết nối") trong hơn 30 ngày thì phải kết nối lại.

## 7. Kết nối lại khi bị thu hồi / hết hạn

Bấm **Kết nối lại** và làm lại bước 3–5. Shop cũ được cập nhật (cùng External Shop
ID), không tạo shop trùng.

## Xử lý sự cố

- **`decrypt_failed`**: `APP_ENCRYPTION_KEY` đã bị đổi → khôi phục key cũ, hoặc kết nối lại shop.
- **`error_sign`**: sai partner key, partner id/host không cùng môi trường, hoặc đồng hồ server lệch > 5 phút.
- **Lỗi mạng / 5xx / rate limit**: tạm thời, không đổi trạng thái kết nối; thử lại sau.
- Gửi Shopee support: kèm `request_id` (có trong "Lỗi gần nhất" và log Vercel `source:"shopee"`).
- **Không bao giờ** dán token, partner key hay `APP_ENCRYPTION_KEY` vào ticket/chat/log.
