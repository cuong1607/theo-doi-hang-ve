# PHASE 00 — Audit kiến trúc: Zalo Personal (zca-js) + Gemini AI + AI Memory

> Dự án: CONGTRANGBEDDING (repo `theo-doi-hang-ve`) · Ngày audit: 2026-11-24 · Commit gốc: `b5c4135`
>
> Phạm vi phase này: **chỉ đọc và phân tích**. Không sửa code nghiệp vụ, không đụng Zalo OA,
> không chạy migration, không chạm database production. Tài liệu không chứa token, cookie hay API key.
>
> Ký hiệu: ✅ = đã xác minh trực tiếp từ mã nguồn trong repo · ⚠️ = suy luận / cần kiểm chứng ngoài repo.

> **Cập nhật 2026-11-24 — đã chốt 4 quyết định (D1–D4)** trong [decisions.md](decisions.md). Kế hoạch mới nằm ở [implementation-plan.md](implementation-plan.md).
> - Các mục A–D, G, H, J.1 của tài liệu này vẫn giữ nguyên giá trị.
> - **Các mục E.4 (tin nhóm), E.5 (schema), E.6 (flag nhóm), F (danh sách file) và I (checklist theo phase) đã được thay thế** bởi hai tài liệu trên. Khi hai bên khác nhau, theo `decisions.md` / `implementation-plan.md`.
> - Đánh số phase đã đổi: Phase 01–07 dưới đây ≠ P01–P10 của kế hoạch mới.

---

## A. Kiến trúc hiện tại

### A.1 Stack (✅ từ `package.json`, `tsconfig.json`, `supabase/config.toml`, `vercel.json`)

| Lớp | Thực tế |
|---|---|
| Framework | Next.js **16.3.5** (App Router, Turbopack), React 19.2.8. Middleware đổi tên thành `src/proxy.ts` (export `proxy`) |
| Ngôn ngữ | TypeScript 5, `allowImportingTsExtensions`; các file `lib` import nhau bằng đường dẫn tương đối có đuôi `.ts` |
| Chạy TS ngoài Next | `node --env-file=.env.local <file>.ts` (Node tự bỏ type), dùng cho `npm test` và `scripts/**` |
| DB / Auth | Supabase (Postgres 17 theo `config.toml`), `@supabase/ssr` + `@supabase/supabase-js` |
| AI hiện có | `@anthropic-ai/sdk` (Claude) trong `src/lib/product-analyst/` — **mặc định tắt** |
| Hosting | Vercel (serverless). Vercel Cron chỉ chạy **1 lần/ngày** (gói Hobby, ghi trong `00050`) → các việc chạy mỗi phút dùng **Supabase pg_cron + pg_net** |
| Validation | zod 4 |
| Test | `node --test` (unit + integration; integration ghi vào Supabase thật qua service role) |
| Chưa có | `zca-js`, `@google/genai`, pgvector, Redis/queue ngoài, thư mục worker, CI (`.github/`) |

### A.2 Bố cục mã nguồn (✅)

```
src/
  proxy.ts                 lớp chặn đầu tiên: refresh session, chặn anon, chặn tài khoản bị khóa, public paths
  app/
    (authenticated)/...    192 file trang/server action theo nhóm app (accounting, shopee, system...)
    api/                   19 route handler (zalo, notifications, cron, internal/shopee, shopee, health)
  lib/
    zalo/                  Zalo OA: OAuth, token, gửi tin, webhook (11 file + 5 test)
    notifications/         fan-out thông báo qua Zalo OA, dedupe, log, các báo cáo hằng ngày
    conversation/          dịch vụ hội thoại KHÔNG phụ thuộc kênh (zalo | web) + router + store Supabase
    product-analyst/       Claude orchestrator: provider interface, tools, guard, cache, usage log
    auth/                  ma trận quyền, session helpers
    security/secrets.ts    AES-256-GCM có version + AAD (dùng cho token Shopee)
    channels/              Shopee: sync jobs, worker, scheduler (165 file)
    cron/auth.ts           xác thực CRON_SECRET / internal secret
    supabase/              client trình duyệt, server (anon + cookie), admin (service role)
supabase/migrations/       00001 → 00072 (72 migration)
scripts/                   legacy import, e2e (playwright), shopee, ai pilot — chạy bằng node thuần
docs/                      tài liệu theo từng phase (zalo-integration.md, zalo-ai-agent-architecture.md, product-analyst-agent.md...)
```

### A.3 Mẫu kiến trúc đang được dùng xuyên suốt (✅)

1. **Thuần (pure) + tiêm phụ thuộc**: logic nằm ở module không có I/O, không import `@/`, nhận `store` / `sender` / `fetchImpl` qua tham số → test được bằng `node --test`. Phần nối dây (wiring) nằm riêng trong file `server.ts` có `import "server-only"`.
2. **Service role sau khi đã authorize ở app**: mọi đọc/ghi nghiệp vụ chạy phía server bằng `createAdminClient()` (bỏ qua RLS) **sau khi** gọi `requirePermission` / `authorizeAction` / `authorizeRoute`. RLS là lớp phòng thủ thứ hai cho truy cập trực tiếp bằng anon key.
3. **Feature flag mặc định TẮT**, đọc tập trung (`feature-flags.ts`, `product-analyst/config.ts`, `getZaloWebhookConfig`).
4. **Idempotency bằng unique index** (inbound message id, dedupe key notification, job active).
5. **Không log bí mật**: log JSON chỉ có metadata/mã lỗi.

---

## B. Cấu trúc module Zalo OA

### B.1 Hai luồng độc lập đang chạy trên cùng một OA

