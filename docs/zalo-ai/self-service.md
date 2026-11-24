# Zalo Personal — Tự thiết lập kết nối từ dashboard (migration `00076`)

> Đọc kèm [phase-02-integration.md](phase-02-integration.md) (worker, ký HMAC), [phase-03-dashboard.md](phase-03-dashboard.md) (phân quyền, audit log `00074`).
> Phạm vi: những gì trước đây operator làm bằng CLI `scripts/zalo-personal/admin.ts`, nay người dùng tự làm **cho kết nối của chính mình** trên web, với cùng quy tắc và có audit. Đăng nhập Zalo (QR) **vẫn diễn ra trên máy Windows**: QR và session không bao giờ đi qua dashboard.

## 1. Người dùng làm được gì

| Thao tác | Ai | Ghi chú |
|---|---|---|
| Tạo kết nối | Có quyền `zalo_personal:connect` (admin, staff) | Chủ sở hữu **luôn là người gọi**; client không chọn được `ownerUserId` (400) |
| Cấp worker | Chủ kết nối | Secret HMAC sinh và mã hoá trên server, trả về **một lần duy nhất** (`Cache-Control: no-store`) kèm các dòng env cho worker |
| Thu hồi worker | Chủ kết nối | Request của worker đó bị từ chối (403) ngay sau đó |
| Tạm dừng / bật lại | Chủ kết nối | Tạm dừng = server từ chối mọi event / heartbeat của kết nối. Dữ liệu đã lưu giữ nguyên |

Chế độ tin 1-1 khi tự tạo chỉ được `off` hoặc `metadata`. Lưu **nội dung** tin 1-1 vẫn là quyết định của operator (CLI), không bao giờ self-service.

Giới hạn chống lạm dụng (CLI không bị giới hạn):
- Tối đa **3 kết nối** mỗi người (kể cả đang tạm dừng).
- Tối đa **2 worker đang hoạt động** mỗi kết nối.

## 2. Hiển thị và điều hướng

- Thẻ "Trợ lý Zalo AI" ở `/apps` hiện cho người **có dữ liệu** (sở hữu kết nối / có grant) **hoặc** có quyền `zalo_personal:connect`. Viewer vẫn không thấy.
- Người có quyền connect nhưng chưa có dữ liệu: mọi trang Zalo Personal (kể cả `/apps/zalo/personal/ai`) chuyển về trang thiết lập `/apps/zalo/personal/connections` (chế độ onboarding, nút "Thêm kết nối Zalo"). Trang này không chứa dữ liệu của người khác.
- Không có quyền connect và không có dữ liệu → `/forbidden` như Phase 03.

Mã: `requireZaloPersonal({ setupPage })`, `zaloDataAccess`, `zaloAppVisible` trong `src/lib/zalo-personal/dashboard/server.ts`; UI ở `src/components/zalo-personal/connection-setup.tsx`.

## 3. API

| Method | Route | Body | Kết quả |
|---|---|---|---|
| POST | `/api/zalo-personal/connections` | `{ name?, directMode: "off" \| "metadata" }` | `{ id, key }`. Key = slug của tên (bỏ dấu) + hậu tố ngẫu nhiên, thử lại tối đa 3 lần nếu trùng |
| PATCH | `/api/zalo-personal/connections/{connectionId}` | `{ status: "active" \| "disabled" }` | `{ changed }` |
| POST | `/api/zalo-personal/connections/{connectionId}/workers` | — | `{ workerKey, connectionKey, secret, envLines }` (chỉ lần này) |
| DELETE | `/api/zalo-personal/connections/{connectionId}/workers/{workerId}` | — | `{ changed }` |

`envLines` gồm `ZP_CONNECTION_ID`, `ZP_WORKER_KEY`, `ZP_INGEST_URL`, `ZP_INGEST_ENABLED=true`. `ZP_INGEST_URL` lấy từ `APP_URL` (hoặc origin của request), chỉ chấp nhận `https` (hoặc `http` trên localhost).

Mã lỗi (ngoài 401 / 404 cờ tắt như Phase 03):

| HTTP | `code` | Khi nào |
|---|---|---|
| 400 | `invalid_input`, `invalid_key`, `invalid_direct_mode`, `invalid_status` | Sai input |
| 403 | `forbidden`, `actor_invalid` | Không có quyền connect / tài khoản không hoạt động |
| 404 | `not_found` | Kết nối không thuộc người gọi (không phân biệt với "không tồn tại") |
| 409 | `limit_reached`, `key_taken`, `connection_paused` | Hết giới hạn / trùng key / cấp worker khi đang tạm dừng |

## 4. An toàn

