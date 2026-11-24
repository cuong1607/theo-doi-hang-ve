# Phase 02 — Zalo Personal → Supabase (ingestion)

> Đọc kèm: [architecture-audit.md](architecture-audit.md) · [decisions.md](decisions.md) · worker: [services/zalo-personal-worker/README.md](../../services/zalo-personal-worker/README.md)
>
> Trạng thái: code + migration `00073` **mới chạy trên Supabase local**. Chưa áp lên production, chưa deploy. Mọi cờ đều mặc định **tắt**.

## 1. Kiến trúc ingestion

```
Zalo (tài khoản cá nhân)
   │ zca-js listener (worker, Windows)
   ▼
normalize → lọc nhóm (allowlist cục bộ) → dedupe → serializer (bỏ text 1-1 nếu chế độ metadata)
   ▼
OUTBOX cục bộ: mỗi event một file, ghi nguyên tử, mã hóa AES-256-GCM
   (khóa outbox được bảo vệ bằng DPAPI); giới hạn số event + dung lượng
   ▼  delivery loop: tối đa 1 request đang gửi, batch ≤ 25, backoff + jitter, dead-letter
HTTPS POST /api/internal/zalo-personal/events     (+ /heartbeat mỗi 60 giây và mỗi lần đổi trạng thái)
   headers: x-zp-worker, x-zp-timestamp, x-zp-nonce, x-zp-signature = HMAC-SHA256
   ▼
Next.js route (public trong proxy, tự xác thực) → src/lib/zalo-personal/ingest.ts
   cờ → kích thước → header → cửa sổ thời gian → tìm worker → HMAC (constant-time)
   → trạng thái worker / connection → nonce + rate limit (DB) → zod → connection binding
   ▼
RPC zp_ingest_events (PostgreSQL): idempotency theo event_key → chính sách nhóm / 1-1
   → conversations / messages (unique theo account + hội thoại + message id) → sync_state
```

Nguyên tắc:
- **Hai lớp kiểm quyền nhóm.** Worker chỉ gửi nhóm nằm trong `ZP_ALLOWED_GROUP_IDS`. Server **tự kiểm tra lại**: nhóm phải có `mode ≠ disabled` **và** đã ghi nhận đồng ý; ràng buộc này nằm ở CHECK của database.
- **Worker không giữ khóa Supabase nào.** Worker chỉ có HMAC secret của chính nó. Service role chỉ dùng trong route của server.
- **Không trộn kênh.** Kênh này có bảng `zalo_personal_*` riêng. `ai_conversations` / `ai_messages` (OA + Web) **không đổi**, kể cả CHECK `channel`; test có kiểm tra điều này.
- **"Lưu một lần" về mặt logic.** Vận chuyển là at-least-once. Nếu server đã lưu nhưng worker chết trước khi xóa file outbox, lần gửi lại nhận `duplicate` và lúc đó mới xóa.

Khác với kế hoạch ban đầu: trong [decisions.md](decisions.md) §5, tin 1-1 dự kiến dùng `ai_conversations`. Phase 02 lưu **cả 1-1 lẫn nhóm** vào `zalo_personal_*`, vì:
- `ai_messages` thiếu người gửi, mention và giờ gửi;
- `ai_messages` gắn với luồng của trợ lý OA/Web (`recentTurns`, `processing_status`);
- muốn dùng `ai_messages` thì phải sửa bảng dùng chung với OA/Web.

Sau này, khi trợ lý AI trả lời trên kênh personal, thread của trợ lý có thể tạo ở `ai_conversations` với `channel` mới, và tham chiếu tới dữ liệu ở đây.

## 2. Database schema (`supabase/migrations/00073_zalo_personal_ingestion.sql`)