```
(1) THÔNG BÁO ĐI (outbound, đã chạy production theo ZL1–ZL7)

 Vercel Cron / nút admin / server action nghiệp vụ
        │
        ▼
 notifications/send-*.ts, outstanding-alert.ts      (dựng nội dung)
        │
        ▼
 notifications/service.ts  sendNotification()        (fan-out tuần tự, dedupe, log từng người nhận)
        │                      └── recipients.ts ← notification_recipients
        ▼
 zalo/messages.ts  sendZaloTextMessage()             (zod, tối đa 2000 ký tự)
        │   └── zalo/token.ts getValidZaloAccessToken() ← zalo_connections (mã hóa, refresh lock)
        ▼
 POST https://openapi.zalo.me/v3.0/oa/message/cs


(2) HỘI THOẠI ĐẾN (inbound, mặc định TẮT: ZALO_CONVERSATION_ENABLED=false)

 Zalo OA ── POST /api/zalo/webhook (public trong proxy, tự verify chữ ký, fail closed)
        │   zalo/webhook-handler.ts: flag → verify → parse user_send_text → đúng OA → rate limit
        ▼
 conversation/service.ts acceptIncomingMessage()     (upsert hội thoại, INSERT inbound, trùng → bỏ)
        │  trả 200 ngay
        ▼  after()
 processAcceptedMessage(): LINK <mã> → kiểm tra liên kết/role → router (không LLM)
        │  → công nợ NCC | phân quyền shop | product analyst (Claude, nếu bật)
        ▼
 OutboundSender.sendText()  =  conversation/server.ts zaloOutboundSender → sendZaloTextMessage()
```

### B.2 API route liên quan Zalo OA (✅)

| Route | Method | Bảo vệ | Việc làm |
|---|---|---|---|
| `/api/zalo/oauth/start` | GET | `authorizeRoute("integration:manage")` | tạo state + PKCE, set cookie httpOnly 10 phút, redirect sang Zalo |
| `/api/zalo/oauth/callback` | GET | `authorizeAction("integration:manage")` + so khớp state cookie | đổi code → token, `saveZaloTokens()` |
| `/api/zalo/test-message` | POST | `integration:manage` + rate limit trong process (3/phút) | gửi tin test tới `ZALO_TEST_RECIPIENT_ID` |
| `/api/zalo/webhook` | POST | public; `X-ZEvent-Signature` (fail closed); tắt mặc định | nhận `user_send_text` → hội thoại |
| `/api/notifications/test-all` | POST | `notification:manage` | `sendNotification()` tới tất cả / 1 người nhận |
| `/api/notifications/daily-receipt-summary` | POST | `notification:manage` | gửi tóm tắt hàng về |
| `/api/notifications/daily-payment-summary` | POST | `notification:manage` | gửi tóm tắt thanh toán |
| `/api/cron/daily-receipt-summary` | GET | `CRON_SECRET` | Vercel Cron `0 11 * * *` (18:00 VN) |
| `/api/cron/daily-payment-summary` | GET | `CRON_SECRET` | Vercel Cron `0 12 * * *` (19:00 VN) |
| `/api/cron/daily-supplier-debt-report` | GET | `CRON_SECRET` | Vercel Cron `0 1 * * *` (08:00 VN) |

Trang quản trị (✅): `/settings/notifications` (`notification:manage`: người nhận, log, retry, gửi test, trạng thái token) và `/settings/zalo-agent` (`integration:manage`: tạo mã liên kết, thu hồi, chọn shop cho trợ lý).

### B.3 Service / module (✅)

| File | Vai trò | `server-only`? |
|---|---|---|
| `zalo/env.ts` | đọc env Zalo có kiểm tra | không |
| `zalo/client.ts` | URL endpoint + `zaloFetch` timeout 10s | không |
| `zalo/crypto.ts` | AES-256-GCM, khóa = SHA-256(`ZALO_TOKEN_ENCRYPTION_KEY`), không AAD | không |
| `zalo/oauth.ts`, `pkce.ts` | URL ủy quyền, đổi/refresh token | không |
| `zalo/token.ts` | lưu/đọc/refresh token, khóa refresh liên instance, trạng thái sức khỏe | **có** |
| `zalo/messages.ts` | `sendZaloTextMessage()` — điểm gửi duy nhất | **có** |
| `zalo/error-category.ts` | phân loại lỗi cho UI | không |
| `zalo/rate-limit.ts` | rate limit trong process cho test-message | không |
| `zalo/webhook.ts`, `webhook-handler.ts` | verify chữ ký, parse, rate limit theo người gửi | không |
| `notifications/service.ts` | `sendNotification()`, `retryFailedNotification()` | **có** |
| `notifications/recipients.ts`, `logs.ts`, `dedupe.ts` | đọc bảng người nhận / log / kiểm tra trùng | không (nhưng import `@/lib/supabase/admin` vốn là server-only) |
| `conversation/service.ts`, `router.ts`, `web.ts` | logic hội thoại thuần | không |
| `conversation/supabase-store.ts` | `ConversationStore` trên Supabase (nhận client từ ngoài) | không |
| `conversation/server.ts` | nối dây: store + `zaloOutboundSender` + analyst + báo cáo công nợ | **có** |

---

## C. Database và phân quyền liên quan

### C.1 Bảng liên quan Zalo OA / hội thoại / AI (✅ từ migrations)

| Bảng | Migration | Nội dung chính | RLS / grant |
|---|---|---|---|
| `zalo_connections` | 00028, 00033 | 1 dòng/OA (`oa_id` UNIQUE), access/refresh token **mã hóa**, `expires_at`, `refresh_lock_at`, `last_refresh_*` | RLS bật, **0 policy** → chỉ service role |
| `notification_recipients` | 00029, 00036 | `name`, `zalo_uid` UNIQUE (UID theo OA), `is_active` | SELECT chỉ admin (`has_any_role(['admin'])`) |
| `notification_logs` | 00029, 00036 | log từng lần gửi; unique một phần `(event_type, recipient_id, dedupe_key) WHERE status='sent'` | SELECT chỉ admin |
| `notification_event_states` | 00031, 00036 | trạng thái hiện tại theo entity (cảnh báo tồn) | SELECT chỉ admin |
| `zalo_user_links` | 00069 | `zalo_user_id` UNIQUE (regex số) → `internal_user_id` (profiles), `active/revoked` | RLS bật, revoke anon/authenticated, grant service_role |
| `zalo_link_codes` | 00069 | mã liên kết 1 lần (chỉ lưu sha256), hết hạn 10 phút | như trên |
| `ai_user_shop_access` | 00069 | cấp quyền shop rõ ràng cho trợ lý (không có dòng = không có quyền) | như trên |
| `ai_conversations` | 00069, 00070, 00072 | 1 dòng/(channel, external_user_id); `context` jsonb nhẹ; `current_shop_id`, `current_product_id` → `shopee_products`; **CHECK channel IN ('zalo','web')**; CHECK `last_intent` | như trên |
| `ai_messages` | 00069, 00072 | inbound/outbound, text ≤ 4000, `processing_status`, `analysis` jsonb; **unique (channel, provider_message_id) cho inbound**; **CHECK channel IN ('zalo','web')** | như trên |
| `ai_usage_logs` | 00072 | 1 dòng/lần phân tích: provider, model, token, chi phí ước tính, tool trace; **CHECK channel IN ('zalo','web','script')** | như trên |
| `ai_analysis_cache` | 00072 | cache kết quả phân tích đã validate | như trên |
| `profiles` | 00001, 00036, 00037 | `role` ∈ admin/staff/viewer, `is_active`; user mới luôn là viewer **inactive** | SELECT: chính mình hoặc admin; không UPDATE policy |

