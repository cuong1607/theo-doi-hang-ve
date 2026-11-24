# Phase 03 — Zalo Personal Dashboard

> Đọc kèm [phase-02-integration.md](phase-02-integration.md) (ingestion, bảng `zalo_personal_*`, migration `00073`) và [decisions.md](decisions.md).
> Phạm vi: **đọc + quản trị có kiểm soát**. Không AI, không Gemini, không gửi tin, không đổi Zalo OA hay Web Conversation.

## 1. Tổng quan

Khu vực mới **Trợ lý Zalo AI → Zalo cá nhân** nằm trong app shell hiện có. Đây là một app trong hub (`src/lib/apps/registry.ts`, id `zalo`), có sidebar riêng (`src/lib/apps/nav.ts`). Không có frontend riêng.

Cờ `ZALO_PERSONAL_DASHBOARD_ENABLED` (mặc định `false`, xem `.env.example`):

| Cờ | Hành vi |
|---|---|
| tắt | App ẩn khỏi hub và switcher. Trang trả 404, API trả `404 not_enabled`. **Không truy vấn bảng `zalo_personal_*` nào**, nên có thể deploy code trước khi áp migration |
| bật | Hiện app cho user có role được phép **và** có dữ liệu: sở hữu một kết nối, hoặc được chủ kết nối cấp quyền |

Kiến trúc từng lớp:

```
Trang (Server Component)  ─┐
                           ├─ requireZaloPersonal() / authorizeZaloApi()   server.ts   (cờ, phiên, role)
API route (/api/zalo-personal/…) ┘
        │
        ▼
service.ts   — tính phạm vi (access.ts), kiểm quyền theo dữ liệu, dựng view model (che ID, không secret)
        │
        ▼
supabase-store.ts — service_role, chỉ server; gọi hàm SQL có phạm vi (00074)
        │
        ▼
Postgres — RLS bật, anon / authenticated không có quyền gì; hàm SQL kiểm lại điều DB chứng minh được
```

Component client (`src/components/zalo-personal/*`) chỉ nhận view model và gọi API qua `fetch`. `service_role` không bao giờ tới trình duyệt (có static guard trong test).

## 2. Routes

### Trang

| Route | Nội dung | Yêu cầu tối thiểu |
|---|---|---|
| `/apps/zalo/personal` | Tổng quan: số kết nối, trạng thái tệ nhất, số nhóm đã phát hiện / được phép theo dõi, số hội thoại, tin hôm nay (giờ VN), heartbeat cuối, tin cuối, số lỗi đồng bộ chưa xử lý (dead-letter) | có kết nối hoặc grant |
| `/apps/zalo/personal/connections` | Thẻ kết nối: tên hiển thị, ID tài khoản đã che, worker, trạng thái session / listener / backend, heartbeat, lần ingest thành công cuối, nhóm lỗi cuối, hướng dẫn xử lý. Chủ sở hữu thấy thêm: quản lý quyền truy cập và audit log | `sync` |
| `/apps/zalo/personal/groups` | Danh sách nhóm: tên (hoặc `Nhóm ••1234`), ID rút gọn, kết nối, chế độ, đồng ý, số tin, tin cuối, lần thấy cuối. Thao tác đổi chế độ / ghi nhận đồng ý / rút đồng ý | `read` (đổi: `manage`) |
| `/apps/zalo/personal/conversations` | Hội thoại nhóm + 1-1, lọc theo kết nối / loại / nhóm, tìm theo tên, phân trang server | `read` hoặc grant hội thoại |
| `/apps/zalo/personal/conversations/[conversationId]` | Lịch sử tin: người gửi (ID che), nội dung (text thuần), giờ VN, loại tin, mention, tin của chính mình, trạng thái lưu. Nút "Tải thêm" theo cursor | như trên |
| `/apps/zalo/personal/search` | Tìm theo nội dung / hội thoại / người gửi / khoảng ngày / loại tin | như trên |
| `/apps/zalo/personal/sync` | Trạng thái worker, lịch sử trạng thái (chỉ lúc đổi), kết quả ingest 24h theo outcome / lý do, retry phía server, outbox / dead-letter / số event bị bỏ vì outbox đầy, event cuối | `sync` |