| Bảng | Vai trò | Ràng buộc chính |
|---|---|---|
| `zalo_personal_connections` | Một tài khoản Zalo cá nhân, **một chủ sở hữu** (`owner_user_id`), `zalo_account_id` gắn ở heartbeat đầu, `direct_message_mode` (`off` / `metadata` mặc định / `content`), heartbeat, lỗi gần nhất | `connection_key` unique; mỗi `zalo_account_id` chỉ thuộc **một** connection; không lưu cookie / token / mật khẩu |
| `zalo_personal_workers` | Danh tính worker, HMAC secret **mã hóa** (APP_ENCRYPTION_KEY, AAD = id worker), `active` / `revoked` | `worker_key` unique |
| `zalo_personal_request_nonces` | Chống replay + rate limit dùng chung cho mọi instance | PK (`worker_id`, `nonce`) |
| `zalo_personal_groups` | Nhóm đã thấy / đã phát hiện; `mode` (mặc định `disabled`), đồng ý (`consent_*`), `discovered_via`, `metadata` ≤ 2 KB | CHECK: `mode ≠ disabled` ⇒ `consent_status = granted`; `granted` ⇒ có người và thời điểm ghi nhận; `interactive` ⇒ `send_verified_at` (phase này không ai đặt được) |
| `zalo_personal_conversations` | Thread 1-1 (`user`) hoặc nhóm (`group`), `channel = 'zalo_personal'` | unique (`connection_id`, `type`, `external_id`); FK nhóm theo khóa ghép (`group_id`, `connection_id`) |
| `zalo_personal_messages` | Tin đã lưu: người gửi, loại, `text_content` (NULL nếu chính sách không cho), `content_stored`, mention, `is_self`, `sent_at` (Zalo), `received_at` (worker), `ingested_at` (server), `processing_state` | **unique (`connection_id`, `conversation_id`, `external_message_id`)**; FK ghép tới hội thoại **cùng connection** |
| `zalo_personal_ingestion_events` | Idempotency + kết quả cho mỗi danh tính event (`event_key` = sha256), `delivery_count`. **Không lưu payload** | unique (`connection_id`, `event_key`) |
| `zalo_personal_sync_state` | Một dòng mỗi worker. Các tín hiệu tách riêng: heartbeat (worker online), `session_state`, `listener_state`, `last_message_received_at`, `last_delivery_ok_at`, `last_ingested_at`, `last_event_at`, độ sâu outbox / dead-letter | PK `worker_id` |

Hàm (chỉ `service_role` gọi được, `search_path = ''`):

| Hàm | Việc làm |
|---|---|
| `zp_register_request` | Kiểm tra nonce, rate limit, dọn nonce cũ (có giới hạn) |
| `zp_record_heartbeat` | Gắn connection với tài khoản Zalo **một lần**, từ chối tài khoản khác; cập nhật sync state |
| `zp_ingest_events` | Xử lý batch. Mỗi event trong subtransaction riêng, nên một event lỗi chỉ bị từ chối riêng lẻ, không kéo cả batch retry mãi |
| `zp_prune` | Dọn dữ liệu (thao tác vận hành, **không** lên lịch tự động). Xóa nonce quá 1 ngày, nhóm chưa từng được duyệt và không còn thấy sau N ngày (mặc định 30), ingestion event không gắn tin quá N ngày (mặc định 90). **Không bao giờ xóa tin đã lưu** |

Phân quyền: RLS bật trên mọi bảng; `REVOKE ALL` với `anon` / `authenticated`, **kể cả chủ sở hữu**, vì Phase 02 chưa có giao diện; chỉ `GRANT` cho `service_role`.

Ứng dụng là single-tenant (không có workspace). Ranh giới cô lập là `owner_user_id` của connection, và DB đảm bảo bằng khóa ghép: tin của connection A **không thể** trỏ vào hội thoại của connection B (có test).

## 3. API contract

### Xác thực (cả hai endpoint)

```
x-zp-worker:    <worker_key>                  ví dụ win-01
x-zp-timestamp: <unix ms>                     lệch quá ±300 giây → 401 timestamp_out_of_window
x-zp-nonce:     <32 hex>                      dùng lại → 409 nonce_reused
x-zp-signature: v1=<hex HMAC-SHA256(secret, canonical)>
canonical = "v1\nPOST\n<path>\n<worker_key>\n<timestamp>\n<nonce>\n<sha256 hex của raw body>"
```