Hạ tầng tái dùng được (✅): `channel_sync_jobs` + `claim_next_sync_job()` dùng `FOR UPDATE SKIP LOCKED` (00045, 00063), `channel_sync_heartbeats` (00050), pg_cron + pg_net + Supabase Vault cho secret (00050).

### C.2 Cơ chế phân quyền (✅)

**Tầng ứng dụng** (nguồn chân lý):
- `src/lib/auth/permissions.ts`: ma trận quyền thuần. Liên quan Zalo: `integration:manage` (admin), `notification:manage` (admin), `app:system` (admin).
- `src/lib/auth/session.ts`: `getAuthContext()` = `auth.getUser()` (xác thực lại JWT) + đọc `profiles` bằng service role; `requirePermission` (trang), `authorizeAction` (server action), `authorizeRoute` (route handler).
- `src/proxy.ts`: chặn anon và tài khoản bị khóa trên mọi request. Public: `/`, `/login`, `/api/zalo/webhook`, `/api/cron/*`, `/api/internal/*`, `/api/health`.
- Trợ lý hội thoại: `CONVERSATION_ALLOWED_ROLES = ["admin"]` (giai đoạn đầu), profile phải active, **mỗi tin nhắn** kiểm tra lại quyền shop qua `ai_user_shop_access`; ngữ cảnh hội thoại không bao giờ cấp quyền.

**Tầng database** (00036 trở đi):
- `anon`: không có quyền gì trên bảng public.
- `authenticated`: chỉ đọc, lọc bằng RLS (`is_active_user()`, `has_any_role()` là `SECURITY DEFINER`, `search_path=''`); không có quyền ghi trên bảng nào.
- Bảng bí mật / AI: RLS bật, 0 policy, `REVOKE` anon/authenticated, `GRANT` tường minh cho `service_role` (Supabase cloud không có default grant).
- Trigger `guard_last_active_admin` luôn giữ ít nhất 1 admin active.

**Điểm cần lưu ý** (✅): `notifications/recipients.ts` và `logs.ts` không có marker `server-only` nhưng import `@/lib/supabase/admin` (có marker) → vẫn an toàn khi bundle; nhưng worker chạy ngoài Next **không** import được chúng (xem G.3).

---

## D. Những thành phần có thể tái sử dụng

| Thành phần hiện có | Tái dùng cho | Cách dùng | Ghi chú |
|---|---|---|---|
| `conversation/service.ts` (`acceptIncomingMessage`, `processAcceptedMessage`, `ConversationStore`, `OutboundSender`, `IncomingMessage`) | Zalo Personal inbound + trả lời | thêm kênh `zalo_personal` vào `ConversationChannel`; worker gọi đúng 2 hàm như webhook OA | đã thiết kế không phụ thuộc kênh, có dedupe, link, phân quyền shop |
| `conversation/supabase-store.ts` | worker | thuần, nhận `SupabaseClient` từ ngoài → worker tự tạo client | `findLink` / `createLink` đang khóa cứng `channel === "zalo"` → cần nhánh mới (không sửa nhánh OA) |
| `conversation/router.ts` | định tuyến deterministic trước khi gọi LLM | giữ nguyên | |
| Cơ chế mã liên kết (`generateLinkCode`, `zalo_link_codes`, `/settings/zalo-agent`) | liên kết tài khoản Zalo cá nhân ↔ profile | dùng chung bảng mã; bảng liên kết riêng cho kênh personal | mã không gắn kênh → 1 mã dùng được cho 1 kênh bất kỳ (chấp nhận được) |
| `product-analyst/provider.ts` (`ProductAnalystProvider`) + orchestrator, tools, guard, `ai_usage_logs`, `ai_analysis_cache` | Gemini cho câu hỏi phân tích Shopee | viết `GeminiProductAnalystProvider` cùng interface, thêm `"gemini"` vào config | orchestrator thuần; `scripts/ai/product-analyst-pilot.ts` chứng minh chạy được ngoài Next |
| `security/secrets.ts` (AES-256-GCM v1 + AAD, `APP_ENCRYPTION_KEY`) | mã hóa session zca-js (cookie, imei, userAgent) | `encryptSecret(json, key, "zalo_personal_sessions:<accountId>")` | ưu tiên thay vì `zalo/crypto.ts` (cũ, không AAD, không version) |
| Mẫu `claim_next_sync_job()` (`SKIP LOCKED`) + `recover_stale_sync_jobs` | task-reminder-engine: nhận nhắc việc đến hạn | viết RPC riêng `claim_due_reminders()` theo cùng mẫu | không dùng chung bảng `channel_sync_jobs` (gắn với Shopee/shop) |
| Mẫu heartbeat (`channel_sync_heartbeats`) | giám sát worker còn sống | cột heartbeat trên bảng tài khoản personal | |
| `notifications/date-vn.ts` | tính giờ Asia/Ho_Chi_Minh cho nhắc việc | import trực tiếp (thuần) | |
| `notifications/service.ts` `sendNotification()` | (tùy chọn) nhắc việc gửi qua OA khi personal lỗi | chỉ gọi được từ Next (server-only) | **không** sửa |
| Mẫu flag (`on()`, mặc định tắt, flag kênh chỉ có hiệu lực khi master bật) | flag mới | sao chép mẫu | |
| `cron/auth.ts` `isAuthorizedInternalRequest` | route nội bộ (nếu cần pg_cron gọi Next) | tái dùng | |

