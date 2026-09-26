# Xác thực & phân quyền

Migrations: `00036_auth_rbac.sql`, `00037_new_user_profile_inactive.sql`.

- **Authentication** (bạn là ai): Supabase Auth, email + mật khẩu.
- **Authorization** (bạn được làm gì): `public.profiles.role` + `is_active`, luôn đọc từ DB ở server.
- Frontend chỉ phục vụ UX (ẩn menu/nút). Lớp bảo mật thật là **server** (proxy + page + action + route) và **database** (RLS + privileges).

## 1. Kiến trúc

```
Browser ──► src/proxy.ts (mọi request)
              • làm mới session cookie (Supabase SSR)
              • chưa đăng nhập → /login?next=… (API: 401 JSON)
              • tài khoản bị khóa → /account-disabled (API: 403 JSON)
          ──► Page / Server Action / Route Handler
              • src/lib/auth/session.ts: requirePermission / authorizeAction / authorizeRoute
              • role + is_active đọc từ profiles (server), KHÔNG từ client
          ──► Supabase (service-role client, chỉ sau khi đã authorize)
```

Proxy **không** phải lớp duy nhất: layout của App Router không render lại khi chuyển trang, và Server Action là endpoint POST công khai — nên mọi page/action/route đều tự authorize lại.

### Supabase clients

| File | Key | Dùng ở |
|---|---|---|
| `src/lib/supabase/client.ts` | anon | Browser (hiện chưa dùng) |
| `src/lib/supabase/server.ts` | anon + cookie phiên | Server: đăng nhập/đăng xuất, `auth.getUser()` |
| `src/lib/supabase/admin.ts` | **service role** | Server-only (`import "server-only"` → build lỗi nếu lọt vào client). Mọi đọc/ghi nghiệp vụ, **sau** khi authorize. |

Chỉ `NEXT_PUBLIC_SUPABASE_URL` và `NEXT_PUBLIC_SUPABASE_ANON_KEY` được phép ra browser. `SUPABASE_SERVICE_ROLE_KEY` không bao giờ có tiền tố `NEXT_PUBLIC_`. `NEXT_PUBLIC_MOCK_ROLE` đã bị bỏ — xóa khỏi `.env.local` và Vercel.

### Auth helpers (`src/lib/auth/session.ts`)

| Helper | Dùng ở | Hành vi |
|---|---|---|
| `getAuthContext()` | mọi nơi | `unauthenticated` / `inactive` / `active` (+ user, profile). Cache theo request (React `cache`). |
| `getCurrentUser()`, `getCurrentProfile()`, `isAdmin()` | tiện ích | |
| `requireActiveUser()` | page | chưa login → `/login`; bị khóa → `/account-disabled` |
| `requirePermission(p)`, `requireRole(...r)` | page | như trên + thiếu quyền → `/forbidden` (403, không loop) |
| `authorizeAction(p?)` | server action | trả `{ok:false, status:401/403, message}` để form hiển thị |
| `authorizeRoute(p?)` | route handler | trả sẵn `Response` 401/403 JSON |

Thông báo chuẩn: 401 "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." · tài khoản khóa "Tài khoản đã bị vô hiệu hóa." · 403 "Bạn không có quyền thực hiện thao tác này." Không trả stack trace/lỗi DB thô.

## 2. Vai trò & ma trận quyền

Nguồn duy nhất: `src/lib/auth/permissions.ts` (`PERMISSIONS`, `hasPermission`). `src/lib/auth/role.ts` chỉ là các hàm bọc có tên (`canCreateReceipts`…).

| Quyền | admin | staff | viewer |
|---|:-:|:-:|:-:|
| `dashboard:view`, `receipt:view`, `invoice:view`, `outstanding:view`, `debt:view`, `payment:view`, `product:view`, `supplier:view` | ✓ | ✓ | ✓ |
| `receipt:create`, `receipt:edit` | ✓ | ✓ | |
| `invoice:create` (gồm tạo HĐ từ hàng đã nhận), `invoice:edit` | ✓ | ✓ | |
| `payment:create` | ✓ | ✓ | |
| `product:manage`, `supplier:manage` | ✓ | | |
| `user:manage` (/users: tạo user, đổi vai trò, khóa/mở) | ✓ | | |
| `notification:manage` (/settings/notifications, recipients, retry, gửi thử/báo cáo) | ✓ | | |
| `integration:manage` (Zalo OA connect / test message) | ✓ | | |