- Secret có dạng `zps_` + base64url của 32 byte ngẫu nhiên.
- Chữ ký gắn với **path**, nên chữ ký của `/events` không dùng lại được cho `/heartbeat`.
- Retry hợp lệ = request **mới** (nonce mới), giữ nguyên `eventKey` của từng event.
- CORS **không** phải cơ chế xác thực; route không gửi header CORS nào.

### `POST /api/internal/zalo-personal/events`

```json
{ "v": 1, "connectionKey": "primary", "accountId": "<uid tài khoản>", "events": [ {
  "eventKey": "<64 hex>", "kind": "message|undo|reaction|group_event|group_discovery",
  "conversationType": "user|group", "conversationId": "<số>",
  "externalMessageId": "<id>|null", "senderId": "<số>|null", "messageType": "text|image|…|null",
  "text": "…|null", "textLength": 0, "mentions": [{ "uid": "…", "pos": 0, "len": 3, "kind": "user|all" }],
  "mentionsSelf": false, "isSelf": false, "subtype": null,
  "sentAt": "ISO|null", "receivedAt": "ISO" } ] }
```

Ràng buộc payload:
- Tối đa 25 event mỗi request; body tối đa 512 KiB.
- Zod strict: trường lạ → 400.
- ID phải là **chuỗi số**. Một số JS lớn đã mất độ chính xác thì bị từ chối ngay từ worker.

200 → `{ ok: true, results: [{ eventKey, status, reason }] }`:

| `status` | `reason` | Ý nghĩa |
|---|---|---|
| `stored` | `null` / `message_already_stored` | Đã lưu (hoặc tin này đã có sẵn) |
| `recorded` | `group_registered` / `null` | Tín hiệu metadata, hoặc nhóm được ghi nhận ở trạng thái disabled |
| `duplicate` | outcome trước đó | Event này đã nhận rồi |
| `ignored` | `not_mentioned` / `not_a_group` | Bỏ qua theo chính sách |
| `rejected` | `group_disabled` / `direct_disabled` / `invalid_event` | Từ chối. **Đây là kết quả cuối**: worker xóa event, không retry |

### `POST /api/internal/zalo-personal/heartbeat`

`{ v, connectionKey, accountId|null, workerVersion, workerStartedAt, sessionState, listenerState, lastMessageReceivedAt, lastDeliveryOkAt, outboxDepth, deadLetterCount, outboxFullDrops, lastErrorCategory }` → `{ ok: true, serverTime }`

### Mã lỗi

| HTTP | `error` | Worker phản ứng |
|---|---|---|
| 400 | `invalid_payload` (kèm `issues` chỉ là đường dẫn trường, không có giá trị) | Gửi lẻ từng event; event lỗi vào dead-letter |
| 401 | `unauthorized` (chung cho worker lạ và sai chữ ký), `timestamp_out_of_window` | **Dừng gửi** cho tới khi khởi động lại |
| 403 | `worker_revoked`, `connection_disabled`, `connection_mismatch` | **Dừng gửi** |
| 409 | `nonce_reused` | Gửi lại ngay bằng request mới |
| 409 | `account_not_bound` | Chờ heartbeat rồi thử lại |
| 409 | `account_mismatch`, `account_in_use` | **Dừng gửi** |
| 413 | `payload_too_large` | Gửi lẻ từng event / dead-letter |
| 429 | `rate_limited` (kèm `Retry-After`) | Backoff ≥ Retry-After |
| 500 / 503 | `server_error`, `not_enabled` | Backoff + jitter; quá số lần thì dead-letter |

## 4. Cấu hình worker trên Windows

Cấu hình phía server, do quản trị viên chạy:

```powershell
npm run zalo-personal:admin -- connection:create --key primary --owner <email>
npm run zalo-personal:admin -- worker:create --connection primary --worker win-01
# secret in ra MỘT lần
```

Cấu hình worker:

```powershell
cd services\zalo-personal-worker
npm run ingest:set-secret      # dán secret; được lưu bằng DPAPI, KHÔNG ghi vào .env
notepad .env
#   ZP_CONNECTION_ID=primary   (phải trùng connection_key ở server)
#   ZP_INGEST_ENABLED=true
#   ZP_INGEST_URL=https://<backend>   (http chỉ cho localhost)
#   ZP_WORKER_KEY=win-01
npm run ingest:status          # secret: present, outbox…
npm run dev
```

Duyệt nhóm phía server (bắt buộc ghi nhận đồng ý):

```powershell
npm run zalo-personal:admin -- group:set --connection primary --group <id> --mode monitor --consent-by <email> --note "…"
```

Lệnh vận hành outbox:

| Lệnh | Việc làm |
|---|---|
| `npm run ingest:status` | Trạng thái secret, outbox, lần gửi gần nhất |
| `npm run outbox:retry-dead` | Đưa các mục dead-letter về hàng chờ |
| `npm run outbox:clear -- --yes` | Xóa toàn bộ outbox |
| `npm run ingest:clear-secret` | Xóa secret cục bộ |

## 5. Tạo secret an toàn

- **Worker secret:** chỉ tạo bằng `zalo-personal:admin worker:create`. Secret được sinh bằng `crypto.randomBytes(32)`, in **một lần** rồi lưu mã hóa trong DB. Mất secret thì **thu hồi** worker cũ (`worker:revoke`) và tạo worker mới; không có lệnh "xem lại secret".
- **`APP_ENCRYPTION_KEY`:** khóa đã có sẵn cho Shopee, đúng 32 byte base64 (`openssl rand -base64 32`). **Đổi khóa thì mọi secret worker hiện có không giải mã được nữa** (cũng như token Shopee).
- **Không** gửi secret qua chat hay email, không commit. Trên Windows dùng `ingest:set-secret` (DPAPI). Trên VPS dùng `ZP_INGEST_SECRET` qua secret store hoặc systemd credential.
- Khóa outbox (`outbox.key`) do worker tự tạo và bảo vệ bằng DPAPI. Đổi tài khoản Windows thì outbox cũ không đọc được: chạy `outbox:clear -- --yes`.

## 6. Chạy migration trên Supabase local

Cần Docker Desktop. Cổng của repo là dải 553xx (`supabase/config.toml`).

```powershell
npx supabase@3.3.0 start          # lần đầu tải image; tự áp 00001…00073
npx supabase@3.3.0 db reset       # chỉ DB LOCAL: xóa và áp lại toàn bộ migration
npx supabase@3.3.0 status -o env  # URL + key local cho file env test
npx supabase@3.3.0 stop
```

Tạo một file env **riêng cho local**, ví dụ `.env.test.local` (đã được gitignore), gồm:
- `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`: lấy từ lệnh `status`
- `APP_ENCRYPTION_KEY`
- `ZALO_PERSONAL_INGEST_ENABLED=true`

**Đừng** sửa `.env.local` hiện tại, vì file đó trỏ tới cloud. Script quản trị và integration test đều **từ chối** URL không phải localhost.

Test:

```powershell
node --env-file=.env.test.local --test src/lib/zalo-personal/zalo-personal.test.ts
node --env-file=.env.test.local --test --test-concurrency=1 src/lib/zalo-personal/zalo-personal.integration.test.ts src/lib/zalo-personal/worker-e2e.integration.test.ts
cd services\zalo-personal-worker; npm test
```

## 7. Test bằng mock event (không cần Zalo)