**Không tạo mới vì đã có**: dịch vụ hội thoại, dedupe inbound, liên kết tài khoản, phân quyền shop, provider interface AI, log chi phí AI, mã hóa bí mật, mẫu hàng đợi.

---

## E. Kiến trúc Zalo Personal đề xuất

### E.1 Ràng buộc quyết định kiến trúc

1. **zca-js cần tiến trình chạy liên tục** (giữ kết nối listener để nhận tin) ⚠️. Vercel serverless không giữ được kết nối dài → **worker phải chạy ngoài Vercel** (VPS / Docker / Railway / Fly.io…). Chỉ **1 instance** cho mỗi tài khoản Zalo.
2. Worker chạy bằng `node` thuần **không import được** module có `import "server-only"` (✅: package `server-only` ném lỗi khi không có điều kiện `react-server`) và **không** phân giải alias `@/` (✅: các script hiện có đều dùng import tương đối). → Worker chỉ dùng module thuần + client Supabase của riêng nó.
3. Zalo OA giữ nguyên 100%: không sửa `src/lib/zalo/**`, các route `/api/zalo/**`, `notifications/**`, bảng `zalo_connections` / `notification_*` / `zalo_user_links`.
4. Kênh mới là kênh **riêng** (`zalo_personal`), không dùng chung giá trị `zalo`: UID người dùng của OA và UID tài khoản cá nhân là hai không gian định danh khác nhau ⚠️, và `zalo_user_links.zalo_user_id` đang UNIQUE trên một không gian duy nhất.

### E.2 Sơ đồ

```
                         ┌────────────────────────── Vercel (Next.js) ──────────────────────────┐
 Zalo OA  ─ webhook ───► │ /api/zalo/webhook → conversation/service (channel "zalo")  [KHÔNG ĐỔI] │
                         │ notifications/* → sendZaloTextMessage → OA API             [KHÔNG ĐỔI] │
                         │ /settings/zalo-personal (admin: QR login, trạng thái, kill switch) NEW │
                         └──────────────┬───────────────────────────────────────────────────────┘
                                        │ chỉ qua DB (không gọi trực tiếp)
                                        ▼
                         ┌──────────── Supabase ────────────┐
                         │ ai_conversations / ai_messages   │ ◄── thêm channel 'zalo_personal'
                         │ zalo_personal_accounts (lease,   │
                         │   heartbeat, session mã hóa)     │ NEW
                         │ zalo_personal_links              │ NEW
                         │ ai_memories                      │ NEW
                         │ ai_tasks / ai_task_reminders     │ NEW
                         │ ai_usage_logs (+ channel mới)    │
                         └──────────────▲───────────────────┘
                                        │ service role
 Zalo (tài khoản cá nhân)               │
   ▲   │ zca-js listener   ┌────────────┴──────── workers/zalo-personal (Node, 1 instance) ──────────┐
   │   └─────────────────► │ listener.ts   tin nhắn 1-1 → IncomingMessage{channel:"zalo_personal"}  │
   │                       │      └──► conversation/service.acceptIncomingMessage → processAccepted  │
   │                       │ ai/assistant  (Gemini: trò chuyện, trích xuất nhắc việc, tóm tắt nhớ)   │
   │                       │ memory        đọc/ghi ai_memories, ghép vào prompt                      │
   │                       │ reminders     mỗi 30s: claim_due_reminders() → gửi                     │
   └──── sendMessage ───── │ personal-sender.ts  implements OutboundSender (hàng đợi + giới hạn tốc độ)│
                           │ lease/heartbeat, kill switch đọc từ DB                                  │
                           └──────────────────────────────────────────────────────────────────────────┘
```

### E.3 Vị trí từng thành phần

| Thành phần | Vị trí đề xuất | Lý do |
|---|---|---|
| **zalo-personal-worker** | `workers/zalo-personal/` (thư mục gốc mới, ngoài `src/`) — `main.ts`, `session.ts`, `listener.ts`, `personal-sender.ts`, `lease.ts`, `db.ts`, `Dockerfile` | deploy tách khỏi Vercel; chỉ import module thuần từ `src/lib/**` bằng đường dẫn tương đối (giống `scripts/`). Phải thêm `workers` vào `exclude` của `tsconfig.json` (hoặc tsconfig riêng) để `next build` không typecheck. |
| Logic thuần của Zalo Personal (parse event zca-js → `IncomingMessage`, lọc nhóm/người lạ, chia nhỏ tin) | `src/lib/zalo-personal/` (`events.ts`, `policy.ts`, `config.ts`) | test được bằng `node --test`, tách hẳn khỏi `src/lib/zalo/` (OA) |
| **unified-message-service** | **Không tạo service mới.** Mở rộng `src/lib/conversation/`: thêm `"zalo_personal"` vào `ConversationChannel`; thêm `src/lib/conversation/channels.ts` (registry `channel → OutboundSender`, chính sách theo kênh: giới hạn độ dài, có gửi thông báo "chưa liên kết" hay không) | `service.ts` + `OutboundSender` đã là lớp hợp nhất; tạo thêm sẽ trùng chức năng |
| **gemini-ai-service** | `src/lib/ai/gemini/` (`client.ts` gọi `@google/genai`, `config.ts`) + `src/lib/product-analyst/gemini-provider.ts` (implements `ProductAnalystProvider`) + `src/lib/ai/assistant.ts` (interface `AssistantModel` cho trò chuyện chung / trích xuất cấu trúc) | câu hỏi phân tích tái dùng orchestrator + guard + usage log; trò chuyện chung cần interface nhỏ hơn (không tool Shopee) |
| **conversation-memory** | `src/lib/conversation/memory.ts` (thuần: chọn/ghép/giới hạn ký ức) + phương thức mới trên `ConversationStore` (tùy chọn, như `recentTurns?`) + bảng `ai_memories` | gắn với hội thoại; hiện đã có trí nhớ ngắn hạn (`context` jsonb + 8 lượt `recentTurns`) — ký ức dài hạn là lớp bổ sung, không thay thế |
| **task-reminder-engine** | `src/lib/reminders/` (`parse.ts` kiểm tra kết quả trích xuất, `schedule.ts` tính giờ VN / lặp lại, `store.ts`) + RPC `claim_due_reminders()` + vòng lặp dispatcher trong worker | worker vốn chạy liên tục → không cần pg_cron mỗi phút; nhắc việc gửi qua `OutboundSender` của kênh đích |
| Trang quản trị | `src/app/(authenticated)/(system)/settings/zalo-personal/` (`integration:manage`) | cùng chỗ với cấu hình hệ thống; trang Zalo OA không bị đụng |