## 3. Bảo vệ route

- Công khai: `/login`, `/` (trang HTML có meta xác minh Zalo, tự chuyển về /dashboard), `/api/cron/*` (kiểm tra `CRON_SECRET`), `/api/health`.
- Chỉ cần đăng nhập (kể cả khi bị khóa): `/account-disabled`.
- Mọi route khác đều cần user **đang hoạt động**; từng page gọi `requirePermission(...)`:
  - xem: dashboard, receipts (+ chi tiết, daily), invoices (+ chi tiết), outstanding, debts, payments, products, suppliers
  - `/receipts/new`, `/receipts/[id]/edit`, `/invoices/new`, `/invoices/[id]/edit`: cần quyền xem; người không có quyền tạo/sửa thấy thông báo "chỉ có quyền xem"
  - `/users`: `user:manage` · `/settings/notifications`: `notification:manage`
- Server Action (request có header `next-action`) không bị proxy redirect — action tự trả lỗi 401/403.
- `/login` khi đã đăng nhập → `/dashboard`. `?next=` chỉ nhận đường dẫn nội bộ (`safeNextPath`), chống open-redirect.

### Server actions đã bảo vệ

receipts `createReceipt`/`updateReceipt` · invoices `createInvoice`/`updateInvoice` · `getReceiptInvoicePreview`/`createInvoiceFromReceiptDays` · `createPayment` · products create/update/active · suppliers create/update/active · notification recipients create/update/active/delete · `retryNotificationLog` · users `createUser`/`updateUserRole`/`setUserActive` · `getSupplierProducts` (đọc — Server Action là endpoint công khai nên cũng phải authorize).

(Dự án hiện không có chức năng xóa phiếu nhập, xóa hóa đơn hay Excel export.)

### API routes

| Route | Quyền |
|---|---|
| `/api/zalo/oauth/start`, `/api/zalo/oauth/callback`, `/api/zalo/test-message` | `integration:manage` (admin) |
| `/api/notifications/test-all`, `/daily-receipt-summary`, `/daily-payment-summary` | `notification:manage` (admin) |
| `/api/cron/*` | `Authorization: Bearer $CRON_SECRET` (không dùng phiên user) |
| `/api/health` | công khai |

## 4. Database (RLS + privileges)

Mọi đọc/ghi của app chạy ở server bằng service role sau khi authorize. Vì vậy DB được **khóa với truy cập trực tiếp** bằng anon key + JWT user (PostgREST):

- `anon`: không có quyền trên bảng/view nào.
- `authenticated`: **chỉ SELECT**, lọc bởi RLS. Không có INSERT/UPDATE/DELETE privilege hay policy trên bất kỳ bảng `public` nào; RPC nghiệp vụ chỉ `service_role` được gọi.
- Policies:
  - bảng nghiệp vụ (suppliers, products, receipts, receipt_items, invoices, invoice_items, invoice_receipt_days, payments, payment_items): đọc khi `public.is_active_user()`.
  - notification_recipients / notification_logs / notification_event_states: đọc khi `has_any_role(['admin'])`.
  - profiles: đọc dòng của chính mình, hoặc tất cả nếu là admin. **Không có policy UPDATE** → không ai tự đổi `role`/`is_active` của mình.
  - zalo_connections, receipt_no_counters: không có policy (chỉ service role).
- 8 view `v_*` đặt `security_invoker = true` (trước đây chạy bằng quyền owner nên bỏ qua RLS và `anon` đọc được).
- Helper SECURITY DEFINER: `current_active_role()`, `is_active_user()`, `has_any_role(text[])`.

## 5. Tài khoản bị khóa

`profiles.is_active = false`:
- Đăng nhập: báo "Tài khoản đã bị vô hiệu hóa.", không giữ phiên.
- Đang có phiên: request **kế tiếp** bị chặn (proxy đọc `is_active` mỗi request) → `/account-disabled` (có nút Đăng xuất); API → 403; server action → lỗi; JWT của họ không đọc được dữ liệu nào qua RLS.

