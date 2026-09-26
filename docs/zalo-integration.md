# Zalo OA Integration — Phase ZL1 + ZL2 + ZL3 + ZL4 + ZL5 + ZL6 + ZL7

Phase ZL7 là **production hardening** — không thêm business event mới, chỉ
làm module hiện có ổn định hơn: log UI có filter + retry, health status cho
token, token refresh an toàn khi có nhiều request đồng thời, lỗi được phân
loại có cấu trúc, observability logging, và test 1 recipient/preview
low-stock. Xem mục 40 để tra cứu nhanh theo từng hạng mục ZL7 yêu cầu.

Phase ZL1 chỉ làm: OAuth start/callback, token exchange, refresh foundation,
lưu token server-side, và gửi 1 tin nhắn test (tới `ZALO_TEST_RECIPIENT_ID`).

Phase ZL2 xây phần lõi thông báo dùng chung, nằm trên nền ZL1: bảng người
nhận (`notification_recipients`), bảng log gửi (`notification_logs`),
notification service (`sendNotification`, `retryFailedNotification`), cơ chế
chống gửi trùng (dedupe), và UI quản lý người nhận + xem lịch sử gửi.

Phase ZL3 là business event **đầu tiên** dùng `sendNotification()` của ZL2:
`DAILY_RECEIPT_SUMMARY` — tổng hợp hàng về trong ngày (toàn hệ thống + theo
từng nhà cung cấp) và gửi cho mọi người nhận active, tối đa 1 lần/ngày nhờ
dedupe.

Phase ZL4 là business event thứ hai: `LOW_STOCK_ALERT` — cảnh báo khi một
SKU trên màn hình "Theo dõi hàng còn phải về" (`/outstanding`) CHUYỂN trạng
thái (không phải cứ ở trạng thái xấu là spam liên tục). Khác ZL3 (chạy theo
yêu cầu thủ công/cron), ZL4 tự động chạy sau mỗi lần tạo/sửa phiếu nhận hoặc
hóa đơn — không có nút bấm thủ công, không có cron, không có DB trigger.

Phase ZL5 là business event thứ ba, cùng dạng "tổng hợp trong ngày, nút test
thủ công" như ZL3 nhưng cho thanh toán: `DAILY_PAYMENT_SUMMARY` — tổng hợp
`payments`/`payment_items` trong ngày, breakdown theo NCC rồi theo từng hóa
đơn.

Phase ZL6 thêm **cron thật** trên Vercel cho 2 trong 3 business event
"tổng hợp trong ngày" (daily receipt summary, daily payment summary — ZL4
low stock alert không chạy theo cron, nó chạy ngay sau mỗi receipt/invoice
như đã thiết kế từ ZL4). Cron chỉ là một entry point mới gọi lại đúng
`sendDailyReceiptSummary`/`sendDailyPaymentSummary` đã có từ ZL3/ZL5 —
không có logic tính toán nào mới.

Cả 6 phase đều **không có**: DB trigger gọi Zalo trực tiếp (ZL4 gọi từ
server action, không phải trigger/function trong Postgres), broadcast, ZBS
Template Message, hay phân quyền người nhận theo từng loại event (hiện tại:
mọi người nhận active đều nhận mọi thông báo như nhau).

## 1. Architecture

```
Browser                    Next.js (Vercel)                  Zalo
--------                   -----------------                 ----
Click "Kết nối Zalo"  -->  GET /api/zalo/oauth/start
                           - canManageIntegrations() gate
                           - sinh state + PKCE (code_verifier/challenge)
                           - lưu state+verifier vào 2 cookie httpOnly
                           - redirect                    -->  Trang cấp quyền OA
                                                               (user bấm "Đồng ý")
                      <--------------------------------------  redirect kèm ?code&state
GET /api/zalo/oauth/callback
  - validate state (so với cookie) — sai thì reject ngay
  - exchange code -> access/refresh token  ------------>  POST /v4/oa/access_token
                                                       <--  access_token, refresh_token, expires_in
  - encrypt (AES-256-GCM) + lưu vào bảng zalo_connections
  - redirect -> /settings/notifications?zalo=connected

POST /api/zalo/test-message (admin only)
  - getValidZaloAccessToken() (đọc DB, tự refresh nếu sắp hết hạn)
  - sendZaloTextMessage(...)              ------------>  POST /v3.0/oa/message/cs
                                                      <--   { error: 0, ... } | lỗi
```

Module `src/lib/zalo/` tách rõ theo trách nhiệm:

| File | Vai trò |
| --- | --- |
| `env.ts` | Đọc + validate env, throw lỗi rõ ràng nếu thiếu |
| `pkce.ts` | Sinh `state`, `code_verifier`, `code_challenge` (thuần, không I/O) |
| `crypto.ts` | AES-256-GCM encrypt/decrypt token trước khi lưu DB |
| `client.ts` | Hằng số endpoint Zalo + fetch wrapper có timeout |
| `oauth.ts` | Build authorization URL, exchange code/refresh token |
| `token.ts` | Đọc/ghi `zalo_connections`, `getValidZaloAccessToken()` |
| `messages.ts` | `sendZaloTextMessage()` — hàm duy nhất thực sự gửi tin |
| `rate-limit.ts` | Rate limit tối giản, in-memory, cho `/api/zalo/test-message` |

Route handler (`src/app/api/zalo/...`) không bao giờ tự gọi `fetch` tới Zalo
hay tự build URL — luôn đi qua các hàm ở trên. Không component/route nào ở
`src/app/**/*.tsx` (client) import trực tiếp từ `src/lib/zalo/*` — chỉ gọi
qua `fetch()` tới các route `/api/zalo/...` (xem
`send-test-message-button.tsx`).

## 2. Env variables

Tất cả server-only, **không có biến `NEXT_PUBLIC_ZALO_*` nào** (xem mục 9 —
Security).

| Biến | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `ZALO_APP_ID` | Có | App ID trên Zalo Developers |
| `ZALO_APP_SECRET` | Có | Secret key của app — không bao giờ log/hiển thị |
| `ZALO_OA_ID` | Có | ID của OA "Homies" |
| `ZALO_TOKEN_ENCRYPTION_KEY` | Có | Khóa mã hóa token khi lưu DB (chuỗi bất kỳ, xem mục 5) |
| `ZALO_TEST_RECIPIENT_ID` | Có (để gửi test) | UID nhận tin test — xem mục 8, không tự đoán |
| `ZALO_ACCESS_TOKEN` | Không | Bootstrap thủ công để test gửi tin trước khi chạy OAuth |
| `ZALO_REFRESH_TOKEN` | Không | Đi kèm `ZALO_ACCESS_TOKEN`, hiện chưa được dùng để auto-refresh (xem mục 6) |
| `APP_URL` | Nên có | Dùng build `redirect_uri`; mặc định `http://localhost:3000` nếu thiếu |

Cập nhật `.env.example` đã có sẵn các dòng trên (rỗng, không chứa secret
thật). Copy sang `.env.local` và điền giá trị thật để chạy local.

### Env cần thêm trên Vercel

Vào Vercel Project Settings → Environment Variables, thêm đúng 7 biến:
`ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_OA_ID`, `ZALO_TOKEN_ENCRYPTION_KEY`,
`ZALO_TEST_RECIPIENT_ID`, và tùy chọn `ZALO_ACCESS_TOKEN`/`ZALO_REFRESH_TOKEN`
nếu muốn test trước khi OAuth xong. `APP_URL=https://theo-doi-hang-ve.vercel.app`.
Redeploy sau khi thêm.

## 3. Callback URL

```
https://theo-doi-hang-ve.vercel.app/api/zalo/oauth/callback
```

Đã được cấu hình sẵn trên Zalo OA (theo bối cảnh của phase). Local dev dùng
`http://localhost:3000/api/zalo/oauth/callback` (qua `APP_URL`) — **Zalo OA
chỉ chấp nhận callback URL đã đăng ký**, nên OAuth thật (không phải
test-network-failure) chỉ chạy được trên domain đã đăng ký, tức là production
hoặc một URL bạn tự thêm vào cấu hình OA.

## 4. OAuth flow

1. `GET /api/zalo/oauth/start` (admin-only) sinh `state` (32 byte
   random, base64url) + PKCE `code_verifier`/`code_challenge` (S256), lưu cả
   hai vào 2 cookie `httpOnly`, `sameSite=lax`, `secure` khi production, TTL
   10 phút. Redirect tới:
   `https://oauth.zaloapp.com/v4/oa/permission?app_id=...&redirect_uri=...&state=...&code_challenge=...`
2. User đồng ý trên trang Zalo → Zalo redirect về callback URL kèm
   `?code=...&state=...`.
3. `GET /api/zalo/oauth/callback`: so `state` trong URL với cookie
   `zalo_oauth_state` — khác nhau (hoặc thiếu cookie) thì **reject ngay**,
   redirect `/settings/notifications?zalo=error&reason=state_mismatch`,
   không gọi Zalo.
4. Nếu khớp: `POST https://oauth.zaloapp.com/v4/oa/access_token` với
   `code`, `code_verifier`, `grant_type=authorization_code`, `app_id` (body,
   `application/x-www-form-urlencoded`) và header `secret_key`.
5. Parse `access_token`/`refresh_token`/`expires_in`, mã hóa, lưu vào
   `zalo_connections` (upsert theo `oa_id`).
6. Xóa 2 cookie tạm, redirect `/settings/notifications?zalo=connected`.

Lỗi ở bất kỳ bước nào → redirect `?zalo=error&reason=<mã ngắn>` — không bao
giờ kèm token/secret trong URL hay trong log.

## 5. Token storage strategy