### E.4 Luồng chính

**Đăng nhập & phiên** ⚠️ (theo tài liệu zca-js, cần kiểm chứng ở phase 02)
1. Admin bấm "Kết nối" trên `/settings/zalo-personal` → ghi yêu cầu vào `zalo_personal_accounts` (`login_requested_at`).
2. Worker thấy yêu cầu → `loginQR()` → lưu ảnh QR (chỉ trong bộ nhớ hoặc cột tạm có TTL ngắn) → UI hiển thị → admin quét bằng điện thoại.
3. Đăng nhập xong → worker lấy thông tin phiên (cookie, imei, userAgent) → **mã hóa bằng `security/secrets.ts`** → lưu. Không bao giờ log, không trả về trình duyệt.
4. Khởi động lại → đăng nhập bằng phiên đã lưu; hỏng → trạng thái `needs_relogin`, không thử lại liên tục.

**Nhận tin** (tái dùng hoàn toàn lớp hội thoại)
1. Listener nhận tin → `src/lib/zalo-personal/events.ts` chuẩn hóa → **bỏ qua**: tin nhóm (mặc định), tin của chính mình, loại không phải text, người chưa liên kết (im lặng — tài khoản cá nhân nhận tin của khách, không được trả lời tự động người lạ).
2. `acceptIncomingMessage()` → dedupe bằng `(channel='zalo_personal', provider_message_id=msgId)`.
3. `processAcceptedMessage()` với `deps.sender = personalSender` → trả lời đi lại đúng kênh.

**Gửi tin**: `personalSender.sendText()` đưa vào hàng đợi trong process, tối đa 1 tin đang gửi, có khoảng nghỉ ngẫu nhiên giữa các tin, giới hạn số tin/phút/giờ, chia tin dài. Kết quả ghi `ai_messages` (outbound) như OA.

**Một instance duy nhất**: `zalo_personal_accounts.lease_owner` + `lease_expires_at`, gia hạn mỗi 15–30s bằng UPDATE có điều kiện (mẫu giống `claimRefreshLock` trong `zalo/token.ts`). Instance không giữ lease → không mở listener.

### E.5 Bảng mới đề xuất (để chốt ở phase 01, chưa tạo)

| Bảng | Cột chính | Ràng buộc |
|---|---|---|
| `zalo_personal_accounts` | `id`, `display_name`, `zalo_uid`, `status` (disconnected/connecting/connected/needs_relogin/disabled), `session_encrypted`, `lease_owner`, `lease_expires_at`, `last_heartbeat_at`, `last_error_code`, `enabled` (kill switch), `login_requested_at` | RLS bật, 0 policy, chỉ service_role |
| `zalo_personal_links` | `zalo_uid` UNIQUE, `internal_user_id`, `status`, `linked_at`, `revoked_at` | như 00069 |
| `ai_memories` | `id`, `internal_user_id`, `scope` (user/conversation), `kind` (fact/preference/summary), `content` ≤ 1000, `source_message_id`, `created_by` (ai/user/admin), `expires_at`, `deleted_at` | như 00069; không lưu dữ liệu tài chính/khách hàng thô |
| `ai_tasks` | `id`, `internal_user_id`, `title`, `due_at`, `remind_at`, `recurrence` (giới hạn: none/daily/weekly), `status` (open/done/cancelled), `target_channel`, `conversation_id`, `source_message_id` | như 00069 |
| `ai_task_reminders` | `task_id`, `scheduled_for`, `status` (pending/sending/sent/failed), `attempts`, `claimed_at`, `provider_message_id` | UNIQUE (`task_id`, `scheduled_for`) → không nhắc trùng |

Mở rộng CHECK (cộng thêm, không đổi giá trị cũ): `ai_conversations.channel`, `ai_messages.channel`, `ai_usage_logs.channel` thêm `'zalo_personal'`.

### E.6 Feature flag đề xuất (tất cả mặc định TẮT)

`ZALO_PERSONAL_ENABLED`, `ZALO_PERSONAL_REPLY_ENABLED` (nghe nhưng không trả lời — chế độ quan sát), `ZALO_PERSONAL_GROUPS_ENABLED`, `AI_ASSISTANT_PROVIDER` (`gemini` | `fake`), `GEMINI_API_KEY` (chỉ server/worker), `AI_ASSISTANT_MODEL`, `AI_MEMORY_ENABLED`, `AI_REMINDERS_ENABLED`. Kill switch ưu tiên đọc từ DB (`zalo_personal_accounts.enabled`) để tắt được mà không phải deploy lại.

---

## F. Danh sách file cần tạo / chỉnh sửa (dự kiến theo phase)

> **Đã thay thế** bởi `decisions.md` §5–§6 và `implementation-plan.md`. Điểm khác chính: thêm `workspaces`, `ai_channel_access`, bảng mã liên kết riêng cho personal, bảng nhóm, `ai_memories` có `access_scope`, và nhắc việc có máy trạng thái + audit.

### F.1 Tạo mới

| Phase | File |
|---|---|
| 01 | `supabase/migrations/00073_zalo_personal_foundation.sql` (accounts, links, mở rộng CHECK channel) |
| 01 | `docs/zalo-ai/rollback.md` (SQL rollback thủ công cho từng migration mới) |
| 02 | `src/lib/zalo-personal/{config,events,policy}.ts` + `*.test.ts` |
| 02 | `workers/zalo-personal/{main,session,listener,lease,db}.ts`, `workers/zalo-personal/Dockerfile`, `workers/zalo-personal/README.md` |
| 03 | `src/lib/conversation/channels.ts` + test; `workers/zalo-personal/personal-sender.ts` |
| 03 | `src/app/(authenticated)/(system)/settings/zalo-personal/{page.tsx,actions.ts,...}` |
| 04 | `src/lib/ai/gemini/{client,config}.ts`, `src/lib/ai/assistant.ts`, `src/lib/product-analyst/gemini-provider.ts` + test với fake |
| 05 | `supabase/migrations/00074_ai_memories.sql`, `src/lib/conversation/memory.ts` + test |
| 06 | `supabase/migrations/00075_ai_tasks_reminders.sql` (bảng + `claim_due_reminders()`), `src/lib/reminders/{parse,schedule,store}.ts` + test, `workers/zalo-personal/reminders.ts` |