Trang có `loading.tsx` (skeleton) và `error.tsx` (thông báo chung, không lộ lỗi gốc) ở `src/app/(authenticated)/(zalo)/`.

### API (`src/app/api/zalo-personal/`)

Mọi response có `Cache-Control: no-store`, không có header CORS. Thành công trả `{ success: true, data }`. Lỗi trả `{ success: false, error, errorMessage[, issues] }`.

| Method | Path | Input (zod, `contracts.ts`) | Ghi chú |
|---|---|---|---|
| GET | `/overview` | — | số liệu tổng quan |
| GET | `/connections` | — | danh sách kết nối trong phạm vi |
| GET | `/connections/[connectionId]/sync` | `page` 1–1000, `size` ≤ 100 | trạng thái + lịch sử + tổng hợp ingest |
| GET | `/connections/[connectionId]/audit` | — | chỉ chủ sở hữu hoặc `manage` |
| GET | `/connections/[connectionId]/access` | — | chỉ chủ sở hữu |
| POST | `/connections/[connectionId]/access` | `{ granteeUserId, scope, conversationId?, level, note? }` | cấp / đổi quyền (+ audit) |
| DELETE | `/connections/[connectionId]/access/[grantId]` | — | thu hồi (+ audit), có hiệu lực ngay lần gọi kế tiếp |
| GET | `/groups` | `connectionId?`, `mode?`, `page`, `size` ≤ 100 | |
| PATCH | `/groups/[groupId]` | `{ action: "set_mode", mode }` \| `{ action: "grant_consent", note, confirm: true }` \| `{ action: "withdraw_consent", note? }` | + audit, cùng transaction |
| GET | `/conversations` | `connectionId?`, `type?`, `groupId?`, `name?` ≤ 100, `page`, `size` ≤ 100 | |
| GET | `/conversations/[conversationId]/messages` | `beforeAt` + `beforeId` (cả hai hoặc không), `limit` ≤ 100 (mặc định 30) | keyset pagination, mới nhất trước |
| POST | `/messages/search` | body `{ text? 2–200, conversationId?, senderId?, messageType?, from, to, limit ≤ 100 }` | text nằm trong **body**, không ở query string; GET trả 405; khoảng ≤ 92 ngày |

| HTTP | `error` | Khi nào |
|---|---|---|
| 400 | `invalid_input` | sai schema, sai uuid. `issues` chỉ có đường dẫn trường + thông điệp, không lặp lại giá trị |
| 401 | `unauthenticated` | không có phiên |
| 403 | `forbidden` | role không được dùng module, hoặc có thấy đối tượng nhưng không đủ mức quyền |
| 404 | `not_found` / `not_enabled` | đối tượng không tồn tại **hoặc ngoài phạm vi** (không phân biệt, chống dò ID) / cờ tắt |
| 409 | `consent_required`, `interactive_not_available`, `grantee_is_owner` | DB từ chối thay đổi |
| 500 | `server_error` | lỗi bất ngờ. Log chỉ ghi tên op + tên lỗi |

## 3. Phân quyền

Hai điều kiện, kiểm ở server cho **mọi** trang và API:

1. **Role**: `zalo_personal:use` (admin, staff; viewer không bao giờ có). Đây chỉ là điều kiện cần.
2. **Dữ liệu**: người đọc là chủ kết nối (`zalo_personal_connections.owner_user_id`) hoặc có grant đang hiệu lực trong `zalo_personal_access_grants`.

| Vai trò | Thấy gì |
|---|---|
| **Chủ kết nối** (Owner) | Toàn bộ kết nối của mình: sức khỏe, nhóm, hội thoại nhóm **và 1-1**, nhật ký đồng bộ, audit, quản lý grant, đổi chế độ nhóm |
| grant `connection / sync` | Thẻ kết nối + nhật ký đồng bộ. Không nhóm, không tin |
| grant `connection / read` | + nhóm và hội thoại / tin **nhóm** |
| grant `connection / manage` | + đổi chế độ nhóm, ghi nhận / rút đồng ý, xem audit |
| grant `conversation / read` | Đúng một hội thoại (nhóm hoặc 1-1) |
| **Admin** không có grant | **Không thấy gì** của kết nối người khác. App bị ẩn nếu admin không có kết nối riêng |
| Staff không có grant | Như trên |
| Viewer / chưa đăng nhập | 403 / 401; menu ẩn |