```powershell
# 1) server local trỏ vào DB local
#    (Next 16 không cho chạy 2 dev server cùng thư mục: dùng next dev nếu chưa có cái nào, hoặc next build + next start)
# 2) quản trị
node --env-file=.env.test.local scripts/zalo-personal/admin.ts connection:create --key http-test --owner <email>
node --env-file=.env.test.local scripts/zalo-personal/admin.ts worker:create --connection http-test --worker http-worker-01
# 3) gửi event có ký
$env:ZP_MOCK_URL="http://localhost:3000"; $env:ZP_WORKER_KEY="http-worker-01"; $env:ZP_INGEST_SECRET="zps_…"
$env:ZP_CONNECTION_KEY="http-test"; $env:ZP_ACCOUNT_ID="1000000000000000777"
node scripts/zalo-personal/send-mock-event.ts heartbeat
node scripts/zalo-personal/send-mock-event.ts message --group 2547837462290891500 --text "xin chào"
node scripts/zalo-personal/send-mock-event.ts replay          # lần 2 phải 409
node scripts/zalo-personal/send-mock-event.ts bad-signature   # 401
node scripts/zalo-personal/send-mock-event.ts oversized       # 413
```

Kết quả đã chạy thật trên máy phát triển ngày 2026-11-24, ghi ở mục "Kết quả kiểm chứng" bên dưới.

## 8. Kiểm tra message đã lưu

```powershell
npm run zalo-personal:admin -- status --connection primary                 # connection, worker, sync state, nhóm, số tin, outcome
npm run zalo-personal:admin -- messages:recent --connection primary --limit 10   # metadata
npm run zalo-personal:admin -- messages:recent --connection primary --show-text  # kèm nội dung (chỉ trên máy của bạn)
```