## 6. Quy tắc an toàn admin

Không được để hệ thống mất admin đang hoạt động: hạ vai trò, khóa, hoặc xóa admin hoạt động cuối cùng đều bị từ chối — "Phải có ít nhất một tài khoản admin đang hoạt động."
- Kiểm tra trước ở server action `/users` (thông báo thân thiện).
- Chặn thật bằng trigger `guard_last_active_admin` (SQLSTATE `AU001`) — áp dụng cho mọi đường ghi, kể cả xóa user trong Supabase dashboard; có advisory lock chống 2 admin hạ nhau cùng lúc.

## 7. Tạo tài khoản

Hệ thống nội bộ, **không có đăng ký công khai** trong app.
- Trigger `on_auth_user_created` tạo profile cho MỌI user mới: `role = viewer`, `is_active = false`, `full_name` từ metadata. Không bao giờ cấp admin mặc định.
- Admin tạo user ở `/users` → "Thêm người dùng" (email, họ tên, vai trò, mật khẩu tạm ≥ 8 ký tự). Server action tạo user (đã xác nhận email) rồi **kích hoạt** profile với vai trò đã chọn.
- User xuất hiện theo đường khác (signup công khai qua API nếu project còn bật, "Add user" trong Supabase dashboard) → **bị khóa** cho tới khi admin bấm "Kích hoạt" ở `/users`.
- **Khuyến nghị:** tắt "Allow new users to sign up" trong Supabase Dashboard → Authentication → Sign In / Providers (hiện đang bật). Dù bật, tài khoản tự đăng ký cũng không truy cập được gì.

### Tên đăng nhập (không cần email thật)

Form đăng nhập nhận email **hoặc** tên đăng nhập. Tên đăng nhập `abc` được lưu trong Supabase Auth dưới dạng email nội bộ `abc@theodoihangve.local` (`src/lib/auth/login-identifier.ts`); `/users` hiển thị gọn là `abc`. Tài khoản nội bộ không nhận được email (không dùng được "quên mật khẩu" qua email) — admin đặt lại mật khẩu bằng `npm run auth:create-admin` hoặc Supabase dashboard.

### Admin đầu tiên / khôi phục

```
npm run auth:create-admin -- --email you@example.com --password "MậtKhẩuMạnh" --name "Họ tên"
npm run auth:create-admin -- --username tendangnhap --password "MậtKhẩuMạnh"
```

Tạo (hoặc đặt lại mật khẩu + nâng quyền) một admin đang hoạt động, dùng service-role key trong `.env.local`. Mật khẩu không được in/log.

## 8. created_by

`receipts.created_by`, `invoices.created_by`, `payments.created_by` luôn là `user.id` lấy từ phiên ở server (`authorizeAction`), không bao giờ từ dữ liệu client.

## 9. Session

- `@supabase/ssr`: proxy gọi `auth.getUser()` (xác thực JWT với Auth server, tự refresh và ghi cookie mới). Không tự parse JWT.
- Server Components đọc user qua `getAuthContext()` (cache theo request).
- Đăng xuất: `supabase.auth.signOut()` (thu hồi refresh token, xóa cookie) + `revalidatePath("/", "layout")` + chuyển `/login`. Response của route bảo vệ có `Cache-Control: private, no-store`.
- Không dùng localStorage/client state làm nguồn auth.

## 10. Biến môi trường

| Biến | Phạm vi |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only |
| `CRON_SECRET` | server-only (cron) |
| ~~`NEXT_PUBLIC_MOCK_ROLE`~~ | đã bỏ |

## 11. Kiểm thử

- `src/lib/auth/permissions.test.ts` — ma trận quyền, `safeNextPath`.
- `src/lib/auth/auth.integration.test.ts` — RLS/privileges/trigger trên DB thật bằng JWT user thật (viewer đọc được nhưng không ghi được, inactive không thấy gì, anon không đọc được view, không tự đổi role/kích hoạt, v.v.). Hai case admin chỉ chạy khi đã có admin thật.