- **Sở hữu được kiểm hai lớp**: ứng dụng (`buildScope`) và lại trong hàm SQL (`owner_user_id = p_actor`, khoá `FOR UPDATE`). Người khác gọi vào kết nối không phải của mình nhận 404.
- **Secret**: sinh bằng `generateWorkerSecret`, mã hoá AES với `APP_ENCRYPTION_KEY`, AAD gắn với worker id (id được sinh **trước** khi mã hoá). DB chỉ lưu ciphertext `v1.…`. Secret không xuất hiện lại ở API danh sách hay trang HTML, không ghi log.
- **Audit**: mỗi thao tác ghi `zalo_personal_audit_log` với action `connection.created` / `connection.paused` / `connection.resumed` / `worker.issued` / `worker.revoked`.
- Hàm SQL chỉ cấp cho `service_role`; `anon` / `authenticated` không gọi được.

## 5. Migration `00076_zalo_personal_self_service.sql`

- Thêm 4 hàm: `zp_create_connection`, `zp_issue_worker`, `zp_revoke_worker`, `zp_set_connection_status` (advisory lock khi tạo kết nối để đếm giới hạn chính xác).
- **Nới** CHECK `action` / `target_type` của `zalo_personal_audit_log` (00074) để nhận giá trị mới; dòng cũ vẫn hợp lệ.
- Không đổi bảng / cột / hàm nào khác của 00073 / 00074 / 00075. Zalo OA và Web không bị ảnh hưởng.
- Quyền mới `zalo_personal:connect` (admin, staff) trong `src/lib/auth/permissions.ts`.

## 6. Triển khai

1. Áp `00076` lên production (**cần chủ dự án duyệt**) **sau** 00075, rồi `NOTIFY pgrst, 'reload schema'`.
2. Đảm bảo `APP_URL` trên Vercel là địa chỉ https công khai (dùng cho `ZP_INGEST_URL`).
3. Người dùng tạo kết nối → cấp worker → chép các dòng env vào `.env` của worker trên máy Windows → chạy worker và quét QR tại máy đó.

## 7. Rollback

| Mức | Cách làm | Mất dữ liệu? |
|---|---|---|
| 1. Ẩn dashboard | `ZALO_PERSONAL_DASHBOARD_ENABLED=false` | Không |
| 2. Gỡ code | `git revert` commit self-service. Kết nối / worker đã tạo vẫn chạy bình thường (giống tạo bằng CLI) | Không |
| 3. Gỡ schema 00076 (**chỉ khi chủ dự án duyệt**) | SQL dưới đây. Phải xoá hoặc đổi các dòng audit có action mới trước khi khôi phục CHECK cũ | Có: các dòng audit self-service |

```sql
-- KHÔNG tự động chạy. Backup zalo_personal_audit_log trước.
BEGIN;
DROP FUNCTION IF EXISTS public.zp_set_connection_status(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.zp_revoke_worker(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.zp_issue_worker(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.zp_create_connection(uuid, text, text);
DELETE FROM public.zalo_personal_audit_log
  WHERE action IN ('connection.created', 'connection.paused', 'connection.resumed', 'worker.issued', 'worker.revoked');
ALTER TABLE public.zalo_personal_audit_log DROP CONSTRAINT IF EXISTS zalo_personal_audit_log_action_check;
ALTER TABLE public.zalo_personal_audit_log ADD CONSTRAINT zalo_personal_audit_log_action_check CHECK (action IN (
  'group.mode_changed', 'group.consent_granted', 'group.consent_withdrawn', 'access.granted', 'access.revoked'));
ALTER TABLE public.zalo_personal_audit_log DROP CONSTRAINT IF EXISTS zalo_personal_audit_log_target_type_check;
ALTER TABLE public.zalo_personal_audit_log ADD CONSTRAINT zalo_personal_audit_log_target_type_check CHECK (target_type IN ('group', 'grant'));
DELETE FROM supabase_migrations.schema_migrations WHERE version = '00076';
COMMIT;
NOTIFY pgrst, 'reload schema';
```

Chưa diễn tập rollback 00076 trên DB local.

## 8. Kết quả kiểm chứng (2026-11-24, máy phát triển Windows, Supabase local đã có 00001 → 00076)

| Hạng mục | Kết quả |
|---|---|
| `tsc --noEmit` | sạch |
| `eslint` (code Zalo Personal, AI, auth, apps, scripts) | 0 lỗi; 1 warning biến không dùng trong script demo `_demo-seed.ts` |
| `next build` (env local, cờ dashboard bật) | đạt |
| Unit (`self-service.test.ts`, `dashboard.test.ts`, `ai.test.ts`, permissions, apps, zalo-personal) | 153/153 |
| Integration (`self-service`, `dashboard`, `ai`, `zalo-personal`, `worker-e2e`, auth) | 80/80 |
| Smoke HTTP `dashboard-smoke.ts` (có thêm bước self-service) | 41/41 |
| Smoke HTTP `ai-smoke.ts` | đạt toàn bộ |

**Chưa kiểm chứng**: `npx supabase db reset` sạch từ đầu với 00076 (DB local đã áp sẵn), diễn tập rollback 00076, toàn bộ `npm test`, môi trường production.