Bảng `zalo_connections` (migration `00028_zalo_connections.sql`), một dòng
cho OA "Homies" (unique theo `oa_id`):

| Cột | Ghi chú |
| --- | --- |
| `access_token_encrypted` / `refresh_token_encrypted` | AES-256-GCM, xem dưới |
| `expires_at` | Thời điểm access token hết hạn (nullable) |
| `connected_by` | FK `profiles(id)`, hiện luôn `NULL` — chưa có session thật (Phase 5 auth vẫn deferred) |

**Giới hạn đã biết (đúng như spec cho phép — "không over-engineer" khi
chưa có encryption infra):** đây là mã hóa app-layer nhẹ (Node
`crypto.createCipheriv("aes-256-gcm", ...)`), **không phải** tích hợp với một
secrets manager thật (Vercel Encrypted Env, AWS KMS, HashiCorp Vault...).
Khóa mã hóa (`ZALO_TOKEN_ENCRYPTION_KEY`) là một biến môi trường thường —
nếu ai đó có quyền đọc env Vercel VÀ đọc được DB, họ giải mã được token. Đây
là điểm cải thiện tốt nhất tiếp theo nếu dự án có secrets-manager infra
sau này; phase này không tự dựng thêm hạ tầng đó.

RLS: bảng bật RLS nhưng **không cấp policy nào cho `authenticated`** (khác
với mọi bảng khác trong app) — chỉ `service_role` (admin client,
`createAdminClient()`) đọc/ghi được. Không component/route client-side nào
cần đọc bảng này trực tiếp.

Token **không bao giờ** nằm trong `localStorage`/`sessionStorage`/cookie
lâu dài phía browser — chỉ 2 cookie tạm (state/verifier) dùng trong lúc OAuth
đang chạy, xóa ngay sau khi xong.

## 6. Token refresh flow

`getValidZaloAccessToken()` (trong `token.ts`) là hàm duy nhất mọi lời gọi
Zalo API đi qua:

1. Có kết nối trong DB, còn hạn (> 5 phút tới expiry) → trả token hiện tại.
2. Có kết nối trong DB, sắp/đã hết hạn → gọi `refreshZaloAccessToken()`
   (`POST /v4/oa/access_token` với `grant_type=refresh_token`), lưu đè token
   mới (atomic — access + refresh token luôn được ghi cùng lúc qua một
   `upsert`, không có bước ghi riêng lẻ có thể để lại cặp token lệch nhau).
3. Chưa có kết nối nào trong DB → fallback đọc `ZALO_ACCESS_TOKEN` từ env
   (test bootstrap thủ công). **Giới hạn:** nhánh này KHÔNG tự refresh —
   nếu token thủ công hết hạn, phải lấy token mới thủ công (hoặc chạy OAuth
   thật) và cập nhật lại env. `ZALO_REFRESH_TOKEN` hiện chỉ được chuẩn bị
   sẵn trong `.env.example`, chưa được code dùng tới trong nhánh fallback
   này — đây là giới hạn có chủ đích của "foundation", không phải thiếu sót.
4. Refresh thất bại → trả `{ ok: false, error: { errorCode, errorMessage } }`
   có cấu trúc, không throw ra ngoài.