### F.2 Chỉnh sửa (chỉ thêm, không đổi hành vi OA)

| File | Thay đổi | Ảnh hưởng tới OA |
|---|---|---|
| `package.json` | thêm `zca-js` (pin **chính xác** version), `@google/genai`; thêm test mới vào script `test`; script `worker:zalo-personal` | không |
| `tsconfig.json` | thêm `workers` vào `exclude` (hoặc tsconfig riêng cho worker) | không |
| `.env.example` | thêm biến ở E.6 (không có giá trị) | không |
| `src/lib/conversation/service.ts` | `ConversationChannel` thêm `"zalo_personal"`; chính sách "chưa liên kết" lấy theo kênh | có — là đường đi chung; **bắt buộc** chạy lại toàn bộ test conversation |
| `src/lib/conversation/supabase-store.ts` | `findLink` / `createLink`: thêm nhánh `zalo_personal` → `zalo_personal_links`; nhánh `zalo` giữ nguyên | nhánh `zalo` không đổi |
| `src/lib/product-analyst/config.ts` | thêm provider `"gemini"`, bảng giá Gemini | xem rủi ro G.2 |
| `src/lib/product-analyst/server.ts` | `createProductAnalystProvider` thêm nhánh Gemini; `getProductAnalyst` nhận kênh mới | không (khi flag tắt) |
| `src/lib/auth/permissions.ts` | (tùy chọn) dùng lại `integration:manage`; chỉ thêm quyền mới nếu cần tách người vận hành worker | không |
| `src/lib/apps/nav.ts` | thêm mục menu "Zalo cá nhân" trong app Hệ thống | không |
| `eslint.config.mjs` | nếu cần, bỏ qua `workers/**/dist` | không |

### F.3 Không được chạm

`src/lib/zalo/**`, `src/app/api/zalo/**`, `src/lib/notifications/**`, `src/app/api/cron/**`, `src/app/api/notifications/**`, `/settings/notifications`, `/settings/zalo-agent`, `vercel.json`, các migration cũ 00001–00072, bảng `zalo_connections`, `notification_*`, `zalo_user_links`.

---

## G. Rủi ro tương thích

### G.1 Rủi ro nghiệp vụ / pháp lý

| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R1 | zca-js là API **không chính thức** ("Unofficial Zalo API" — mô tả trên npm). Dùng tự động hóa trên tài khoản cá nhân có thể vi phạm điều khoản Zalo → **tài khoản có thể bị khóa** ⚠️ | Cao | dùng tài khoản riêng cho bot (không dùng tài khoản chủ shop); giới hạn tốc độ thấp; không gửi hàng loạt; chế độ chỉ nghe trước khi bật trả lời; chấp nhận rủi ro bằng văn bản |
| R2 | Zalo thay đổi giao thức → zca-js hỏng bất ngờ. Bản `2.4.0` vừa cập nhật 2026-11-23 → thư viện thay đổi thường xuyên | Cao | pin version chính xác; trạng thái `needs_relogin` / `degraded` hiển thị trên UI; OA vẫn là kênh thông báo chính |
| R3 | Tài khoản cá nhân nhận tin của **khách hàng / người lạ / nhóm** → nguy cơ lưu dữ liệu cá nhân bên thứ ba và trả lời nhầm | Cao | mặc định chỉ xử lý tin 1-1 từ người **đã liên kết**; không lưu nội dung người chưa liên kết (service hiện đã thay bằng `[người dùng chưa liên kết]`); không tự gửi thông báo "chưa liên kết" trên kênh personal |
| R4 | Gửi nội dung hội thoại (có số liệu kinh doanh) sang Gemini; gói miễn phí có thể dùng dữ liệu để huấn luyện ⚠️ | Trung bình | dùng API key gói trả phí; chỉ gửi dữ liệu tối thiểu; ghi rõ trong tài liệu vận hành |
| R5 | Prompt injection qua tin nhắn → khiến AI tạo nhắc việc / ký ức sai, hoặc lộ dữ liệu shop khác | Trung bình | quyền shop vẫn kiểm tra ở backend mỗi tin (đã có); trích xuất nhắc việc phải qua schema zod + xác nhận của người dùng; AI không có tool ghi dữ liệu nghiệp vụ |

### G.2 Rủi ro kỹ thuật trong repo (✅ đã thấy trong mã)

| # | Phát hiện | Hệ quả nếu không xử lý |
|---|---|---|
| T1 | `product-analyst/config.ts`: `provider = (giá trị === "fake") ? "fake" : "anthropic"` | đặt `AI_PRODUCT_ANALYST_PROVIDER=gemini` trước khi code hỗ trợ sẽ **âm thầm chạy Claude**. Khi thêm Gemini phải đổi sang danh sách cho phép + lỗi rõ ràng |
| T2 | CHECK `channel IN ('zalo','web')` trên `ai_conversations`, `ai_messages`; `('zalo','web','script')` trên `ai_usage_logs` | insert kênh mới lỗi `23514` nếu chưa mở rộng CHECK |
| T3 | `supabase-store.ts` `findLink` trả `null` và `createLink` **ném lỗi** khi kênh ≠ `zalo` | liên kết kênh personal thất bại nếu không thêm nhánh |
| T4 | `zalo_user_links.zalo_user_id` UNIQUE, không có cột kênh | dùng chung bảng sẽ trộn UID OA với UID cá nhân → đề xuất bảng riêng `zalo_personal_links` |
| T5 | `conversation/server.ts`, `zalo/token.ts`, `zalo/messages.ts`, `supabase/admin.ts`, `notifications/service.ts` có `import "server-only"`; code dùng alias `@/` | worker không import được → worker chỉ dùng module thuần; đừng "sửa" bằng cách bỏ marker `server-only` |
| T6 | `tsconfig.json` `include: ["**/*.ts"]`, chỉ exclude `scripts` và test | thư mục `workers/` sẽ bị `next build` typecheck → phải exclude |
| T7 | Rate limiter trong process (`SenderRateLimiter`, `zalo/rate-limit.ts`) | đủ cho worker 1 instance; không dùng được nếu chạy nhiều instance |
| T8 | `@google/genai` yêu cầu Node ≥ 22 (npm `engines`) | Next chạy trên Vercel phải ≥ 22 nếu gọi Gemini từ web ⚠️ (chưa thấy cấu hình Node version trong repo) |
| T9 | `CONVERSATION_ALLOWED_ROLES = ["admin"]` dùng chung cho mọi kênh | nếu muốn staff dùng trợ lý personal phải tách theo kênh, không nới chung (sẽ nới luôn OA). **Đã chốt (D2):** dùng chính sách theo kênh, xem `decisions.md` §3.2 |
| T10 | Tài liệu product analyst ghi lịch sử Zalo không được trộn vào web (spec §81) | ký ức dài hạn dùng chung giữa các kênh là **quyết định cần chủ dự án chốt**. **Đã chốt (D1):** lịch sử và ký ức tách theo kênh, khớp spec §81 |
| T11 | Integration test (`npm test`) ghi vào Supabase thật bằng service role | phải chạy trên Supabase local / project test, không chạy vào production |
| T12 | Giới hạn tin 2000 ký tự là của OA (`messages.ts`); giới hạn của kênh personal chưa rõ ⚠️ | chính sách độ dài phải theo kênh (`channels.ts`) |

