# Zalo OA Integration — Phase ZL1 (OAuth foundation + test message)

Phase ZL1 chỉ làm: OAuth start/callback, token exchange, refresh foundation,
lưu token server-side, và gửi 1 tin nhắn test. Không có cron, không có
business-event notifications (daily receipt/low stock/payment) — những cái
đó là các phase sau.

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

1. Đăng nhập với vai trò admin (`NEXT_PUBLIC_MOCK_ROLE=admin` ở giai đoạn
   chưa có auth thật).
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
| `/api/zalo/oauth/start` trả 403 | Role hiện tại không phải admin | Đặt `NEXT_PUBLIC_MOCK_ROLE=admin` (tạm thời, chờ Phase 5 auth thật) |
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