Chưa có cron tự động refresh — đúng phạm vi phase ("Chưa cần cron refresh
riêng").

## 7. Cách cấu hình trên Zalo Developers

1. Vào [developers.zalo.me](https://developers.zalo.me), chọn app đã liên
   kết với OA "Homies".
2. Mục Official Account → Cấu hình → Callback URL: xác nhận đúng
   `https://theo-doi-hang-ve.vercel.app/api/zalo/oauth/callback` (đã cấu
   hình sẵn theo bối cảnh phase này).
3. Đảm bảo quyền gửi tin nhắn text (OA message) đã được duyệt (đã có theo
   bối cảnh phase).
4. Lấy `App ID` và `Secret Key` từ trang app, `OA ID` từ trang quản trị OA
   → điền vào env (mục 2).

**Lưu ý quan trọng:** `developers.zalo.me` là trang render bằng JS nên
không thể tự động đối chiếu 100% bằng công cụ trong phiên làm việc này. Các
endpoint dùng trong code (mục 4, và hằng số trong `src/lib/zalo/client.ts`)
được đối chiếu chéo từ nhiều nguồn độc lập nhất quán với nhau (SDK chính
thức `zalo-php-sdk` trên GitHub, tài liệu cộng đồng) tại thời điểm code hóa
(2026-09). **Trước khi chạy OAuth thật, hãy tự mở
[developers.zalo.me/docs/social-api/tham-khao/user-access-token-v4](https://developers.zalo.me/docs/social-api/tham-khao/user-access-token-v4)
và xác nhận 3 URL trong `src/lib/zalo/client.ts` (`ZALO_OA_AUTHORIZATION_URL`,
`ZALO_OA_TOKEN_URL`, `ZALO_SEND_MESSAGE_URL`) còn đúng** — nếu Zalo đã đổi,
đây là file DUY NHẤT cần sửa.

## 8. Cách lấy recipient UID

`ZALO_TEST_RECIPIENT_ID` phải là UID Zalo hợp lệ **đối với OA này** (không
phải số điện thoại, không phải Zalo ID cá nhân dùng cho mục đích khác) —
phase này **không tự đoán** UID.

Cách lấy UID hợp lệ (không cần build thêm UI):

1. **Từ một tin nhắn user đã gửi cho OA:** nếu tài khoản của bạn (chủ hệ
   thống) đã từng nhắn tin cho OA "Homies" trên Zalo, vào trang quản trị OA
   (oa.zalo.me) → mục Tin nhắn/Quản lý người quan tâm → mở hội thoại với
   chính bạn → UID hiển thị trong thông tin người dùng (hoặc lấy qua API
   `GET /v3.0/oa/user/detail` bằng access_token — có thể gọi tạm bằng
   Postman/curl khi cần, không cần build route riêng cho việc này).
2. **Follow OA trước:** nếu chưa từng tương tác, hãy quét mã QR / tìm OA
   "Homies" trên Zalo và bấm "Quan tâm" (follow) rồi nhắn một tin bất kỳ —
   Zalo chỉ cho OA gửi tin tới UID đã từng tương tác/quan tâm OA đó trong
   cửa sổ hợp lệ theo chính sách của Zalo.
3. **Widget cấp quyền tương tác** của Zalo (nhúng trên một trang web) cũng
   có thể trả về `user_id` sau khi người dùng đồng ý — nếu muốn dùng cách
   này, đó là điểm mở rộng cho phase sau, không bắt buộc phải build ở ZL1.

Sau khi có UID, đặt vào `ZALO_TEST_RECIPIENT_ID` (env, không hardcode vào
source).

## 9. Cách gửi test message

1. Đăng nhập bằng tài khoản có vai trò admin (xem
   docs/authentication-authorization.md).
2. Vào `/settings/notifications`, bấm **"Kết nối Zalo"** nếu chưa kết nối
   (hoặc đặt `ZALO_ACCESS_TOKEN` thủ công để test trước — mục 6).
3. Bấm **"Gửi tin nhắn thử"**, hoặc gọi trực tiếp:

```
POST /api/zalo/test-message
```

không cần body — recipient luôn lấy từ `ZALO_TEST_RECIPIENT_ID` server-side,
**không nhận recipient từ client**. Response thành công:

```json
{ "success": true, "message": "Đã gửi tin nhắn test" }
```

Nội dung tin nhắn cố định: `"Test kết nối hệ thống Theo dõi hàng về"`.
Có rate limit cơ bản (3 lần/phút/process — xem mục 11).

## 10. Troubleshooting

| Triệu chứng | Nguyên nhân khả dĩ | Cách xử lý |
| --- | --- | --- |
| `/api/zalo/oauth/start` trả 403 | Tài khoản đang đăng nhập không phải admin | Đăng nhập bằng admin, hoặc nhờ admin đổi vai trò ở `/users` |
| `/api/zalo/oauth/start` trả 500 "Thiếu biến môi trường..." | Thiếu `ZALO_APP_ID`/`ZALO_APP_SECRET`/`ZALO_OA_ID` | Điền env, redeploy/restart dev server |
| Callback redirect `reason=state_mismatch` | Cookie state hết hạn (>10 phút), trình duyệt chặn cookie, hoặc bấm lại nút "Kết nối Zalo" ở tab khác | Thử lại từ đầu bằng `/settings/notifications`, không mở nhiều tab OAuth song song |
| Callback redirect `reason=exchange_failed_<mã>` | `ZALO_APP_SECRET` sai, `code` đã dùng rồi (Zalo code chỉ dùng 1 lần), hoặc callback URL trên Zalo OA không khớp `APP_URL` | Kiểm tra lại 3 giá trị env + callback URL trên Zalo Developers |
| `/api/zalo/test-message` trả `errorCode: "not_connected"` | Chưa từng OAuth thành công VÀ chưa đặt `ZALO_ACCESS_TOKEN` | Chạy OAuth hoặc đặt `ZALO_ACCESS_TOKEN` tạm |
| `/api/zalo/test-message` trả lỗi từ Zalo (mã số âm, vd -216) | UID chưa từng tương tác/quan tâm OA, hoặc access token hết hạn | Xem mục 8 để lấy UID hợp lệ; nếu token hết hạn và không có refresh_token, phải OAuth lại |
| 429 "gửi quá nhanh" | Rate limit in-memory (3 req/phút) | Đợi ~1 phút. Rate limit này **không phân tán** — reset mỗi lần redeploy/cold start, không đồng bộ giữa nhiều instance. Nếu endpoint này có traffic thật, thay bằng rate limiter phân tán (Upstash/Redis) |
| Nghi ngờ endpoint Zalo đã đổi | Zalo cập nhật API | Xem mục 7 — chỉ cần sửa 3 hằng số trong `src/lib/zalo/client.ts` |

### Giới hạn còn lại của phase này (đọc trước khi coi là "xong")

- Chưa test được đường thành công thật (OAuth click-through thật + gửi tin
  thật) vì môi trường code hóa này không có Zalo App Secret/OA thật — mọi
  network call thật trong lúc code hóa đều dùng credentials giả và được
  xác nhận thất bại đúng cách (structured error, không crash, không lộ
  secret). Cần chủ hệ thống tự chạy OAuth thật một lần trên production để
  xác nhận đường thành công.
- 3 endpoint Zalo (mục 7) được đối chiếu chéo qua nguồn thứ cấp, không đọc
  được trực tiếp từ trang chính thức (SPA JS) trong phiên làm việc này.
- `ZALO_REFRESH_TOKEN` (env thủ công) chưa được dùng để auto-refresh khi
  đang ở nhánh fallback env — chỉ nhánh DB-backed (sau khi OAuth thật) mới
  auto-refresh.
- Rate limit test-message là in-memory, không phân tán (xem bảng trên).
- Mã hóa token là app-layer nhẹ, không phải secrets-manager thật (mục 5).

---

# Phase ZL2 — Notification core, recipients, delivery logs

## 11. Notification architecture

```
Business event (phase sau — chưa implement)          Admin UI (đã có, ZL2)
  vd: hàng về trong ngày, SKU sắp hết                 "Gửi tin thử cho tất cả"
        |                                                     |
        v                                                     v
              sendNotification({ eventType, message, dedupeKey?, entityType?, entityId? })
                  (src/lib/notifications/service.ts — ĐIỂM DUY NHẤT mọi nơi phải gọi qua)
                                    |
                    1. getActiveNotificationRecipients()
                    2. với mỗi recipient (độc lập, lỗi 1 người không chặn người khác):
                         a. có dedupeKey? hasNotificationBeenSent() -> true: ghi log 'skipped', bỏ qua
                         b. INSERT notification_logs (status='pending')
                         c. sendZaloTextMessage({ recipientId: zaloUid, text: message })  <-- từ ZL1
                         d. UPDATE log -> 'sent' (+ provider_message_id) | 'failed' (+ provider_error_*)
                    3. trả về { success, totalRecipients, sentCount, failedCount, skippedCount, results[] }
```

Không route/component nào khác được gọi `sendZaloTextMessage()` trực tiếp
cho một notification tới nhiều người — luôn đi qua `sendNotification()` để
dedupe/log/error-isolation không bị lặp lại rải rác ở nhiều nơi (Phần 6 của
spec ZL2).

`src/lib/notifications/`:

| File | Vai trò |
| --- | --- |
| `recipients.ts` | `getActiveNotificationRecipients()` (dùng bởi service), `getAllNotificationRecipients()` (dùng bởi UI, gồm cả inactive) |
| `dedupe.ts` | `hasNotificationBeenSent({eventType, recipientId, dedupeKey})` |
| `logs.ts` | `getRecentNotificationLogs(limit)` — cho bảng "Lịch sử gửi gần đây" |
| `service.ts` | `sendNotification(...)`, `retryFailedNotification(logId)` — cả hai `import "server-only"` |

## 12. Recipients model

Bảng `notification_recipients` (migration `00029_notification_recipients_and_logs.sql`):
`id`, `name` (không rỗng — CHECK), `zalo_uid` (UNIQUE), `is_active`,
`created_at`, `updated_at`. Không còn đọc recipient từ env nữa (ngoại trừ
`ZALO_TEST_RECIPIENT_ID` của ZL1, vẫn giữ nguyên cho việc test kết nối OA cơ
bản, tách biệt với danh sách người nhận thật ở đây).

RLS: khác với `zalo_connections` (không cấp quyền `authenticated` nào, vì nó
lưu token), bảng này lưu dữ liệu nghiệp vụ thường (tên + Zalo UID) nên theo
đúng quy ước chung của app: cấp CRUD cho `authenticated`, chặn ở app layer
bằng `canManageNotificationRecipients` (admin-only; staff/viewer chỉ xem —
đúng theo spec "staff/viewer: read nếu cần"), chờ Phase 5 (Authentication)
làm RLS theo role thật.

Quản lý qua `/settings/notifications` (mục "Người nhận thông báo Zalo"):
thêm, sửa tên/UID, bật/tắt active, xóa. Xóa là xóa thật (không phải soft
delete) — nhưng lịch sử gửi cũ của người đó vẫn giữ nguyên vì
`notification_logs.recipient_id` là `ON DELETE SET NULL` và
`recipient_zalo_uid` được lưu kèm (denormalized) ngay trên mỗi dòng log.

## 13. Notification logs

Bảng `notification_logs`: mỗi dòng = một lần thử gửi tới MỘT người nhận
(không phải một lần gọi `sendNotification()`— nếu gửi cho 3 người thì tạo 3
dòng log). `status` chỉ nhận `pending | sent | failed | skipped`. Index trên
`event_type`, `created_at`, `status`, `recipient_id`, `dedupe_key` — dùng
cho các phase sau khi cần lọc/báo cáo theo các chiều này.

UI "Lịch sử gửi gần đây" chỉ lấy 20 dòng mới nhất, không phân trang/báo cáo
đầy đủ (đúng phạm vi ZL2).

## 14. Dedupe strategy

Chỉ áp dụng khi `sendNotification()` được gọi kèm `dedupeKey`. Khóa dedupe
thực tế là bộ ba **`event_type` + `recipient_id` + `dedupe_key`** — nghĩa là
mỗi người nhận được dedupe độc lập (ví dụ: chị Hương đã nhận
`DAILY_RECEIPT_SUMMARY:2026-09-25` không có nghĩa anh Tuấn cũng bị coi là đã
nhận).

Hai lớp bảo vệ:
1. **App layer** (`hasNotificationBeenSent()`): SELECT xem có dòng log
   `status='sent'` nào khớp cả 3 điều kiện chưa — nếu có, `sendNotification()`
   ghi một dòng log `status='skipped'` cho người đó (để còn thấy trong lịch
   sử là "đã bị chặn vì trùng", không phải im lặng bỏ qua) và **không** gọi
   Zalo.
2. **DB layer** (unique index `idx_notification_logs_dedupe_sent_unique`,
   partial trên `WHERE dedupe_key IS NOT NULL AND status = 'sent'`): backstop
   cứng — dù app layer có bug/race condition, DB vẫn từ chối một dòng `sent`
   thứ hai cho cùng bộ ba đó. Index này **không** chặn dòng `pending`/`failed`
   /`skipped` trùng khóa, nên một lần gửi thất bại luôn có thể thử lại (retry)
   mà không bị unique constraint cản.

Ví dụ khóa cho các event tương lai (chưa implement ở ZL2, chỉ chuẩn bị cơ chế):
`DAILY_RECEIPT_SUMMARY:2026-09-25`, `LOW_STOCK:<invoice_item_id>:NEAR_EMPTY:<state_version>`,
`DAILY_PAYMENT_SUMMARY:2026-09-25`.

## 15. Retry strategy

`retryFailedNotification(logId)`: chỉ retry log đang `status='failed'` (log
khác trạng thái → trả lỗi `not_retryable`, log không tồn tại → `not_found`).
Gửi lại tới `recipient_zalo_uid` **lưu sẵn trên chính dòng log** (không cần
join lại `notification_recipients` — vẫn hoạt động đúng dù recipient đã bị
xóa), rồi cập nhật **cùng một dòng log** đó (`sent`/`failed` mới), không tạo
dòng log mới. Không auto-retry lặp lại, không background worker/queue — đây
là "foundation" đúng như spec yêu cầu, **chưa có nút bấm "Thử lại" trên UI**
ở phase này (UI của ZL2 chỉ yêu cầu xem lịch sử, không yêu cầu action retry
trên bảng) — sẵn sàng để một phase sau gắn nút gọi hàm này.

## 16. Cách thêm 2-3 người nhận

1. Lấy Zalo UID thật của từng người theo đúng cách ở mục 8 (KHÔNG tự đoán) —
   UID phải đã tương tác/quan tâm OA "Homies".
2. Vào `/settings/notifications` (admin), mục "Người nhận thông báo Zalo" →
   bấm **"Thêm người nhận"** → nhập Tên + Zalo UID → Lưu. Lặp lại cho từng
   người (2-3 người theo bối cảnh phase này).
3. Trùng UID sẽ bị từ chối ngay với thông báo lỗi rõ ràng (UNIQUE constraint
   ở DB + hiển thị lỗi ở form).
4. Dùng nút bật/tắt (⋮ → Tắt/Bật lại) nếu muốn tạm ngưng một người mà không
   xóa hẳn.

## 17. Cách gửi test cho tất cả

Trên `/settings/notifications`, mục "Người nhận thông báo Zalo" → bấm
**"Gửi tin thử cho tất cả"** (chỉ hiện khi có ít nhất 1 người nhận active).
Gọi `POST /api/notifications/test-all` (admin-only), nội dung cố định
`"Test thông báo hệ thống Theo dõi hàng về"`, đi qua đúng
`sendNotification()` (không gọi Zalo trực tiếp từ UI). Kết quả hiển thị ngay
dạng "Đã gửi: N thành công, M thất bại" kèm nút xem chi tiết từng người; bảng
"Lịch sử gửi gần đây" tự làm mới theo sau.

Lưu ý phân biệt với nút **"Gửi tin nhắn thử"** ở mục "Kết nối Zalo OA" (ZL1):
nút đó chỉ gửi 1 tin tới `ZALO_TEST_RECIPIENT_ID` (kiểm tra kết nối OA cơ
bản), không liên quan tới bảng `notification_recipients`.

### Giới hạn còn lại của Phase ZL2

- Chưa test được một lần gửi **thành công thật** hay kịch bản **"1 người
  thành công, 1 người lỗi"** (test case 6/7 trong spec) vì môi trường code
  hóa này chỉ có Zalo credentials giả — mọi recipient dùng chung 1 access
  token giả nên luôn cùng thất bại (không thể tạo kết quả trộn thành
  công/thất bại mà không có ít nhất 1 credential Zalo thật). Đã verify đầy đủ
  bằng thực nghiệm: 0 recipient, 1 recipient, 3 recipient (có 1 inactive),
  cô lập lỗi từng người (mỗi người có dòng log riêng), dedupe (cả app-layer
  check và DB backstop), và guard của retry. Cần chủ hệ thống tự xác nhận
  kịch bản thành công/trộn sau khi OAuth thật đã kết nối (mục 4).
- `retryFailedNotification` chưa có nút bấm trên UI (xem mục 15).
- Không có phân quyền người nhận theo từng event — mọi người active nhận mọi
  thông báo như nhau (đúng phạm vi ZL2, để dành cho phase sau nếu cần).


# Phase ZL3 — Daily Receipt Summary Notification

## 18. Kiến trúc

```
receipts + receipt_items (ngày X)
        │
        ▼
get_daily_receipt_summary_by_supplier(p_date)   [SQL RPC, migration 00030]
GROUP BY supplier — receipt_count, total_delivered,
total_received, total_difference, total_amount
        │
        ▼
buildDailyReceiptSummary(date)                  [src/lib/notifications/daily-receipt-summary.ts]
cộng các dòng theo supplier lại thành "TỔNG"
        │
        ▼
formatDailyReceiptSummaryMessage(summary)       [daily-receipt-summary-message.ts — pure, không đụng DB]
build text tin nhắn
        │
        ▼
sendDailyReceiptSummary(date)                   [send-daily-receipt-summary.ts]
receiptCount === 0 ? → skip, không gửi
                     → sendNotification({ eventType: "DAILY_RECEIPT_SUMMARY",
                         dedupeKey: `DAILY_RECEIPT_SUMMARY:${date}`, ... })
        │
        ▼
POST /api/notifications/daily-receipt-summary   [admin-only, luôn dùng "hôm nay" theo giờ VN]
```

Tách 2 file rõ ràng theo đúng yêu cầu "tách calculation khỏi message
formatting":
- `daily-receipt-summary-message.ts`: pure, không import DB/`@/` alias nào —
  chứa `getTodayDateVN()`, `formatDailyReceiptSummaryMessage()`, và các type.
  File này chạy được trực tiếp bằng `node --test` (xem mục 20).
- `daily-receipt-summary.ts`: `buildDailyReceiptSummary(date)` — gọi RPC, có
  DB access, re-export lại các hàm pure ở trên cho tiện import từ nơi khác.

Mỗi khối (từng NCC + TỔNG) trong tin nhắn có thêm 2 dòng tiền: **"Tổng
tiền"** (= `totalAmount`, tổng `line_total` của các dòng hàng) và **"Tổng
tiền sau VAT"** (= `totalAmount × 1.08`, làm tròn 2 chữ số thập phân — cùng
tỷ lệ 8% đang dùng ở trang chi tiết hàng về theo ngày
`/receipts/daily/[date]/[supplierId]`). Đây là VAT hiển thị theo quy ước
receipts, khác với VAT snapshot theo từng invoice/supplier_type (UP1-UP4) —
receipts không có khái niệm VAT theo loại NCC.

## 19. Cách tính ngày (Asia/Ho_Chi_Minh)

`receipts.receipt_date` là cột `date` thuần (không có giờ), nên bản thân
việc lọc theo ngày không có vấn đề timezone. Vấn đề chỉ nằm ở chỗ **xác định
"hôm nay" là ngày nào** khi server chạy trên Vercel (UTC) — lệch 7 tiếng so
với giờ Việt Nam có thể khiến "hôm nay" bị tính sai vào buổi tối.
`getTodayDateVN()` dùng `Intl.DateTimeFormat` với `timeZone:
"Asia/Ho_Chi_Minh"` để luôn ra đúng ngày VN bất kể server chạy ở múi giờ nào.

## 20. Test

```
node --env-file=.env.local --test src/lib/notifications/daily-receipt-summary.test.ts
```

7 test case cho `formatDailyReceiptSummaryMessage`/`getTodayDateVN` (pure,
không cần DB) — bao gồm nhiều NCC kèm dòng Tổng tiền/Tổng tiền sau VAT, chênh lệch âm,
format tiền VND). `buildDailyReceiptSummary`/`sendDailyReceiptSummary` không
unit-test được trực tiếp (đụng DB thật qua `@/lib/supabase/admin`, không
resolve được dưới `node --test` thường) — đã verify bằng 2 script thực
nghiệm tạm thời (đã xoá sau khi dùng):

- Script 1 (đọc real RPC, không đụng dữ liệu thật ngoại trừ 3 phiếu tạo/xoá
  trên ngày giả `2030-01-15`): xác nhận aggregation đúng cho no-receipts,
  nhiều NCC, nhiều phiếu cùng NCC, sáng+chiều gộp lại, chênh lệch âm/dương,
  tổng tiền.
- Script 2 (gọi thật `POST /api/notifications/daily-receipt-summary` trên
  dev server + dữ liệu phiếu thật của "hôm nay"): xác nhận gửi không bị skip
  khi có phiếu thật, cô lập lỗi từng người nhận (3 người nhận thật, mỗi
  người 1 kết quả riêng), và dedupe đúng theo từng người nhận (seed 1 dòng
  log `sent` giả cho 1 người — kỹ thuật giống ZL2 vì môi trường này không có
  Zalo credentials thật nên không thể tạo ra 1 lần gửi thành công thật — rồi
  gửi lần 2: đúng người đó bị "skipped", 2 người còn lại vẫn thử gửi lại
  bình thường). Đã dọn sạch toàn bộ `notification_logs` do script tạo ra sau
  khi test xong; 3 người nhận thật (`anh Công`, `Cường`, `Số Hotline`) được
  giữ nguyên vì đó là dữ liệu thật của người dùng, không phải test data.

## 21. Giới hạn còn lại của Phase ZL3

- Chưa có cron — nút "Gửi báo cáo hàng về hôm nay" trên
  `/settings/notifications` là cách duy nhất để trigger, đúng phạm vi ("test
  thủ công trước khi cron").
- Cùng giới hạn với ZL2: chưa thể chứng minh một lần gửi Zalo **thành công
  thật** trong môi trường này (không có Zalo credentials thật).
- `low stock` và `payment summary` — 2 business event còn lại được nhắc tới
  trong bối cảnh ZL2/ZL3 — vẫn chưa được xây ở thời điểm ZL3; `low stock` đã
  được xây ở ZL4 (xem bên dưới), `payment summary` vẫn để dành cho phase sau.


# Phase ZL4 — Low Stock / Outstanding Alert

## 22. State machine

Trạng thái theo dõi (lưu ở `notification_event_states`, KHÁC với
`v_outstanding.status` — xem bảng map bên dưới):

```
              remaining_qty >= 15              0 <= remaining_qty < 15         remaining_qty < 0
                    normal      ────────────►    near_empty      ────────────►   over_received
                       ▲                              │  ▲                            │
                       │        (không alert)         │  │      (không alert)         │
                       └──────────────────────────────┘  └────────────────────────────┘
                         near_empty -> normal              over_received -> bất kỳ
```

| v_outstanding.status (migration 00014) | notification_event_states.current_state |
|---|---|
| `normal` | `normal` |
| `low` | `near_empty` |
| `need_makeup` | `over_received` |

**Chỉ gửi alert khi (đúng theo spec):**
- `normal → near_empty` ("Sắp hết")
- `normal → over_received` hoặc `near_empty → over_received` ("Cần xuất bù")

**Không gửi alert khi:** trạng thái không đổi (ví dụ `near_empty →
near_empty`, dù remaining_qty giảm từ 12 xuống 10) — đây là cơ chế chống
spam chính; `near_empty → normal` hoặc `over_received → bất kỳ` (đều là hồi
phục, chỉ update state âm thầm, không alert).

Logic thuần (`toTrackedState`, `shouldAlert`) nằm ở
`src/lib/notifications/outstanding-alert-state.ts` — file này không đụng DB
nên test được trực tiếp bằng `node --test` (8 test case, xem mục 26).

## 23. Kiến trúc

```
create/edit phiếu nhận (receipts/actions.ts)
create/edit hóa đơn     (invoices/actions.ts)
        │  (sau khi RPC ghi DB thành công)
        ▼
triggerOutstandingAlertCheck({ supplierIds, productIds })   [never throws — bọc try/catch]
        │
        ▼
evaluateOutstandingNotifications({ supplierIds, productIds })
  1. Đọc v_outstanding (WHERE supplier_id IN … AND product_id IN …)
  2. Đọc notification_event_states cũ cho các invoice_item liên quan
  3. Với mỗi invoice_item: so newState vs oldState (mặc định "normal" nếu
     chưa có row) — bỏ qua nếu không đổi
  4. Gom các invoice_item CẦN alert lại theo supplier_id (batch)
  5. Upsert TOÀN BỘ state mới đổi trong 1 câu lệnh
  6. Với mỗi supplier có batch cần alert → sendNotification() 1 lần
        │
        ▼
sendNotification()   [ZL2 — fan-out cho mọi recipient active, ghi log, dedupe]
```

Không có DB trigger nào gọi thẳng Zalo — đúng theo "TRIGGER STRATEGY" của
spec. `evaluateOutstandingNotifications()` không quan tâm điều gì gây ra
thay đổi (receipt mới, receipt sửa, hay hóa đơn) — nó luôn đọc TRẠNG THÁI
HIỆN TẠI từ `v_outstanding` và so với trạng thái đã lưu, nên gọi lại nhiều
lần cho cùng 1 thay đổi là an toàn (idempotent — xem mục 25).

## 24. Batch theo supplier

Nếu 1 lần evaluate làm nhiều SKU cùng supplier cùng cần alert (vd 1 phiếu
nhận có 10 SKU), chỉ gửi **1 tin nhắn** cho supplier đó thay vì N tin riêng:

- 1 SKU cần alert → dùng format chi tiết đầy đủ (NCC/SKU/Sản phẩm/SL hóa
  đơn/Đã nhận/Còn lại/HĐ — đúng ví dụ trong spec).
- ≥2 SKU cùng supplier cần alert trong cùng 1 lần evaluate → dùng format gọn
  "CẢNH BÁO HÀNG" liệt kê từng SKU 1 dòng (đúng ví dụ batch trong spec).

Đã verify thực nghiệm: 1 phiếu nhận đổi cả 2 SKU cùng lúc → đúng 1 alert
batch, 3 dòng `notification_logs` (1 lần gửi × 3 người nhận), không phải 6
dòng.

## 25. Dedupe

Cơ chế chống trùng có 2 lớp:

1. **Lớp chính (state machine):** một khi `evaluateOutstandingNotifications`
   ghi `current_state` mới, lần gọi kế tiếp cho cùng invoice_item sẽ thấy
   `newState === oldState` (trừ khi trạng thái thật sự đổi tiếp) → tự động
   không alert lại. Đây là lý do gọi `evaluateOutstandingNotifications`
   nhiều lần cho cùng 1 thay đổi (vd do double-submit) vẫn an toàn.
2. **Lớp phụ (dedupeKey ở sendNotification, ZL2):**
   `LOW_STOCK_ALERT:<supplierId>:<ISO timestamp của lần evaluate này>` —
   dùng 1 timestamp dùng chung cho cả batch, đóng vai trò "version" như
   spec gợi ý ("dùng event state updated timestamp/version"). Đây chỉ là
   lớp phòng vệ bổ sung cho trường hợp đua (race) hiếm gặp — lớp chính (1)
   mới là cơ chế chống spam chủ lực.

## 26. Test

```
node --env-file=.env.local --test src/lib/notifications/outstanding-alert-state.test.ts
node --env-file=.env.local --test src/lib/notifications/outstanding-alert-message.test.ts
```

8 test case cho state machine thuần (`toTrackedState`/`shouldAlert` — toàn
bộ ma trận chuyển trạng thái) + 4 test case cho message formatting thuần
(single SKU near_empty/over_received đúng ví dụ spec, batch nhiều SKU đúng
ví dụ spec, item rỗng phải throw).

`evaluateOutstandingNotifications`/`triggerOutstandingAlertCheck` đụng DB
thật (`v_outstanding`, `notification_event_states`, `sendNotification`) nên
không unit-test trực tiếp được — đã verify bằng thực nghiệm sống trên DB
thật + dev server thật:

- **2 lượt Playwright thật** qua `/receipts/new` và `/receipts/[id]/edit`
  (tạo phiếu thật, sửa phiếu thật) — chứng minh code trong
  `receipts/actions.ts` THẬT SỰ gọi `triggerOutstandingAlertCheck` sau khi
  lưu (không chỉ đọc code): case 1 (normal → near_empty, tạo phiếu nhận 18/30
  → còn 12 → alert "SẮP HẾT" đúng nội dung), case 3+9 (sửa phiếu về nhận 5 →
  còn 25 → near_empty → normal, không alert, và tự re-evaluate khi edit),
  case 7 (3 người nhận thật đều có dòng log riêng).
- **1 route test tạm thời** (`POST /api/notifications/zl4-test-evaluate`,
  gọi thẳng `evaluateOutstandingNotifications` — ĐÃ XÓA sau khi test xong,
  không phải deliverable) dùng để dựng nhanh các kịch bản còn lại bằng cách
  tạo receipt thẳng qua RPC (`create_receipt`) rồi gọi route này để trigger
  evaluate: case 2 (near_empty → near_empty, 13→12, không alert), case 4
  (normal → near_empty lần 2, sau khi đã reset về normal), case 5 (near_empty
  → over_received), case 6 (normal → over_received trực tiếp, message đúng
  "CẦN XUẤT BÙ" và "Còn lại: -5"), case 8 (1 phiếu đổi 2 SKU cùng lúc → 1
  batch, không phải 2), case 10 (gọi lại evaluate nhiều lần cho cùng trạng
  thái over_received → không spam thêm).
- Toàn bộ 4 sản phẩm test, 4 hóa đơn test, 7 phiếu nhận test, các dòng
  `notification_event_states` và `notification_logs` (event_type
  `LOW_STOCK_ALERT`) do test tạo ra đã được xóa sạch sau khi verify xong.

**Chưa verify riêng bằng UI:** `createInvoice`/`updateInvoice` trong
`invoices/actions.ts` dùng đúng pattern gọi `triggerOutstandingAlertCheck`
giống hệt `receipts/actions.ts` (đã verify), nhưng chưa có 1 lượt Playwright
thật riêng cho hóa đơn — rủi ro thấp do code đối xứng, nhưng nên xác nhận
nếu có thời gian.

## 27. Giới hạn còn lại của Phase ZL4

- Không có UI/nút test thủ công cho alert này (đúng phạm vi spec — không
  yêu cầu "ADMIN TEST" như ZL3).
- Cùng giới hạn với ZL2/ZL3: chưa chứng minh được 1 lần gửi Zalo **thành
  công thật** (không có Zalo credentials thật trong môi trường này).
- Race condition lý thuyết: 2 lần evaluate cho cùng 1 thay đổi chạy đồng
  thời (trước khi lần đầu kịp ghi state mới) có thể cả 2 đều alert — chấp
  nhận được cho quy mô dùng thực tế (1 admin, nhập tuần tự), không xây khóa
  DB (advisory lock) cho việc này ở phase này.
- `notification_event_states` không có FK tới `invoice_items` — nếu 1
  invoice_item bị xóa (sửa hóa đơn xóa dòng), row state cũ nằm lại vô hại
  (không bao giờ được đọc lại nữa) chứ không tự dọn.


# Phase ZL5 — Daily Payment Summary Notification

## 28. Kiến trúc

```
payments + payment_items + invoices + suppliers (ngày X)
        │
        ▼
get_daily_payment_summary_by_invoice(p_date)   [SQL RPC, migration 00032]
GROUP BY (supplier, invoice) — amount_paid = SUM(payment_items.amount)
        │
        ▼
buildDailyPaymentSummary(date)                 [daily-payment-summary.ts]
gom các dòng theo supplier lại thành supplierTotal + TỔNG THANH TOÁN;
đếm payment_count bằng 1 query COUNT(*) riêng (không suy ra được từ
breakdown theo invoice, vì 1 payment có thể trải trên nhiều hóa đơn)
        │
        ▼
formatDailyPaymentSummaryMessage(summary)      [daily-payment-summary-message.ts — pure]
        │
        ▼
sendDailyPaymentSummary(date)                  [send-daily-payment-summary.ts]
paymentCount === 0 ? → skip, không gửi
                     → sendNotification({ eventType: "DAILY_PAYMENT_SUMMARY",
                         dedupeKey: `DAILY_PAYMENT_SUMMARY:${date}`, ... })
        │
        ▼
POST /api/notifications/daily-payment-summary  [admin-only, luôn "hôm nay" giờ VN]
```

Cùng cấu trúc tách file như ZL3 (`*-message.ts` thuần/test được,
`*.ts` đụng DB). `getTodayDateVN()` giờ nằm ở file dùng chung
`src/lib/notifications/date-vn.ts` (tách ra khỏi
`daily-receipt-summary-message.ts` khi làm ZL5, vẫn re-export lại ở đó để
không phá import cũ) — cả ZL3 và ZL5 cùng dùng 1 định nghĩa "hôm nay theo
giờ VN".

## 29. Group theo invoice, không chỉ theo supplier

Khác ZL3 (chỉ cần tổng theo supplier), tin nhắn ZL5 cần liệt kê từng **hóa
đơn** trong mỗi NCC ("HĐ 001: 10.000.000 đ"), nên SQL group theo
`(supplier, invoice)` chứ không dừng ở supplier. Nếu 2 payment khác nhau
cùng trả cho 1 hóa đơn trong cùng 1 ngày, số tiền được **cộng gộp vào 1
dòng** cho hóa đơn đó (đã verify: payment 10 triệu + payment 5 triệu cho
cùng HĐ trong ngày → hiển thị đúng 1 dòng 15 triệu, không phải 2 dòng).

## 30. Test

```
node --env-file=.env.local --test src/lib/notifications/daily-payment-summary.test.ts
```

5 test case cho `formatDailyPaymentSummaryMessage` (pure) — đúng ví dụ mẫu
trong spec, 1 payment/1 hóa đơn, 1 payment/nhiều hóa đơn, format VND, và
trường hợp không có supplier nào.

`buildDailyPaymentSummary`/`sendDailyPaymentSummary` đụng DB thật — verify
bằng 2 script thực nghiệm tạm thời (đã xoá sau khi dùng):

- Script 1 (dữ liệu giả trên ngày `2030-03-15`, tạo/xoá 3 payment cho 2 NCC
  + 3 hóa đơn test): xác nhận đúng cả 6 test case tính toán — không có
  payment, 1 payment/1 hóa đơn, 1 payment/nhiều hóa đơn, nhiều payment cùng
  NCC (cộng gộp đúng vào cùng 1 hóa đơn), nhiều NCC, và `payment_count`
  đúng bằng số dòng `payments` thực tế (không lẫn với `invoice_count`).
- Script 2 (gọi thật `POST /api/notifications/daily-payment-summary` trên
  dev server + 2 payment test thật dán vào "hôm nay"): xác nhận gửi không
  skip khi có payment thật, fan-out đúng số người nhận active hiện tại (2
  người: anh Công, Cường), và dedupe đúng theo từng người (seed 1 log
  `sent` giả — cùng kỹ thuật ZL3/ZL4 vì môi trường không có Zalo credentials
  thật). Đã dọn sạch toàn bộ payment/log do script tạo.

## 31. Sample message

```
THANH TOÁN 25/09/2026

Tuấn Hậu
- HĐ 001: 10.000.000 đ
- HĐ 002: 20.000.000 đ
Tổng NCC: 30.000.000 đ

Minh Hoa
- HĐ MH-125: 15.500.000 đ
Tổng NCC: 15.500.000 đ

TỔNG THANH TOÁN:
45.500.000 đ
```

(Tái tạo chính xác byte-cho-byte trong unit test — xem mục 30.)

## 32. Giới hạn còn lại của Phase ZL5

- Không hiển thị `payment_count`/`invoice_count` trong nội dung tin nhắn —
  2 số này được tính và trả về trong `DailyPaymentSummary` (đúng yêu cầu
  CALCULATION của spec) nhưng ví dụ tin nhắn trong spec không hiển thị
  chúng, nên `formatDailyPaymentSummaryMessage` cũng không thêm dòng nào
  cho chúng.
- Cùng giới hạn với ZL2/ZL3/ZL4: chưa chứng minh được 1 lần gửi Zalo
  **thành công thật** (không có Zalo credentials thật trong môi trường
  này).
- Chưa có cron — nút "Gửi báo cáo thanh toán hôm nay" là cách duy nhất để
  trigger, đúng phạm vi spec. **Đã có cron từ ZL6, xem bên dưới.**


# Phase ZL6 — Notification Scheduling with Vercel Cron

## 33. Cron routes

```
GET /api/cron/daily-receipt-summary   -> sendDailyReceiptSummary(getTodayDateVN())
GET /api/cron/daily-payment-summary   -> sendDailyPaymentSummary(getTodayDateVN())
```

Không có logic tính toán riêng cho cron — cả 2 route chỉ làm 3 việc: (1)
kiểm tra `CRON_SECRET`, (2) tính "hôm nay" theo giờ VN, (3) gọi ĐÚNG service
mà nút test thủ công trên `/settings/notifications` (ZL3/ZL5) đã dùng. Cron
và nút bấm thủ công dùng chung 100% code tính toán/gửi — không có bản sao
nào khác.

## 34. Lịch chạy — UTC tương ứng giờ Việt Nam

Việt Nam dùng UTC+7 quanh năm, **không có DST** (không lùi/tiến giờ theo
mùa) — nên phép quy đổi dưới đây đúng mọi ngày trong năm, không cần bảng
quy đổi theo mùa như timezone có DST.

| Job | Giờ VN mong muốn | Giờ UTC (VN − 7h) | `vercel.json` schedule |
|---|---|---|---|
| `daily-receipt-summary` | 18:00 | 11:00 | `0 11 * * *` |
| `daily-payment-summary` | 19:00 | 12:00 | `0 12 * * *` |

```json
// vercel.json
{
  "crons": [
    { "path": "/api/cron/daily-receipt-summary", "schedule": "0 11 * * *" },
    { "path": "/api/cron/daily-payment-summary", "schedule": "0 12 * * *" }
  ]
}
```

Cron chỉ quyết định **khi nào route được gọi** — route tự tính lại "hôm
nay" bằng `getTodayDateVN()` (`Intl.DateTimeFormat` với `timeZone:
"Asia/Ho_Chi_Minh"`, đã có từ ZL3/ZL5), không phụ thuộc giờ hệ thống của
Vercel function (chạy UTC). Nếu Vercel gọi route trễ vài phút (cron không
đảm bảo chính xác tuyệt đối theo giây), ngày tính vẫn đúng trừ khi trễ tới
mức vượt qua nửa đêm giờ VN — rủi ro không đáng kể ở khung giờ 18h/19h.

## 35. Bảo mật

`CRON_SECRET` — server-only, **không phải** `NEXT_PUBLIC_CRON_SECRET`. Cơ
chế theo đúng tài liệu Vercel hiện tại: khi cấu hình `CRON_SECRET` trong
Environment Variables của Vercel project, Vercel tự động gắn header
`Authorization: Bearer $CRON_SECRET` vào mọi lần gọi cron đã lên lịch. Route
so khớp header này với `process.env.CRON_SECRET`:

```ts
isAuthorizedCronSecret(request.headers.get("authorization"), process.env.CRON_SECRET)
```

Sai secret hoặc thiếu header → **401** (không phải 403 — cron endpoint
không dùng hệ thống role của app, đây là một khách hàng "máy" không phải
người dùng đăng nhập). Nếu `CRON_SECRET` chưa được set (quên cấu hình) →
**fail closed**, luôn từ chối, không bao giờ coi "chưa set = mở cho tất cả".

`isAuthorizedCronSecret` là hàm thuần (nhận `authHeader` + `expectedSecret`
làm tham số, không tự đọc `process.env`/`Request`) — tách vậy để unit-test
được bằng `node --test` mà không cần giả lập `Request` thật.

**Cần bạn tự làm khi deploy thật:** set `CRON_SECRET` trong Vercel project
settings (giá trị ngẫu nhiên dài, ví dụ `openssl rand -base64 32`) — route
sẽ tự động fail-closed cho tới khi làm việc này.

## 36. Idempotency (Vercel retry)

Không có cơ chế idempotency MỚI riêng cho ZL6 — dedupe đã có sẵn từ ZL2 áp
dụng nguyên vẹn: mỗi `sendNotification()` cho `DAILY_RECEIPT_SUMMARY`/
`DAILY_PAYMENT_SUMMARY` dùng `dedupeKey` theo ngày
(`DAILY_RECEIPT_SUMMARY:<date>`, `DAILY_PAYMENT_SUMMARY:<date>`). Nếu
Vercel gọi cron 2 lần cho cùng 1 ngày (retry do timeout, lỗi mạng, …):

- Người nhận đã có log `status='sent'` cho ngày đó → lần gọi thứ 2 bị
  **skip** (không gửi lại).
- Người nhận có log `status='failed'` (lần đầu gửi thật ra Zalo bị lỗi) →
  lần gọi thứ 2 **được phép thử lại** — đây là hành vi ĐÚNG (thất bại thật
  sự cần được thử lại), không phải lỗi idempotency.

Đã verify thực nghiệm: gọi cron 2 lần liên tiếp cho cùng ngày, sau khi seed
1 dòng log `sent` giả cho 1 người nhận (kỹ thuật giống ZL3-ZL5 vì môi
trường này không có Zalo credentials thật), người đó nhận đúng
`status: "skipped"` ở lần gọi thứ 2, 2 người còn lại vẫn thử gửi lại bình
thường.

## 37. Logging

Mỗi lần chạy log 2 dòng (không log token, không log nội dung tin nhắn):

```
[cron:daily-receipt-summary] started date=2026-09-25
[cron:daily-receipt-summary] completed date=2026-09-25 totalRecipients=3 sent=0 failed=3 skipped=0
```

hoặc khi không có dữ liệu:

```
[cron:daily-receipt-summary] completed date=2026-09-25 skipped reason=NO_RECEIPTS
```

Lỗi hệ thống (không phải lỗi gửi từng recipient, mà lỗi khiến cả
`sendDailyReceiptSummary` throw) log riêng bằng `console.error` kèm
`err.message`, route trả về 500.

## 38. Test

```
node --env-file=.env.local --test src/lib/cron/auth.test.ts
```

7 test case cho `isAuthorizedCronSecret` (pure) — đúng secret, sai secret,
thiếu header, thiếu prefix "Bearer ", `CRON_SECRET` rỗng/chưa set (fail
closed), case-sensitive/không match từng phần.

Route thật (`GET /api/cron/*`) verify bằng 1 script thực nghiệm sống trên
dev server thật + DB thật (đã xoá sau khi dùng):

- **case 1** (secret đúng) → 200, `success:true`.
- **case 2** (secret sai / thiếu header) → 401 cho cả 2 route.
- **case 3** (gọi lại 2 lần liên tiếp = giả lập Vercel retry) → người nhận
  đã "gửi" (seed) không bị gửi lại, những người khác vẫn thử lại — xem mục
  36.
- **case 4** (timezone rollover) → `date` trả về từ route khớp chính xác
  với `getTodayDateVN()` tính độc lập trong script.
- **case 5** (không có dữ liệu) → **verify được thật cho payment cron**
  (hôm nay không có payment thật tại thời điểm test → route trả về đúng
  `{skipped:true, reason:"NO_PAYMENTS"}`); phía receipt cron hôm nay có dữ
  liệu thật nên không lặp lại test này qua route — logic `NO_RECEIPTS` cho
  service dùng chung đã được test riêng ở ZL3.
- **case 6/7** (gửi thành công / 1 phần lỗi) — cùng giới hạn ZL2-ZL5: không
  có Zalo credentials thật trong môi trường này nên không tạo được kết quả
  thành công thật hay trộn thành công/thất bại; đã verify phần có thể verify
  (không skip khi có dữ liệu thật, fan-out đúng số người nhận, mỗi người 1
  kết quả riêng).
- Toàn bộ `notification_logs` do script tạo ra (bao gồm cả 3 dòng phát sinh
  từ một lần gọi thử route thủ công trước khi viết script) đã được xoá sạch
  sau khi verify xong.

## 39. Giới hạn còn lại của Phase ZL6

- Chưa deploy thật lên Vercel trong phiên làm việc này nên chưa thể xác
  nhận Vercel thực sự gửi đúng header `Authorization: Bearer $CRON_SECRET`
  như tài liệu mô tả — cơ chế đã cài đúng theo tài liệu Vercel hiện tại,
  nhưng cần bạn xác nhận sau khi deploy + set `CRON_SECRET` thật (mục 35).
- Cùng giới hạn với ZL2-ZL5: chưa chứng minh được 1 lần gửi Zalo **thành
  công thật**.
- Không có cơ chế "chạy bù" (backfill) nếu cron bị miss hoàn toàn 1 ngày
  (ví dụ Vercel downtime) — ngày đó sẽ không có summary nào được gửi, và
  không tự động gửi bù vào lần chạy kế tiếp (lần chạy kế tiếp chỉ tính cho
  "hôm nay" của chính nó). Không nằm trong phạm vi spec, nêu ra để biết.


# Phase ZL7 — Zalo Notification Production Hardening

## 40. Mục lục theo hạng mục (đúng thứ tự spec yêu cầu)

| Hạng mục trong spec | Xem mục |
|---|---|
| Architecture | 1, 23 |
| OAuth | 4, 5, 6 |
| Recipients | 12, 16 |
| Logs | 13, 44 |
| Daily jobs | 18, 28, 33 |
| Low stock state machine | 22 |
| Cron schedules | 34 |
| Retry | 15, 45 |
| Troubleshooting | 10, 46 |
| Production checklist | 47 |

## 41. Health status

`/settings/notifications` giờ hiển thị 2 badge độc lập thay vì 1:

- **Zalo OA**: Đã kết nối / Cần kết nối lại / Chưa kết nối.
- **Token**: Valid / Expired / Refresh failed.

`getZaloConnectionStatus()` (`src/lib/zalo/token.ts`) tính token status theo
thứ tự ưu tiên:

1. Thử giải mã `access_token_encrypted` ngay tại chỗ (rẻ — chỉ là crypto cục
   bộ, không gọi mạng). Giải mã lỗi → **Refresh failed** ngay, không đợi
   lần gửi tin thật tiếp theo mới phát hiện ra. Đây là fix quan trọng nhất
   của phase này — xem mục 43.
2. Nếu giải mã được nhưng `last_refresh_error_code` (cột mới, migration
   00033) đang có giá trị → **Refresh failed** (lần refresh gần nhất thất
   bại, chưa có lần thành công nào sau đó).
3. Nếu `expires_at` đã qua → **Expired**.
4. Còn lại → **Valid**.

`connectionHealth` ("Đã kết nối"/"Cần kết nối lại"/"Chưa kết nối") suy ra
trực tiếp từ token status. Không bao giờ hiển thị token thật — chỉ badge +
mã lỗi + thông điệp lỗi (không chứa token).

## 42. Phân loại lỗi có cấu trúc

`src/lib/zalo/error-category.ts` — `categorizeZaloError(errorCode)` map mọi
`providerErrorCode` đã lưu trong `notification_logs` vào 1 trong 6 nhóm:

```
auth_error | invalid_recipient | recipient_unreachable | rate_limit | provider_temporary_error | unknown
```

2 tầng tin cậy khác nhau:
- Mã lỗi **tự đặt** (`not_connected`, `no_refresh_token`, `decrypt_failed`,
  `network_error`, `invalid_response`, `unexpected_error`, `invalid_input`)
  — 100% chắc chắn, tự viết ra trong `token.ts`/`messages.ts`/`client.ts`.
- Mã lỗi **số của Zalo** (`-201`, `-213`, `-214`, `-32`, ...) — best-effort,
  lấy từ nguồn cộng đồng/SDK vì developers.zalo.me không cào được (cùng lý
  do ZL1 từng flag URL endpoint). Sai ở tầng này chỉ làm sai nhãn hiển thị,
  không ảnh hưởng logic gửi/lưu log/dedupe/retry (tất cả đều dùng
  `errorCode` gốc, không dùng category).

Log UI hiển thị category dưới dạng tooltip (hover vào error code).

## 43. Token refresh — production-safe (PHẦN QUAN TRỌNG NHẤT của ZL7)

### 43.1. Phát hiện thật trong lúc làm phase này: decrypt failure bị nuốt thành lỗi vô nghĩa

Khi verify sống, phát hiện: token đang lưu trong `zalo_connections` của môi
trường này **không giải mã được** bằng `ZALO_TOKEN_ENCRYPTION_KEY` hiện tại
(rất có thể do giá trị biến môi trường này bị đổi sau khi kết nối OAuth
thật đã diễn ra). Trước fix:

- `decryptToken()` (`crypto.ts`) `throw` khi auth-tag không khớp.
- `getStoredConnection()` gọi `decryptToken()` không có try/catch.
- `sendZaloTextMessage()` gọi `getValidZaloAccessToken()` (chain dẫn tới
  `getStoredConnection()`) cũng không có try/catch quanh lời gọi đó.
- Kết quả: exception bay thẳng lên `service.ts`, bị bắt bởi catch-all
  chung và biến thành `errorCode: "unexpected_error"` — **một lỗi cấu hình
  thật, có thể chẩn đoán và sửa được, bị nuốt thành thông tin vô nghĩa.**
  Đây chính xác là lỗi mọi test case "gửi thành công"/"lỗi 1 phần" ở
  ZL2-ZL6 gặp phải — không phải chỉ do thiếu Zalo credentials thật như tài
  liệu các phase trước suy đoán.

**Đã sửa:** `getStoredConnection()` giờ bọc try/catch quanh 2 lần gọi
`decryptToken()`, trả về `{status: "decrypt_failed"}` thay vì throw.
`getValidZaloAccessToken()`/`performLockedRefresh()` xử lý status này như
1 lỗi có cấu trúc (`errorCode: "decrypt_failed"`), ghi vào
`last_refresh_error_*` để health status (mục 41) thấy ngay, và **không**
fallback âm thầm sang `ZALO_ACCESS_TOKEN` thủ công (vì đó sẽ che mất tình
trạng "cần kết nối lại" thật).

**Cách khắc phục cho môi trường thật:** bấm "Kết nối Zalo" lại trên
`/settings/notifications` để OAuth lại từ đầu — lần lưu token mới sẽ dùng
đúng `ZALO_TOKEN_ENCRYPTION_KEY` hiện tại. Đã đưa vào mục 47 (production
checklist).

### 43.2. Race condition khi nhiều request refresh cùng lúc

2 lớp bảo vệ, cộng dồn:

1. **In-process promise memo** (`inFlightRefresh` — biến module-level): nếu
   cùng 1 tiến trình Node (cùng 1 lần "ấm" của 1 Vercel function) có 2 lời
   gọi `refreshZaloAccessToken()` gần như đồng thời, lời gọi thứ 2 dùng lại
   promise của lời gọi thứ nhất thay vì tự gọi Zalo lần nữa.
2. **DB-level lock** (`zalo_connections.refresh_lock_at`, migration 00033):
   `claimRefreshLock()` là 1 câu `UPDATE ... WHERE refresh_lock_at IS NULL
   OR refresh_lock_at < now() - 30s` — atomic ở tầng Postgres, đúng bất kể
   có bao nhiêu server instance cùng gửi câu lệnh này. Thua cuộc đua
   (`claimRefreshLock` trả `false`) → `waitForOtherRefresh()` poll tối đa
   4s (250ms/lần) rồi đọc lại token thay vì tự refresh lần 2 — tránh việc 2
   request cùng dùng 1 `refresh_token` (nếu Zalo rotate refresh_token, bên
   thua sẽ bị lỗi "refresh_token đã dùng rồi" một cách không cần thiết).
   Lock cũ hơn 30s được coi là kẹt (tiến trình giữ lock trước đó có thể đã
   crash) và được phép chiếm lại — không deadlock vĩnh viễn.

**Lưu ý quan trọng:** các hàm lock (`claimRefreshLock`/`releaseRefreshLock`/
`recordRefreshFailure`) **không lọc theo `oa_id`** — cùng quy ước với mọi
lần đọc khác trong file này (`getStoredConnection`/`getZaloConnectionStatus`
đều dùng `.maybeSingle()` không WHERE), vì bảng này được thiết kế cho đúng
1 OA. Bản đầu tiên của code này CÓ lọc theo
`getZaloAppConfig().oaId`, và đó là 1 bug thật phát hiện lúc verify: giá trị
`ZALO_OA_ID` cấu hình trong `.env.local` không khớp `oa_id` thật đang lưu
trong bảng (row được tạo lúc `ZALO_OA_ID` là 1 giá trị khác) → mọi lần
`UPDATE ... WHERE oa_id = $configured` khớp 0 dòng, lock/ghi lỗi thất bại
âm thầm. Bỏ điều kiện lọc oa_id khỏi các hàm này đã sửa dứt điểm.

### 43.3. Refresh token rotation

`refreshZaloToken()` (`oauth.ts`) đã đọc đúng `refresh_token` mới nếu Zalo
trả về (`parsed.refresh_token ?? null`); `token.ts` giữ nguyên
`refresh_token` cũ nếu response không có cái mới
(`result.refreshToken ?? connection.refreshToken`) — đúng cho cả 2 khả
năng "Zalo rotate mỗi lần" và "Zalo chỉ cấp refresh_token 1 lần duy nhất".
Không có gì cần sửa ở phần này (đã đúng từ ZL1).

## 44. Notification log UI

`/settings/notifications` → "Lịch sử gửi gần đây" giờ có:

- Cột đầy đủ: Thời gian / Event / Người nhận / Trạng thái / Nội dung /
  Error code / Error message.
- 4 filter (`LogFilters`, URL-driven — `?logDate=&logEvent=&logRecipient=&logStatus=`):
  ngày (giờ VN, xem `vnDateToUtcRange` trong `logs.ts`), event, người nhận,
  trạng thái. "Xóa lọc" reset về mặc định.
- Nút **"Gửi lại"** chỉ hiện ở dòng `status = failed`, gọi thẳng
  `retryFailedNotification()` (đã có từ ZL2, ZL7 chỉ thêm nút UI) qua
  server action `retryNotificationLog`.
- Giới hạn 50 dòng gần nhất (tăng từ 20 ở ZL2) — vẫn "không cần full
  reporting" theo đúng phạm vi ZL2 gốc, filter giúp thu hẹp mà không cần
  phân trang.

## 45. Admin tests

- **Test 1 recipient**: menu "..." ở mỗi dòng người nhận → "Gửi thử" — gọi
  lại đúng route `POST /api/notifications/test-all` (ZL2) với body
  `{recipientId}`, dùng `sendNotification()`'s `recipientIds` filter mới
  (không có service/route riêng — tái dùng 100%). Log dưới event type
  `TEST_SINGLE_RECIPIENT` (phân biệt với `TEST_ALL_RECIPIENTS`).
- **Test all recipients**: không đổi (ZL2).
- **Test daily receipt/payment summary**: không đổi (ZL3/ZL5).
- **Low-stock alert preview**: card mới "Xem trước cảnh báo hàng còn phải
  về" — `previewLowStockAlerts()` (`src/lib/notifications/outstanding-alert-preview.ts`)
  đọc `v_outstanding` (status `low`/`need_makeup` hiện tại) và format đúng
  message thật sự sẽ gửi (dùng chung `formatOutstandingAlertMessage` với
  ZL4), nhưng **chỉ đọc** — không ghi `notification_event_states`, không
  gọi `sendNotification()`. Đúng yêu cầu "không cần fake thay đổi database
  nếu nguy hiểm".

## 46. Troubleshooting (mở rộng)

Ngoài mục 10 (OAuth/gửi tin cơ bản):

| Triệu chứng | Nguyên nhân khả dĩ | Cách xử lý |
|---|---|---|
| Token badge "Refresh failed", lỗi nhắc `ZALO_TOKEN_ENCRYPTION_KEY` | Biến môi trường đổi sau khi đã lưu token, hoặc token bị hỏng | Bấm "Kết nối Zalo" lại (mục 43.1) |
| `errorCode: "unexpected_error"` xuất hiện thường xuyên trong log | Trước ZL7: có thể là decrypt lỗi bị nuốt (mục 43.1) — đã sửa. Nếu vẫn thấy: kiểm tra log server (`[notify] ...`) để tìm exception cụ thể | Xem log server, không chỉ log DB |
| 2 job cron gần như trùng giờ mà 1 job báo lỗi refresh_token lạ | Race condition token refresh — đã có lock (mục 43.2), nhưng nếu vẫn thấy, kiểm tra `zalo_connections.refresh_lock_at` có bị kẹt (>30s) không | Lock tự hết hạn sau 30s, không cần can thiệp tay |
| Danh sách người nhận log rỗng dù đã gửi | Filter đang áp dụng | Bấm "Xóa lọc" |
| Nút "Gửi lại" không hiện | Log đang không ở trạng thái `failed`, hoặc role không phải admin | Kiểm tra trạng thái log / vai trò tài khoản ở `/users` |

## 47. Production checklist

Trước khi coi module thông báo Zalo là sẵn sàng chạy production lâu dài:

- [ ] **Kết nối lại Zalo OA thật** trên `/settings/notifications` (bấm
      "Kết nối Zalo") — mọi kết nối trong môi trường dev hiện tại dùng
      `ZALO_APP_SECRET`/`ZALO_TOKEN_ENCRYPTION_KEY` giả, không gửi được tin
      thật (mục 43.1).
- [ ] Xác nhận `ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_OA_ID` trên Vercel
      là giá trị thật, không phải placeholder.
- [ ] `ZALO_TOKEN_ENCRYPTION_KEY` trên Vercel: đặt 1 lần, **không đổi sau
      khi đã kết nối** (đổi key sau khi có token đã lưu = phải kết nối lại,
      mục 43.1).
- [ ] `CRON_SECRET` đã set trên Vercel (mục 35), khác với giá trị test cục
      bộ trong `.env.local`.
- [ ] Xác nhận `vercel.json`'s 2 cron job đã lên lịch đúng (Vercel dashboard
      → Cron Jobs) sau lần deploy đầu tiên.
- [ ] Danh sách `notification_recipients` chỉ chứa Zalo UID thật, đã
      follow OA (mục 8 — cách lấy recipient UID).
- [ ] Bấm thử "Gửi thử cho tất cả" (ZL2) + "Gửi thử" cho từng người (ZL7,
      mục 45) sau khi kết nối thật — xác nhận nhận được tin thật trên điện
      thoại, không chỉ xem log `status: sent`.
- [ ] Theo dõi `/settings/notifications`'s health status định kỳ (token
      hết hạn sau ~90 ngày kể từ lần refresh gần nhất theo tài liệu chung
      của Zalo OA — cần xác nhận số ngày chính xác với tài liệu Zalo hiện
      hành, chưa verify được trong phase này).
- [ ] Đã đọc + đồng ý với giới hạn "không backfill nếu cron miss cả ngày"
      (mục 39).

## 48. Final test — end-to-end (A-H theo spec)

| # | Kịch bản | Cách verify | Kết quả |
|---|---|---|---|
| A | Receipt summary | Playwright thật qua `/receipts/new` + `/receipts/[id]/edit` (ZL3/ZL4 test trước đó) + route `/api/notifications/daily-receipt-summary` | Đã verify (ZL3, tái xác nhận) |
| B | Low-stock alert | 2 lượt Playwright thật qua `/receipts/new`/`edit` (ZL4) + preview mới (mục 45) trên dữ liệu thật hiện có | Đã verify (ZL4 + preview mới) |
| C | Payment summary | Route thật `/api/notifications/daily-payment-summary` với payment test thật "hôm nay" (ZL5) | Đã verify (ZL5, tái xác nhận) |
| D | Multiple recipients | Mọi lần gửi đều fan-out đúng số người nhận active hiện tại (2-3 người thật) — verify lại ở ZL7 qua cả route lẫn UI | Đã verify |
| E | Token refresh | 2 lock claim đồng thời ở tầng DB (chỉ 1 thắng), stale lock tự giải phóng, 3 request đồng thời qua route thật không crash | Đã verify (mục 43.2) |
| F | Duplicate cron | Gọi cron 2 lần liên tiếp cho cùng ngày — dedupe theo `dedupeKey` (đã verify kỹ ở ZL6) | Đã verify (ZL6, không lặp lại) |
| G | Provider error | Refresh thật thất bại (do decrypt_failed thật trong môi trường này) → ghi đúng `last_refresh_error_*`, health status phản ánh đúng ngay | Đã verify (mục 43.1) |
| H | Retry | Seed 1 log `failed` thật, bấm "Gửi lại" qua UI thật, xác nhận log được cập nhật (thử lại thật, không phải no-op) | Đã verify (mục 44) |

Tổng cộng phase này verify bằng: 1 script race-condition ở tầng DB + route
thật (7 assertion), 1 script Playwright UI cho health status/preview/test-1-
recipient/filter/retry (11 assertion ban đầu + 1 assertion sửa lại chính
xác hơn sau khi phát hiện assertion đầu tiên tự nó sai, không phải sản
phẩm sai — xem chi tiết ở chỗ implementation). Toàn bộ dữ liệu test
(notification_logs seed, zalo_connections state tạm thời) đã được khôi
phục/xoá sạch sau khi xong.

## 49. Giới hạn còn lại của Phase ZL7

- **Chưa gửi được tin Zalo thành công thật trong toàn bộ 7 phase** — giờ
  biết chính xác lý do tại môi trường này: (1) không có `ZALO_APP_SECRET`
  thật, VÀ (2) token đang lưu không giải mã được bằng key hiện tại. Cả 2
  đều cần hành động thật từ người dùng (mục 47), không phải giới hạn của
  code.
- Chưa verify được thời hạn thật của access/refresh token theo tài liệu
  Zalo hiện hành (bao nhiêu ngày, refresh_token có hết hạn riêng không) —
  `EXPIRY_SAFETY_BUFFER_SECONDS`/logic refresh đã đúng nguyên lý chung
  (refresh trước khi hết hạn, không phụ thuộc số ngày cụ thể) nên không
  cần con số chính xác để hoạt động đúng, nhưng nên xác nhận nếu có thể.
  Đưa vào mục 47.
- Lock DB-level (`refresh_lock_at`) chỉ bảo vệ **refresh token**, không mở
  rộng ra bảo vệ toàn bộ luồng gửi tin (không cần thiết — gửi tin đã tuần
  tự theo thiết kế từ ZL2, xem mục 5 phần RATE LIMIT của spec này).
- `categorizeZaloError`'s bảng mã số Zalo (mục 42) vẫn là best-effort,
  giống hệt giới hạn đã nêu từ ZL1 cho các URL endpoint — chỉ ảnh hưởng
  hiển thị, không ảnh hưởng logic.