---

## H. Phương án rollback

Nguyên tắc: **mọi thay đổi đều có thể tắt mà không cần deploy lại, và có thể gỡ mà không ảnh hưởng OA.**

| Mức | Cách làm | Thời gian | Ảnh hưởng OA |
|---|---|---|---|
| 1. Kill switch | `zalo_personal_accounts.enabled = false` (UI hoặc SQL) → worker đóng listener trong ≤ 30s | giây | không |
| 2. Flag | `ZALO_PERSONAL_ENABLED=false`, `AI_MEMORY_ENABLED=false`, `AI_REMINDERS_ENABLED=false`, `AI_ASSISTANT_PROVIDER` bỏ trống | phút (restart worker / redeploy) | không |
| 3. Dừng worker | tắt container / process; xóa phiên đã lưu (`session_encrypted = null`); trên điện thoại: đăng xuất thiết bị lạ | phút | không |
| 4. Revert code | `git revert` các commit phase; code OA không bị sửa nên không cần revert gì ở OA | phút | không |
| 5. Gỡ DB | chạy SQL trong `docs/zalo-ai/rollback.md`: xóa dòng có `channel='zalo_personal'` trong `ai_messages` → `ai_conversations` → `ai_usage_logs`; khôi phục CHECK cũ; `DROP TABLE` các bảng mới | phút | không (bảng OA không bị đổi) |

Yêu cầu cho từng migration mới:
- Chỉ **thêm** (bảng mới, nới CHECK); không đổi tên/xóa cột cũ, không backfill dữ liệu cũ.
- Mỗi migration có đoạn rollback SQL tương ứng trong `docs/zalo-ai/rollback.md`, đã thử trên DB local.
- Áp dụng lên production chỉ khi chủ dự án đồng ý, sau khi đã chạy trên Supabase local/test; sau `db push` chạy `NOTIFY pgrst, 'reload schema'` (theo ghi chú của 00072).

---

## I. Checklist kiểm thử cho từng phase

> **Đã thay thế** bởi [implementation-plan.md](implementation-plan.md) (P01–P10, test case D1–D4, tiêu chí nghiệm thu). Giữ lại dưới đây để tham khảo.

### Hồi quy OA (bắt buộc ở **mọi** phase)
- [ ] `npm test` toàn bộ (trên Supabase local/test) — đặc biệt `src/lib/zalo/*.test.ts`, `src/lib/conversation/*.test.ts`, `src/lib/notifications/*.test.ts`
- [ ] `npm run lint` và `npm run build` thành công
- [ ] `git diff --stat` không có file nào trong danh sách F.3
- [ ] Môi trường test: `/settings/notifications` hiển thị đúng trạng thái token OA; "Gửi test" tới 1 người nhận thành công
- [ ] Webhook OA: tin có chữ ký sai → 401; tin trùng `msg_id` → `duplicate`

### Phase 01 — Nền tảng DB
- [ ] Migration chạy sạch trên DB trống (`supabase db reset` local) và trên bản sao schema hiện tại
- [ ] Bảng mới: RLS bật; `anon` / `authenticated` không SELECT/INSERT được (test bằng anon key + JWT user thường)
- [ ] Insert `channel='zalo_personal'` vào `ai_conversations` / `ai_messages` / `ai_usage_logs` thành công; giá trị lạ vẫn bị CHECK chặn
- [ ] Dòng `channel='zalo'` cũ không bị ảnh hưởng
- [ ] Rollback SQL chạy được và đưa schema về như trước

### Phase 02 — Worker: đăng nhập + nghe (chưa trả lời)
- [ ] Unit test `events.ts`: tin 1-1 text → `IncomingMessage`; tin nhóm / tin của chính mình / sticker / ảnh → bỏ qua
- [ ] Đăng nhập QR trên tài khoản **test**; phiên lưu dạng mã hóa (`v1.` prefix), giải mã sai context → lỗi
- [ ] Không có cookie / imei / token nào trong log (grep log worker)
- [ ] Restart worker → đăng nhập lại bằng phiên đã lưu
- [ ] Chạy 2 instance → chỉ 1 instance giữ lease và nghe
- [ ] Kill switch DB → listener đóng trong ≤ 30s
- [ ] `REPLY_ENABLED=false` → tin được lưu, không gửi gì ra ngoài

### Phase 03 — Kênh hợp nhất + trả lời + liên kết
- [ ] `LINK <mã>` qua kênh personal tạo dòng `zalo_personal_links`; mã đã dùng / hết hạn → từ chối; 5 lần sai/ngày → khóa
- [ ] Người chưa liên kết: không trả lời, không lưu nội dung
- [ ] Tin trùng `msgId` (gửi lại) → xử lý 1 lần
- [ ] Giới hạn tốc độ gửi hoạt động; tin dài được chia đúng
- [ ] Hỏi "công nợ NCC" qua personal → cùng kết quả như OA
- [ ] Quyền shop: hỏi shop không được cấp → "Bạn không có quyền xem shop này."