Quy tắc bổ sung:

- Grant cấp cho cả kết nối **không bao giờ** gồm tin 1-1. Muốn chia sẻ một chat 1-1, chủ sở hữu phải cấp grant cho đúng hội thoại đó.
- Chỉ chủ sở hữu cấp / thu hồi grant. Role của người được cấp đọc từ `profiles`, không lấy từ client. DB từ chối grant cho chính chủ sở hữu, cho profile bị khóa, hoặc cho hội thoại thuộc kết nối khác (FK hỗn hợp `(conversation_id, connection_id)`).
- Kết nối bị tắt chỉ chủ sở hữu thấy.
- Actor (user id + role) luôn lấy từ phiên server (`src/lib/auth/session.ts`). Hàm SQL nhận `p_actor` mà server đã xác thực.
- RLS: ba bảng mới bật RLS, `REVOKE ALL` với `anon` / `authenticated`, mọi hàm `REVOKE EXECUTE` khỏi `PUBLIC`. Có test bằng anon key và JWT user thật.

## 4. Chế độ nhóm

| Chế độ | Ý nghĩa | Phase 03 |
|---|---|---|
| `disabled` | Mặc định cho nhóm mới; chỉ lưu ID / thời điểm thấy | luôn tắt được, bất cứ lúc nào |
| `monitor` | Lưu mọi tin | cần **đồng ý đã ghi nhận** (ghi chú 3–500 ký tự + xác nhận) |
| `mention_only` | Chỉ lưu tin mention tài khoản | cần đồng ý |
| `interactive` | Dự kiến: bot trả lời trong nhóm | **bị từ chối** (`interactive_not_available`), kể cả với chủ sở hữu: chưa có đường gửi đã xác minh (`send_verified_at`). UI chỉ hiển thị là "phase sau" |

Kiểm ở ba lớp: zod (`updateGroupBody`) → service (mức `manage`, nhóm thuộc kết nối trong phạm vi) → hàm `zp_update_group` (khóa dòng, đồng ý, `send_verified_at`, CHECK của 00073). Rút đồng ý đặt `consent_status='withdrawn'` **và** `mode='disabled'` trong một câu lệnh. Từ tin tiếp theo, ingestion của Phase 02 trả `group_disabled`.

Mọi thay đổi ghi `zalo_personal_audit_log` trong cùng transaction: `group.mode_changed`, `group.consent_granted`, `group.consent_withdrawn`, `access.granted`, `access.revoked`. Bảng audit append-only: trigger `zp_audit_log_no_update` chặn mọi UPDATE (trừ `ON DELETE SET NULL` của `actor_user_id`). Code không có đường xóa, và FK `ON DELETE RESTRICT` chặn xóa kết nối còn audit. Lệnh DELETE trực tiếp bằng service_role **không** bị trigger chặn.

## 5. Trạng thái worker

Hàm thuần `classifyWorker` (`status.ts`) đánh giá **từng tín hiệu riêng**. Backend còn sống không có nghĩa là Zalo đang hoạt động: chỉ heartbeat gần đây mới chứng minh worker còn chạy.

| Health | Situation | Điều kiện |
|---|---|---|
| `connected` | `ok` | heartbeat ≤ 3 phút, session `authenticated`, listener `active`, không dead-letter, outbox không tồn đọng |
| `degraded` | `listener_not_active` / `listener_error` | đã đăng nhập, listener đang kết nối lại / lỗi |
| `degraded` | `backend_not_receiving` | listener chạy nhưng lỗi gửi (`backend_unreachable`, `rate_limited`, `auth_failed`, `account_not_bound`), có dead-letter, hoặc outbox tồn đọng > 5 phút |
| `auth_required` | `not_logged_in` / `session_expired` / `account_mismatch` | worker online nhưng chưa đăng nhập / phiên bị từ chối / đăng nhập nhầm tài khoản |
| `unknown` | `never_seen` / `heartbeat_stale` | chưa từng có heartbeat / heartbeat 3–15 phút |
| `disconnected` | `worker_offline` / `worker_stopped` | > 15 phút không heartbeat / heartbeat cuối báo listener `inactive` (dừng chủ động) |
| `disabled` | `connection_disabled` / `worker_revoked` | tắt ở server |