Hoặc dùng Supabase Studio local (http://127.0.0.1:55323), bảng `zalo_personal_*`.

## 9. Xử lý lỗi đồng bộ

| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
|---|---|---|
| `delivery_paused_auth` (401) | Sai secret / worker key, hoặc đồng hồ máy lệch quá 5 phút | Đồng bộ giờ Windows, `ingest:set-secret` lại, khởi động lại worker |
| 403 `worker_revoked` | Worker đã bị thu hồi | Tạo worker mới, nạp secret mới |
| 403 `connection_mismatch` | `ZP_CONNECTION_ID` khác `connection_key` ở server | Sửa `.env` |
| 409 `account_mismatch` | Đăng nhập một tài khoản Zalo khác vào connection đã gắn | Dùng đúng tài khoản; nếu thật sự đổi thì tạo connection mới (không gắn lại âm thầm) |
| `outbox.depth` tăng mãi | Backend không truy cập được hoặc ingest đang tắt (503) | `ingest:status`; kiểm tra URL / mạng / `ZALO_PERSONAL_INGEST_ENABLED` |
| `dead > 0` | Event bị từ chối vĩnh viễn hoặc quá số lần thử | Xem `lastError` trong file dead (không chứa nội dung); sửa nguyên nhân rồi `outbox:retry-dead` |
| `outboxFullDrops > 0` | Outbox đầy (mặc định 5000 event / 20 MB) | Khắc phục backend; event mới trong lúc đầy **bị mất** (có đếm) |
| `rejected: group_disabled` | Nhóm chưa được duyệt ở server | `group:set … --mode monitor --consent-by …` |

## 10. Chính sách dữ liệu và quyền truy cập

- **Nhóm:** mặc định `disabled`. Chỉ lưu nội dung khi `mode` ∈ `monitor` / `mention_only` **và** đã ghi nhận đồng ý (ai, lúc nào, ghi chú). `mention_only` chỉ lưu tin có mention tài khoản này. `interactive` bị chặn trong phase này.
- **Nhóm được phát hiện:** chỉ lưu ID, thời điểm thấy lần đầu / gần nhất và cách phát hiện. Không có tên, thành viên hay nội dung. `zp_prune` xóa những nhóm không bao giờ được duyệt.
- **Tin 1-1:** mặc định chỉ lưu metadata, và text không rời khỏi worker. Muốn lưu nội dung phải bật **cả hai** phía: `ZP_DIRECT_MESSAGES=content` ở worker và `direct:set --mode content` ở server.
- **Không lưu:** tên hiển thị, avatar, payload gốc, cookie / phiên, lịch sử cũ (không backfill). `sync_state` không bao giờ khẳng định đã đồng bộ toàn bộ lịch sử: chỉ có tin nhận được kể từ khi worker chạy.
- **Ai đọc được:** chỉ code server dùng `service_role` (script quản trị, route). Người dùng đăng nhập, kể cả chủ sở hữu, và `anon` đều **không** đọc được qua API.
- **Log:** không chứa body, nội dung tin, chữ ký hay secret. Lỗi 400 chỉ trả về đường dẫn trường.

## 11. Rollback

| Mức | Cách làm | Mất dữ liệu? |
|---|---|---|
| 1. Tắt nhận | `ZALO_PERSONAL_INGEST_ENABLED=false` → hai endpoint trả 503 | Không. Worker giữ event trong outbox và retry; cuối cùng thành dead-letter nếu tắt lâu |
| 2. Tắt gửi | Worker: `ZP_INGEST_ENABLED=false`, hoặc `npm run stop` | Không |
| 3. Thu hồi | `zalo-personal:admin worker:revoke --worker …` | Không |
| 4. Gỡ code | `git revert` các commit Phase 02. Zalo OA và Web không bị sửa nên không cần rollback gì ở đó | Không |
| 5. Gỡ schema (**chỉ khi chủ dự án duyệt, sau khi backup**) | Chạy SQL dưới đây trên DB đích | **Có**: toàn bộ dữ liệu Zalo Personal |

```sql
-- KHÔNG tự động chạy. Backup trước: pg_dump --table='public.zalo_personal_*' …
BEGIN;
DROP FUNCTION IF EXISTS public.zp_prune(integer, integer);
DROP FUNCTION IF EXISTS public.zp_ingest_events(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.zp_record_heartbeat(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.zp_register_request(uuid, text, text, integer, integer);
ALTER TABLE IF EXISTS public.zalo_personal_ingestion_events DROP CONSTRAINT IF EXISTS zalo_personal_ingestion_events_message_fk;
DROP TABLE IF EXISTS public.zalo_personal_messages;
DROP TABLE IF EXISTS public.zalo_personal_ingestion_events;
DROP TABLE IF EXISTS public.zalo_personal_conversations;
DROP TABLE IF EXISTS public.zalo_personal_groups;
DROP TABLE IF EXISTS public.zalo_personal_sync_state;
DROP TABLE IF EXISTS public.zalo_personal_request_nonces;
DROP TABLE IF EXISTS public.zalo_personal_workers;
DROP TABLE IF EXISTS public.zalo_personal_connections;
COMMIT;
-- rồi xóa dòng 00073 khỏi supabase_migrations.schema_migrations nếu muốn áp lại sau
```

Migration `00073` chỉ **thêm**: không sửa hay xóa bảng, policy, hàm có sẵn, nên không có gì cũ cần khôi phục.

## Kết quả kiểm chứng (2026-11-24, máy phát triển Windows, Supabase local)

| Hạng mục | Kết quả |
|---|---|
| Migration `00001…00073` trên DB trống (`db reset`) | sạch |
| Unit server (`zalo-personal.test.ts`) | 21/21 |
| Integration DB + API (`zalo-personal.integration.test.ts`) | 27/27 |
| E2E module worker thật → handler → DB (`worker-e2e.integration.test.ts`) | 5/5 |
| Worker (`npm test`) | 136/136 |
| Route HTTP thật (`next start` + `send-mock-event.ts`) | heartbeat 200; nhóm chưa duyệt → rejected; duyệt thiếu đồng ý → script từ chối; có đồng ý → stored; gửi lại → duplicate; 1-1 → chỉ metadata; sai chữ ký 401; quá cỡ 413; nonce lặp 409; không header 401; không có header CORS |
| **Tài khoản Zalo thật → worker → backend local** | heartbeat gắn tài khoản; 1 tin nhóm **stored có nội dung**; 1 tin 1-1 **stored chỉ metadata**; outbox về 0; không retry, không dead-letter; heartbeat cuối khi dừng báo `listener_state = inactive` |

Chưa kiểm chứng với dữ liệu thật: tin **do người khác gửi**, mất mạng thật khi worker đang chạy, outbox đầy, một ngày chạy liên tục, độ trễ khi gọi Vercel từ Việt Nam, và Supabase cloud.