### Phase 04 — Gemini
- [ ] Unit test với provider giả (fake), không gọi mạng trong `npm test`
- [ ] `AI_PRODUCT_ANALYST_PROVIDER` giá trị lạ → lỗi rõ ràng, không âm thầm dùng Claude (T1)
- [ ] `ai_usage_logs` ghi đúng provider/model/token; chi phí `NULL` nếu chưa cấu hình giá (không đoán)
- [ ] Timeout, 429, lỗi provider → thông báo thân thiện, không lộ nội dung lỗi của provider
- [ ] Đầu ra phân tích vẫn qua guard/schema hiện có
- [ ] Pilot thủ công (opt-in, ngoài `npm test`) trên dữ liệu test

### Phase 05 — Conversation memory
- [ ] Ký ức chỉ đọc được bởi đúng `internal_user_id`; user khác / user bị thu hồi liên kết → không thấy
- [ ] Giới hạn số lượng + độ dài ký ức đưa vào prompt
- [ ] Người dùng xem / xóa được ký ức ("quên điều này"); xóa mềm có `deleted_at`
- [ ] Không lưu số liệu tài chính thô, link code, dữ liệu người chưa liên kết
- [ ] Quy tắc trộn giữa các kênh đúng với quyết định T10

### Phase 06 — Task reminder engine
- [ ] Phân tích thời gian tiếng Việt ("8h sáng mai", "thứ 6 tuần sau") → giờ Asia/Ho_Chi_Minh đúng; thời điểm đã qua → hỏi lại
- [ ] Tạo nhắc việc phải được người dùng xác nhận
- [ ] `claim_due_reminders()` chạy song song 2 lần không nhận trùng (`SKIP LOCKED`); UNIQUE (`task_id`, `scheduled_for`) chặn nhắc trùng
- [ ] Worker tắt lúc đến hạn → bật lại thì gửi bù (hoặc đánh dấu trễ) theo chính sách đã chốt
- [ ] Hủy / hoàn thành nhắc việc qua tin nhắn

### Phase 07 — Vận hành
- [ ] UI hiển thị: trạng thái kết nối, heartbeat cuối, lỗi cuối, số tin 24h
- [ ] Cảnh báo khi worker mất heartbeat > N phút (có thể gửi qua OA bằng `sendNotification` từ phía Next)
- [ ] Diễn tập rollback mức 1 → 5 trên môi trường test

---

## J. Đã xác minh và cần kiểm chứng

### J.1 Đã xác minh từ mã nguồn ✅
- Stack, version Next/React/Supabase, cách chạy TS bằng `node` thuần, cấu hình `tsconfig` (include/exclude).
- Toàn bộ file trong `src/lib/zalo/`, `src/lib/conversation/`, các file chính của `src/lib/notifications/` và `src/lib/auth/`, `src/proxy.ts`, 19 route trong `src/app/api/`.
- Định nghĩa bảng / RLS / grant trong migration 00028, 00029, 00031, 00033, 00036, 00037, 00069, 00070 (phần `ai_conversations`), 00072; mẫu hàng đợi `SKIP LOCKED` (00045/00063) và pg_cron + pg_net + Vault (00050).
- Package `server-only` ném lỗi khi import ngoài điều kiện `react-server` (đọc `node_modules/server-only`).
- Không có `zca-js`, Gemini, pgvector trong repo.
- Rủi ro T1–T7, T9–T11 nhìn thấy trực tiếp trong mã.
- Metadata npm: `zca-js@2.4.0` ("Unofficial Zalo API for JavaScript", MIT, Node ≥ 18, sửa đổi gần nhất 2026-11-23); `@google/genai@3.6.1` (Node ≥ 22).

### J.2 Cần kiểm chứng ⚠️
1. **Database production có khớp với migrations không** — audit chỉ đọc file migration, chưa kết nối production (đúng ràng buộc). Cần chạy `supabase migration list` (chỉ đọc) để xác nhận 00072 là bản mới nhất đã áp dụng.
2. **Hành vi thực tế của zca-js 2.4.0**: API đăng nhập (QR / cookie + imei + userAgent), cấu trúc event tin nhắn, định danh `msgId` có ổn định khi gửi lại không, giới hạn độ dài tin, đăng nhập Zalo Web/PC ở nơi khác có làm rớt phiên worker không, tần suất gửi an toàn. → spike trên **tài khoản test** ở phase 02.
3. **UID của tài khoản cá nhân khác UID theo OA** (giả định nền của T4) — xác nhận bằng cùng một người dùng nhắn cả hai kênh.
4. Điều khoản sử dụng Zalo đối với tự động hóa tài khoản cá nhân, và mức chấp nhận rủi ro khóa tài khoản của chủ dự án.
5. Chính sách dữ liệu của Gemini API theo gói đang dùng; model Gemini cụ thể, giá, hạn mức.
6. Phiên bản Node của Vercel project (cần ≥ 22 nếu gọi Gemini từ Next).
7. Nơi chạy worker (VPS / Docker / dịch vụ nào), ai vận hành, cách cấp secret cho worker.
8. Trạng thái các flag hiện tại trên production (`ZALO_CONVERSATION_ENABLED`, `AI_PRODUCT_ANALYST_*`) — chỉ thấy giá trị mặc định trong `.env.example`.
9. Môi trường để chạy `npm test` an toàn (Supabase local cần Docker, hoặc một project test riêng).
10. ~~Quyết định sản phẩm: ký ức có dùng chung giữa OA / web / personal không (T10); staff có được dùng trợ lý personal không (T9); có xử lý tin nhóm không; nhắc việc trễ thì gửi bù hay bỏ.~~ → **Đã chốt** trong `decisions.md` (D1–D4). Các câu hỏi chi tiết còn lại: `decisions.md` §8 (Q1–Q14).

### J.3 Ghi chú phụ (không thuộc phạm vi, không sửa)
- `.env.example` đang chứa URL Supabase thật và publishable (anon) key của project. Loại key này được thiết kế để công khai nên rủi ro thấp, nhưng nên cân nhắc thay bằng placeholder.