Mỗi situation có câu giải thích tiếng Việt và hướng dẫn thao tác **trên máy Windows** (`SITUATION_TEXT`). Không bao giờ hiển thị lỗi gốc hay stack trace.

Lịch sử trạng thái: trigger `zp_log_status_change` trên `zalo_personal_sync_state` ghi `zalo_personal_status_events` **chỉ khi trạng thái đổi** (lần đầu thấy, đổi session / listener / lỗi, hoặc heartbeat sau khoảng trống > 5 phút), không ghi mỗi heartbeat. Chính trigger này xóa dòng cũ hơn 30 ngày của worker.

**Không có nút "ngắt kết nối" / QR trên dashboard.** Phase 01/02 chưa có command channel an toàn từ server tới worker, và chưa có giao thức truyền QR. Dashboard chỉ hiển thị trạng thái và lệnh cần chạy trên máy Windows (`npm run login`, `npm run stop`…). Có test xác nhận trang không render nút giả.

## 6. Dữ liệu hiển thị và an toàn nội dung

- Nội dung tin render như **text React thuần**: không dùng `dangerouslySetInnerHTML`, không markdown, không tự tạo link. URL và attachment không được tải hay preview tự động. Có static guard và test XSS qua HTTP thật.
- ID tài khoản / nhóm / người gửi đều che (`••1234`). Phase 02 không lưu tên hiển thị, nên tên nhóm chỉ có khi metadata có.
- View model không bao giờ chứa `secret_encrypted`, session, cookie hay ID tài khoản đầy đủ (có test trên cả mock lẫn DB thật).
- Tin 1-1 chỉ có metadata, trừ khi Phase 02 đã bật lưu nội dung ở cả hai phía. UI ghi rõ "Không lưu nội dung".
- Loại tin chưa hỗ trợ (sticker, ảnh, file…) hiển thị nhãn loại, không có nội dung.
- Giờ hiển thị theo `Asia/Ho_Chi_Minh`. Dashboard **không** khẳng định có lịch sử trước khi worker bắt đầu nhận tin.
- Tìm kiếm: phạm vi được tính **trước** khi query, ký tự `% _ \` được escape, khoảng ngày ≤ 92, tối đa 100 kết quả (có cờ `truncated`), không có tìm kiếm vector / AI.

## 7. Migration `00074_zalo_personal_dashboard.sql`

Chỉ **thêm**, không sửa bảng / hàm / constraint nào của 00073, Zalo OA hay `ai_*`.

| Đối tượng | Mục đích |
|---|---|
| `zalo_personal_access_grants` | grant (scope, level, ai cấp / thu hồi). Unique: một grant hiệu lực cho mỗi người + đối tượng |
| `zalo_personal_audit_log` | audit append-only |
| `zalo_personal_status_events` | lịch sử trạng thái worker (trigger) |
| `zp_update_group`, `zp_grant_access`, `zp_revoke_access` | thay đổi + audit trong một transaction |
| `zp_dashboard_conversations`, `zp_dashboard_messages`, `zp_dashboard_search`, `zp_dashboard_counts` | đọc theo phạm vi (`p_full` / `p_group` / `p_ids`); không trả gì ngoài phạm vi |
| `zp_conversation_summaries`, `zp_ingestion_summary` | số liệu tổng hợp |
| 2 index đọc | `messages(connection_id, ingested_at)`, `conversations(connection_id, last_message_at)` |

Sau `db push`: `NOTIFY pgrst, 'reload schema'`.

## 8. Kiểm thử

### Tự động

| File | Loại | Cần |
|---|---|---|
| `src/lib/zalo-personal/dashboard/dashboard.test.ts` | unit (store giả lập) + static guard | không cần DB |
| `src/lib/zalo-personal/dashboard/dashboard.integration.test.ts` | DB thật: phạm vi, IDOR, grant, CHECK chế độ, audit append-only, keyset, LIKE escape, trigger trạng thái, RLS anon / authenticated | Supabase **local** (`supabase start`) |
| `src/lib/apps/apps.test.ts`, `src/lib/auth/permissions.test.ts` | hub / nav / ma trận quyền (quyền cũ không đổi) | không |
| `scripts/zalo-personal/dashboard-smoke.ts` | HTTP thật qua `next start`: cookie phiên thật, proxy, trang + API | app chạy với Supabase local và cờ bật |

Hai file dashboard đã có trong `npm test`.

```bash
npm test                                       # cần .env.local trỏ Supabase local
# smoke HTTP (KHÔNG dùng env production; script từ chối URL Supabase không phải localhost)
ZALO_PERSONAL_DASHBOARD_ENABLED=true npx next build && npx next start -p 3125
node --env-file=<env local> scripts/zalo-personal/dashboard-smoke.ts http://localhost:3125
```

Đối chiếu 17 yêu cầu test của đề bài:

| # | Yêu cầu | Ở đâu |
|---|---|---|
| 1 | không có kết nối | unit "no connection and no grant"; smoke hub (staff) |
| 2 | worker online / offline | unit "worker health", "connections" |
| 3 | heartbeat cũ | unit "stale heartbeat" |
| 4 | danh sách nhóm | unit + integration "scope on real rows" |
| 5 | chuyển chế độ | unit "owner switches modes"; integration "mode change + audit"; smoke PATCH |
| 6 | từ chối nhóm chưa đồng ý | unit + integration "monitor without consent" |
| 7 | lịch sử tin | integration "history: keyset pages"; smoke history page |
| 8 | phân trang | unit "bounded pages with a cursor"; integration keyset |
| 9 | tìm kiếm | unit "search"; integration "escaped LIKE"; smoke POST search |
| 10 | user thiếu quyền | unit "viewer role"; smoke 401 / 403 / `/forbidden` |
| 11 | staff ngoài phạm vi | unit "staff outside its grant"; integration IDOR; smoke IDOR |
| 12 | admin không xem dữ liệu Owner | unit "admin WITHOUT a grant"; integration "staff / admin without grant" |
| 13 | validate input | unit "API input validation"; smoke 400 |
| 14 | HTML / script không chạy | unit "untrusted HTML" + static guard; integration; smoke XSS |
| 15 | không lộ secret | unit + integration "view models never carry…"; smoke "no secret in any response" |
| 16 | hồi quy OA | `src/lib/zalo/*.test.ts` (không sửa) |
| 17 | hồi quy Web Conversation | `conversation.test.ts`, `conversation.integration.test.ts`, `product-analyst*.test.ts` (không sửa) |

### Thủ công (môi trường test)

1. Áp 00073 + 00074 lên Supabase local, bật `ZALO_PERSONAL_DASHBOARD_ENABLED=true`.
2. Tạo kết nối + worker bằng `npm run zalo-personal:admin`, chạy worker hoặc `scripts/zalo-personal/send-mock-event.ts`.
3. Đăng nhập bằng user sở hữu: kiểm tra Tổng quan → Kết nối → Nhóm (ghi nhận đồng ý → `monitor` → tắt) → Hội thoại → Tìm → Nhật ký.
4. Đăng nhập bằng staff khác: app ẩn. Chủ sở hữu cấp `read` → staff thấy nhóm, không thấy 1-1. Thu hồi → mất quyền ngay.
5. Tắt worker: sau 3 phút trạng thái là "Không rõ", sau 15 phút là "Mất kết nối".

Screenshots: chưa chụp (môi trường phát triển không có trình duyệt tự động cho phiên này).

## 9. Chưa hỗ trợ

- Đăng nhập QR, ngắt kết nối, khởi động lại worker từ dashboard (cần command channel an toàn, phase sau).
- Chế độ `interactive` và mọi việc gửi tin.
- Tên hiển thị người gửi / thành viên nhóm (Phase 02 không lưu).
- Xem trước ảnh / file / link.
- Lịch sử trước khi worker bắt đầu nhận tin; backfill.
- Tìm kiếm full-text có xếp hạng, vector, AI tóm tắt, phát hiện task.
- Workspace / đa tenant (`workspaces`, `ai_channel_access` chưa có). Ranh giới cô lập là `owner_user_id` + grant.
- Đánh dấu dead-letter "đã xử lý" từ dashboard (vẫn dùng `npm run outbox:retry-dead` trên worker).

## 10. Rollback

| Mức | Cách làm | Mất dữ liệu? |
|---|---|---|
| 1. Ẩn dashboard | `ZALO_PERSONAL_DASHBOARD_ENABLED=false` rồi redeploy. App ẩn, trang 404, API 404, không query bảng nào | Không |
| 2. Thu hồi quyền | Chủ sở hữu thu hồi grant trên trang Kết nối (hoặc `UPDATE … SET revoked_at = now()`) | Không |
| 3. Gỡ code | `git revert` commit Phase 03. Ingestion Phase 02, Zalo OA, Web không bị ảnh hưởng | Không |
| 4. Gỡ schema 00074 (**chỉ khi chủ dự án duyệt, sau khi backup**) | SQL dưới đây. 00073 giữ nguyên | **Có**: grant, audit, lịch sử trạng thái |

```sql
-- KHÔNG tự động chạy. Backup trước:
--   pg_dump --table=public.zalo_personal_access_grants --table=public.zalo_personal_audit_log --table=public.zalo_personal_status_events …
BEGIN;
DROP TRIGGER IF EXISTS zp_sync_state_history ON public.zalo_personal_sync_state;
DROP FUNCTION IF EXISTS public.zp_dashboard_counts(uuid[], uuid[], uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.zp_dashboard_search(uuid[], uuid[], uuid[], text, uuid, text, text, timestamptz, timestamptz, integer);
DROP FUNCTION IF EXISTS public.zp_dashboard_messages(uuid, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.zp_dashboard_conversations(uuid[], uuid[], uuid[], uuid, text, uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.zp_ingestion_summary(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.zp_conversation_summaries(uuid[]);
DROP FUNCTION IF EXISTS public.zp_revoke_access(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.zp_grant_access(uuid, uuid, uuid, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.zp_update_group(uuid, uuid, uuid, text, text, text);
DROP TABLE IF EXISTS public.zalo_personal_status_events;
DROP TABLE IF EXISTS public.zalo_personal_audit_log;   -- trigger zp_audit_log_no_update đi theo bảng
DROP TABLE IF EXISTS public.zalo_personal_access_grants;
DROP FUNCTION IF EXISTS public.zp_log_status_change();
DROP FUNCTION IF EXISTS public.zp_audit_log_guard();
DROP INDEX IF EXISTS public.idx_zalo_personal_messages_connection_time;
DROP INDEX IF EXISTS public.idx_zalo_personal_conversations_connection_time;
COMMIT;
NOTIFY pgrst, 'reload schema';
-- rồi xóa dòng 00074 khỏi supabase_migrations.schema_migrations nếu muốn áp lại sau
```

Thứ tự: gỡ code / tắt cờ **trước**, rồi mới gỡ schema. Nếu gỡ schema khi cờ đang bật, dashboard lỗi 500, nhưng các app khác vẫn chạy vì `zaloAppVisible` nuốt lỗi và ẩn app.

## 11. Kết quả kiểm chứng (2026-11-24, máy phát triển Windows)

| Hạng mục | Kết quả |
|---|---|
| `tsc --noEmit` | sạch |
| `eslint .` | sạch |
| Unit dashboard + hồi quy (apps, permissions, role, Zalo OA, conversation, product-analyst, zalo-personal) | 155/156 đạt. Test hỏng duy nhất là `src/lib/zalo/crypto.test.ts`: `.env.local` của máy thiếu `ZALO_TOKEN_ENCRYPTION_KEY` (lỗi môi trường, có trước Phase 03). Chạy lại với khóa tạm: 5/5 |
| Integration dashboard trên Supabase local | đạt khi chạy trong phiên phát triển trước (Docker đang bật) |
| Smoke HTTP thật (`next start` + cờ bật) | mọi check đạt: hub ẩn / hiện đúng, các trang 200 cho chủ sở hữu, staff / viewer → `/forbidden` không lộ dữ liệu, API 401 / 403 / 400 / 404 / 405 / 409 đúng, IDOR bị chặn, XSS không xuất hiện trong HTML, không có nút ngắt kết nối giả, không secret trong response |
| Smoke HTTP với cờ tắt | app ẩn với cả chủ sở hữu, API `404 not_enabled`, các app khác bình thường |
| `next build` (env local, cờ bật) | đạt; 7 trang `/apps/zalo/personal/*` là dynamic (`ƒ`) |

Chưa kiểm chứng: dữ liệu từ tài khoản Zalo thật qua dashboard, Supabase cloud / Vercel, hiệu năng với lượng tin lớn, giao diện mobile trên thiết bị thật.
