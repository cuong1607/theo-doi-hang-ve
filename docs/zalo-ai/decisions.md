# Zalo AI Assistant — Chốt 4 quyết định kiến trúc

> Dự án CONGTRANGBEDDING · repo `theo-doi-hang-ve` · 2026-11-24 · nền: commit `b5c4135`
> Đọc kèm: [architecture-audit.md](architecture-audit.md) (Phase 00) · [implementation-plan.md](implementation-plan.md) (task, test, nghiệm thu)
>
> **Cập nhật Phase 02 (2026-11-24):** việc lưu tin Zalo Personal đã được triển khai trong các bảng riêng `zalo_personal_*` (migration `00073`) cho **cả 1-1 lẫn nhóm**. Điều này khác §5.1, nơi tin 1-1 dự kiến nằm trong `ai_conversations` / `ai_messages`; lý do ở [phase-02-integration.md](phase-02-integration.md) §1. `ai_conversations` / `ai_messages` và CHECK `channel` của chúng **không đổi**. Bảng `workspaces` / `ai_channel_access` (Q1, Q2) **chưa** được tạo: Phase 02 dùng `owner_user_id` của connection làm ranh giới cô lập.
>
> Tài liệu này **chỉ là thiết kế**: chưa có code, chưa có migration, chưa chạm database production.
> Ký hiệu: ✅ đã xác minh trong source · ⚠️ cần kiểm chứng · ❗ xung đột / cần chủ dự án chốt.

---

## 0. Tóm tắt

| # | Quyết định | Kết quả đối chiếu | Xung đột cần chốt |
|---|---|---|---|
| D1 | Tách lịch sử theo kênh; chỉ dùng chung AI Engine / Provider / System Tools / RAG | **Tương thích** với thiết kế hiện tại (mỗi kênh một thread, spec §81) | ❗ C1 repo **không có** khái niệm workspace/tenant · ❗ C2 **chưa có** RAG nào để dùng chung · C3 bảng `ai_*` hiện có thiếu `workspace_id` / `access_scope` |
| D2 | Owner/Admin/Staff dùng Zalo Personal AI nếu được cấp quyền | **Tương thích một phần** | ❗ C4 **không có role Owner** (chỉ admin/staff/viewer) · ❗ C5 `CONVERSATION_ALLOWED_ROLES=["admin"]` dùng chung cho OA, Web **và** System Tools · C6 mã liên kết hiện chỉ admin tạo được (`integration:manage`) |
| D3 | Hỗ trợ tin nhóm với 4 chế độ, mặc định disabled | **Mới hoàn toàn**, không xung đột với OA | C7 `ai_messages` không có người gửi → không dùng được cho nhóm · ❗ C8 cách ghi nhận "sự đồng ý" chưa xác định |
| D4 | Chính sách gửi bù nhắc việc | **Mới hoàn toàn**; tái dùng mẫu hàng đợi `SKIP LOCKED` | ❗ C9 định nghĩa DAY / HOUR / MORNING / OVERDUE (thời điểm, phạm vi tổng hợp) chưa đủ để code |

Không có quyết định nào **bắt buộc** sửa Zalo OA. Thay đổi duy nhất trên đường code dùng chung là **tiêm chính sách theo kênh** vào `conversation/service.ts` và `product-analytics/agent-tools.ts`. Với kênh `zalo` và `web`, giá trị mặc định giữ đúng hành vi hiện tại, có test hồi quy chứng minh (xem §6).

---

## 1. Hiện trạng liên quan (✅ đọc từ source)

| Chủ đề | Hiện trạng | Nguồn |
|---|---|---|
| Role | `admin` \| `staff` \| `viewer`. Không có `owner` | `src/lib/auth/permissions.ts`, CHECK của `profiles` (00001) |
| Tenant / workspace | Không có. Ứng dụng một tenant; không bảng/cột `workspace_id`, `tenant_id`, `organization_id` | grep toàn bộ `src/` + `supabase/migrations/` |
| Thread hội thoại | `ai_conversations` UNIQUE(`channel`, `external_user_id`); `channel IN ('zalo','web')`. Web: 1 thread/user, **không trộn lịch sử Zalo** | 00069, 00072, `conversation/web.ts`, `docs/product-analyst-agent.md` (Channels/Web) |
| Bộ nhớ hiện có | Ngắn hạn: `ai_conversations.context` (jsonb nhẹ) + tối đa 8 lượt gần nhất của **cùng thread** (`recentTurns`). Không có bộ nhớ dài hạn | `conversation/supabase-store.ts` |
| RAG / embedding | Không có. Không có pgvector | grep migrations |
| System Tools | 7 tool **chỉ đọc** của Product Analyst (6 cấp sản phẩm, 1 cấp shop), allowlist, mỗi lần gọi đều authorize lại | `product-analyst/tools.ts`, `product-analytics/agent-tools.ts` |
| Role được dùng trợ lý | `CONVERSATION_ALLOWED_ROLES = ["admin"]`, dùng ở 3 chỗ: lúc tiêu thụ mã liên kết, mỗi tin nhắn, và **trong `authorizeShopTool`** | `conversation/service.ts:29`, `agent-tools.ts:66`, `product-analyst/access.ts` |
| Liên kết | Mã 8 ký tự, chỉ lưu sha256, TTL 10 phút, tiêu thụ bằng 1 UPDATE có điều kiện (chống replay), tối đa 5 lần sai/ngày/hội thoại. Mã chỉ tạo cho **chính mình**, cần `integration:manage` (admin) | `service.ts`, `supabase-store.ts`, `/settings/zalo-agent/actions.ts` |
| Thu hồi | Khóa user / hạ role → `findLink` join `profiles` (`is_active`, `role`) **mỗi tin nhắn** → mất quyền ngay. Trang `/users` không đụng tới `zalo_user_links` | `supabase-store.ts:findLink`, `(system)/users/actions.ts` |
| Role lấy từ đâu | Luôn từ DB (`profiles`) phía server; không bao giờ từ client hay nội dung tin | `auth/session.ts`, `service.ts` |
| Hàng đợi bền vững | `claim_next_sync_job()` dùng `FOR UPDATE SKIP LOCKED`; có `recover_stale_sync_jobs`; heartbeat; pg_cron + pg_net | 00045, 00050, 00063 |
| Giờ Việt Nam | `getTodayDateVN()` và quy ước UTC+7 cố định | `notifications/date-vn.ts`, `notifications/logs.ts` |

---

## 2. D1 — AI Memory và lịch sử hội thoại

### 2.1 Đối chiếu

| Yêu cầu | Trạng thái | Ghi chú |
|---|---|---|
| Lịch sử Web / OA / Personal tách biệt | ✅ **Đã đúng** cho Web và OA. Personal sẽ là giá trị `channel` thứ ba | `recentTurns` lọc theo `conversation_id` → không thể lẫn kênh |
| Không tự trộn lịch sử Zalo vào Web | ✅ Đúng với tài liệu hiện có ("Thread: one per user, separate from Zalo") | Không xung đột |
| Dùng chung AI Engine, Gemini Provider | Tương thích | `ProductAnalystProvider.run()` đã có input chung (system, turns, tools, executeTool, check, limits) → Gemini implement cùng interface |
| Dùng chung System Tools | Tương thích | 7 tool hiện có đã authorize ở backend mỗi lần gọi; cần thêm metadata kênh/nhóm (§5.3) |
| Dùng chung RAG | ❗ **C2: chưa có RAG** | Không có corpus, embedding hay pgvector. Đề xuất: chưa xây RAG trong các phase này; định nghĩa trước interface `Retriever` để sau gắn vào mà không đổi ranh giới |
| Mỗi bản ghi có channel, conversation ID, workspace ID, owner/tenant, access scope | ❗ **C1 + C3** | Bảng **mới**: đủ các cột. Bảng **cũ** (`ai_conversations`, `ai_messages`, `ai_usage_logs`): có `channel` + `conversation_id`, owner suy ra từ `ai_conversations.internal_user_id`, **thiếu** `workspace_id` và `access_scope` |
| Truy xuất chéo kênh chỉ qua System Tools có kiểm quyền | Tương thích | Store của bộ nhớ **không có** hàm đọc chéo kênh; muốn xem dữ liệu kênh khác phải gọi một tool, và tool đó tự authorize |
| Không sửa hành vi Web Conversation | Tương thích | Không đổi `web.ts`, không đổi schema cột cũ; chỉ nới CHECK `channel` |

### 2.2 Đề xuất xử lý C1 (workspace / tenant)

**Đề xuất (cần chốt — Q2):** thêm bảng `workspaces` với **một** dòng mặc định. Mọi bảng **mới** có `workspace_id NOT NULL` tham chiếu bảng này.
- Bảng cũ **không** thêm cột trong các phase này: Web giữ nguyên, rủi ro thấp nhất. Dữ liệu cũ được hiểu ngầm là thuộc workspace mặc định.
- Nếu sau này thật sự đa tenant: thêm `workspace_id` (có DEFAULT = workspace mặc định) vào bảng cũ trong một phase riêng, kèm test hồi quy Web.
- Lý do không dùng hằng số trong code: khóa ngoại cho phép DB chặn ghi sai workspace ngay từ đầu.

### 2.3 Quy tắc truy cập bộ nhớ (bắt buộc ở tầng store, không chỉ ở prompt)

1. Đọc ký ức luôn lọc đủ: `workspace_id` + `channel` + (`conversation_id` **hoặc** `group_id`) + `owner_user_id` (với scope `private`).
2. `access_scope`:
   - `private`: chỉ chủ sở hữu, chỉ trong đúng thread 1-1 của kênh đó.
   - `group`: chỉ dùng **bên trong đúng nhóm đó**, không bao giờ trả về trong 1-1 hay kênh khác.
3. Không có `access_scope = 'workspace'` trong phase này (tránh bộ nhớ dùng chung thiếu phân quyền).
4. Mỗi lần đọc kiểm tra lại: profile active, quyền kênh còn hiệu lực, liên kết còn `active`.
5. Ký ức không bao giờ chứa: mã liên kết, token, số liệu tài chính thô, nội dung của người chưa liên kết.

---

## 3. D2 — Quyền sử dụng của Staff

### 3.1 Đối chiếu

| Yêu cầu | Trạng thái | Ghi chú |
|---|---|---|
| Owner, Admin, Staff dùng được nếu được cấp quyền | ❗ **C4**: không có role Owner · ❗ **C5**: hằng số role dùng chung | Xem 3.2 |
| Liên kết UID với tài khoản đã xác thực | ✅ Cơ chế đã có (mã do user đang đăng nhập tạo, gửi từ chính tài khoản Zalo cần liên kết) | C6: hiện chỉ admin tạo mã được |
| Mã một lần, có hạn, chống replay | ✅ Đã có (sha256, 10 phút, UPDATE có điều kiện, 5 lần sai/ngày) | Tái dùng `generateLinkCode` / `hashLinkCode`; bảng mã **riêng** cho kênh personal (3.3) |
| Mọi System Tool kiểm quyền backend | ✅ Đã đúng với 7 tool hiện có | Tool mới phải đi qua registry (§5.3) |
| Không tin role từ client / tin nhắn | ✅ Đã đúng | Giữ nguyên |
| User bị khóa / thu hồi → mất quyền Zalo AI | ✅ Đúng tại thời điểm dùng (join `profiles` mỗi tin) | Bổ sung: kiểm tra lại **lúc gửi nhắc việc** và **lúc đọc ký ức**; thêm bảng cấp quyền theo kênh để thu hồi riêng |
| Người chưa liên kết chỉ dùng chức năng công khai đã cho phép | ❗ Chưa có khái niệm "chức năng công khai" | Đề xuất danh sách cho phép **rỗng** mặc định = im lặng hoàn toàn (Q4) |

### 3.2 Xử lý C4 + C5

- **C4 (Owner):** đề xuất **Owner = admin** hiện có, không thêm role mới (Q1). Thêm role mới sẽ đụng CHECK của `profiles`, ma trận quyền, `guard_last_active_admin`, trang `/users`. Phạm vi đó vượt quá dự án này.
- **C5:** **không** sửa `CONVERSATION_ALLOWED_ROLES`, vì sửa sẽ mở cả OA và Web cho Staff. Thay vào đó:
  1. Thêm **chính sách theo kênh** (`ChannelPolicy`) tiêm vào service. `zalo` và `web` dùng chính sách mặc định = `["admin"]`, giữ nguyên hành vi. `zalo_personal` dùng `["admin","staff"]` **và** bắt buộc có quyền kênh.
  2. Thêm permission `assistant:zalo_personal` = admin + staff trong `permissions.ts`. Đây chỉ là **điều kiện cần**; điều kiện đủ là có dòng `ai_channel_access` còn hiệu lực do admin cấp.
  3. `authorizeShopTool` / `authorizeProductTool` nhận tập role được phép **từ chính sách kênh**, với mặc định bằng hằng số hiện tại. Staff có được dùng tool Shopee qua kênh personal hay không là quyết định riêng (Q5); mặc định **không**.
- Viewer: không dùng được (không có trong permission mới).

### 3.3 Liên kết cho kênh personal

- Bảng mã **riêng** `zalo_personal_link_codes`, không thêm cột vào `zalo_link_codes` của OA. Nếu dùng chung bảng thì cả hai đường tiêu thụ đều phải lọc theo kênh, tức là phải sửa code OA.
- Ai được tạo mã: user có `assistant:zalo_personal` **và** đã được cấp `ai_channel_access`, tạo cho **chính mình** trên trang mới `/settings/zalo-personal/link`.
- Xác nhận liên kết **hiển thị trên web** (trang tự làm mới trạng thái), không cần bot gửi tin trả lời. Nhờ vậy liên kết chạy được khi chức năng gửi vẫn đang tắt.
- Thu hồi gồm: admin thu hồi `ai_channel_access`, user tự thu hồi liên kết, profile bị khóa, role không còn hợp lệ. Mọi trường hợp đều có hiệu lực ở lần kiểm tra kế tiếp (tin nhắn, đọc ký ức, gửi nhắc việc).

---

## 4. D3 — Tin nhắn nhóm

### 4.1 Đối chiếu

- Không có gì hiện có để tái dùng trực tiếp: OA webhook chỉ xử lý `user_send_text` 1-1.
- `ai_messages` không có cột người gửi; `ai_conversations` gắn với **một** `internal_user_id` → **C7**: nhóm cần bảng riêng. Nhờ đó `recentTurns` và Web hoàn toàn không bị ảnh hưởng.
- Tái dùng: `foldVietnamese`, `routeMessage`, `MUTATION_REQUEST`, cơ chế dedupe bằng unique index, AI Engine, System Tools (chỉ các tool đánh dấu `groupSafe`).

### 4.2 Chế độ nhóm

| Chế độ | Lưu tin | Phân tích (task / tóm tắt) | Trả lời trong nhóm |
|---|---|---|---|
| `disabled` (mặc định cho nhóm mới) | không (chỉ lưu metadata nhóm: id, tên, lần thấy đầu) | không | không |
| `monitor` | có (khi đã ghi nhận đồng ý) | có, kết quả xem trên web | không |
| `mention_only` | chỉ tin **nhắc tới bot theo UID** + tối đa N tin ngữ cảnh trước đó | có, cho tin được nhắc | không (chỉ soạn nháp, xem trên web) |
| `interactive` | như `monitor` | có | **chỉ** khi bot được nhắc theo UID **và** cờ gửi toàn cục bật **và** nhóm đã qua checklist xác minh |

Quy tắc bắt buộc:
1. Bật bất kỳ chế độ nào khác `disabled` → cần `consent_status = 'granted'` (cách ghi nhận: ❗ C8 / Q6) và người bật có `integration:manage`.
2. Phát hiện nhắc tên **theo UID** từ dữ liệu mention của sự kiện (⚠️ cấu trúc mention của zca-js cần kiểm chứng), không theo tên hiển thị.
3. Bỏ qua tin do chính tài khoản bot gửi: so `sender_uid` với UID tài khoản, cộng thêm danh sách `provider_message_id` bot đã gửi.
4. **Không công khai dữ liệu nội bộ trong nhóm** chỉ vì người hỏi có quyền cá nhân. Câu trả lời trong nhóm chỉ được dùng:
   - dữ liệu của **chính nhóm đó**: tin nhắn, công việc, tóm tắt của nhóm;
   - các tool có cờ `groupSafe = true`. Mặc định **không** tool Shopee / công nợ nào có cờ này.
   Câu hỏi cần dữ liệu nội bộ → trả lời mẫu "Mình sẽ nhắn riêng cho bạn", và chỉ trả lời trong 1-1 nếu người hỏi đã liên kết và có quyền.
5. Không vượt cơ chế bảo vệ của Zalo:
   - không giải captcha, không xoay nhiều tài khoản, không giả lập thiết bị để né giới hạn;
   - dừng gửi khi Zalo báo hạn chế, chuyển trạng thái `restricted` và chờ người vận hành.
6. Lưu trữ có hạn: `retention_days` theo nhóm (mặc định đề xuất 30, Q7); job dọn dẹp xóa tin hết hạn.

---

## 5. Schema và ranh giới service đề xuất

### 5.1 Bảng mới

Áp dụng cho mọi bảng dưới đây:
- RLS bật, `REVOKE ALL FROM anon, authenticated`, `GRANT` tường minh cho `service_role` (đúng mẫu 00069/00072).
- Có `created_at` / `updated_at` + trigger `handle_updated_at`.
- Mọi cột text có giới hạn độ dài bằng CHECK.

**Nền tảng và danh tính** (`00073`, P01)

| Bảng | Cột chính | Ràng buộc chính |
|---|---|---|
| `workspaces` | `id`, `name`, `is_default` | partial UNIQUE (`is_default`) WHERE `is_default`; seed 1 dòng |
| `ai_channel_access` | `workspace_id`, `internal_user_id`, `channel` (`zalo_personal`), `status` (`active`/`revoked`), `granted_by`, `granted_at`, `revoked_by`, `revoked_at`, `revoked_reason` | PK (`internal_user_id`, `channel`); FK profiles ON DELETE CASCADE |
| `zalo_personal_accounts` | `workspace_id`, `zalo_uid`, `display_name`, `status` (`disconnected`/`connecting`/`connected`/`needs_relogin`/`restricted`/`disabled`), `enabled` (kill switch, mặc định false), `session_encrypted`, `lease_owner`, `lease_expires_at`, `last_heartbeat_at`, `last_error_code`, `login_requested_at` | UNIQUE (`zalo_uid`) |
| `zalo_personal_link_codes` | `workspace_id`, `account_id`, `code_hash` (64 hex), `internal_user_id`, `created_by`, `expires_at`, `used_at`, `used_by_zalo_uid` | UNIQUE (`code_hash`); CHECK `expires_at > created_at` |
| `zalo_personal_links` | `workspace_id`, `account_id`, `zalo_uid`, `internal_user_id`, `status` (`active`/`revoked`), `linked_at`, `revoked_at`, `revoked_reason` | UNIQUE (`account_id`, `zalo_uid`) |

Nới CHECK cho bảng cũ, chỉ cộng thêm giá trị: `ai_conversations.channel`, `ai_messages.channel`, `ai_usage_logs.channel` thêm `'zalo_personal'`. Thread 1-1 kênh personal: `external_user_id = zalo_uid` (một tài khoản bot, Q10).

**Nhóm** (`00075`, P07 — kèm thêm cột `ai_tasks.group_id` + FK)

| Bảng | Cột chính | Ràng buộc chính |
|---|---|---|
| `zalo_personal_groups` | `workspace_id`, `account_id`, `provider_group_id`, `name`, `mode` (4 giá trị, DEFAULT `'disabled'`), `consent_status` (`none`/`granted`/`withdrawn`, DEFAULT `'none'`), `consent_recorded_by`, `consent_recorded_at`, `consent_note`, `send_verified_at`, `retention_days`, `first_seen_at`, `mode_changed_by`, `mode_changed_at` | UNIQUE (`account_id`, `provider_group_id`); CHECK `mode = 'disabled' OR consent_status = 'granted'`; CHECK `mode <> 'interactive' OR send_verified_at IS NOT NULL` |
| `zalo_group_messages` | `workspace_id`, `group_id`, `direction` (`inbound`/`outbound`), `provider_message_id`, `sender_zalo_uid`, `sender_internal_user_id` (null nếu chưa liên kết), `is_from_self`, `mentions_self`, `text` ≤ 4000, `processing_status`, `expires_at` | partial UNIQUE (`group_id`, `provider_message_id`) WHERE inbound; index (`group_id`, `created_at`) |
| `zalo_group_mode_events` | `group_id`, `from_mode`, `to_mode`, `changed_by`, `reason`, `at` | chỉ ghi thêm (audit) |

**Bộ nhớ** (`00076`, P08)

| Bảng | Cột chính | Ràng buộc chính |
|---|---|---|
| `ai_memories` | `workspace_id`, `channel`, `access_scope` (`private`/`group`), `owner_user_id`, `conversation_id`, `group_id`, `kind` (`fact`/`preference`/`summary`/`task_context`), `content` ≤ 1000, `source_ref`, `created_by` (`ai`/`user`/`admin`), `confidence`, `expires_at`, `deleted_at` | CHECK: `private` ⇒ `owner_user_id` + `conversation_id` NOT NULL, `group_id` NULL; `group` ⇒ `group_id` NOT NULL, `conversation_id` NULL. Index (`workspace_id`, `channel`, `conversation_id`) và (`group_id`) WHERE `deleted_at IS NULL` |

**Công việc và nhắc việc** (`00074`, P06 — `group_id` thêm ở 00075)

| Bảng | Cột chính | Ràng buộc chính |
|---|---|---|
| `ai_tasks` | `workspace_id`, `owner_user_id`, `assignee_user_id`, `channel`, `conversation_id`, `group_id`, `access_scope`, `title` ≤ 300, `notes` ≤ 2000, `due_at`, `due_precision` (`date`/`datetime`), `status` (`proposed`/`open`/`done`/`cancelled`), `confirmed_at`, `completed_at`, `version` (tăng khi đổi hạn), `source_ref`, `created_by` | CHECK `status <> 'open' OR confirmed_at IS NOT NULL` (AI chỉ tạo `proposed`; người dùng xác nhận mới thành `open`) |
| `ai_reminder_schedules` | `workspace_id`, `owner_user_id`, `task_id` (null với MORNING), `kind` (`DAY`/`HOUR`/`OVERDUE`/`MORNING`), `scheduled_for`, `local_date` (ngày VN), `task_version`, `target_channel`, `target_ref`, `idempotency_key`, `status`, `attempts`, `max_attempts`, `next_attempt_at`, `claimed_by`, `claimed_at`, `lease_expires_at`, `send_started_at`, `sent_at`, `provider_message_id`, `outcome_reason`, `last_error_code` | UNIQUE (`idempotency_key`); partial UNIQUE (`owner_user_id`, `kind`, `local_date`) WHERE `kind IN ('MORNING','OVERDUE')`; index (`status`, `next_attempt_at`) |
| `ai_reminder_events` | `schedule_id`, `event`, `from_status`, `to_status`, `worker_id`, `detail` (jsonb ≤ 2 KB, không chứa nội dung tin), `at` | chỉ ghi thêm (audit) |

`ai_reminder_schedules.status` ∈ `pending`, `claimed`, `sending`, `sent`, `skipped`, `failed`, `unknown`, `cancelled`. "Lỗi có thể retry" không phải một trạng thái: lịch quay về `pending` với `next_attempt_at` lùi lại.

`idempotency_key` = `{kind}:{task_id|owner_user_id}:{task_version}:{scheduled_for ISO}`. Đổi hạn → `version` tăng → lịch cũ bị `cancelled` → lịch mới có key mới.

### 5.2 Máy trạng thái của lịch nhắc (D4)

```
pending ──claim (SKIP LOCKED, lease)──► claimed ──đánh giá chính sách──► skipped (outcome_reason)
   ▲                                       │
   │ retry (backoff, lỗi xác định)          └─ được gửi ──► sending ──► sent
   │                                                          │
   └──────────── (về pending, lùi next_attempt_at) ◄──────────┤ lỗi chắc chắn CHƯA gửi
                                                              │
                     failed (hết lượt) ◄──────────────────────┤
                     unknown  ◄───────────────────────────────┘ timeout / mất kết nối SAU khi gọi gửi
                     cancelled ◄── task đổi hạn / done / thu hồi quyền (bất kỳ lúc nào trước khi sending)
```

- **Atomic claiming:** RPC `claim_due_reminders(p_worker, p_limit, p_lease_seconds)`. Chỉ lấy dòng `pending` có `next_attempt_at <= now()`, dùng `FOR UPDATE SKIP LOCKED`, đặt `claimed_by` + `lease_expires_at`. Mẫu lấy từ `claim_next_sync_job`.
- **Bắt đầu gửi:** `mark_reminder_sending(id, worker)` chỉ thành công nếu `claimed_by = worker` và lease còn hạn, đặt `send_started_at` **trước** khi gọi Zalo.
- **Recovery khi worker restart:** `recover_stale_reminders()`:
  - `claimed` mà lease hết hạn → `pending`, an toàn vì chưa gọi gửi;
  - `sending` mà lease hết hạn → `unknown`, **không** retry tự động.
- **Retry có backoff:** chỉ với lỗi biết chắc là chưa gửi (chưa kết nối, Zalo trả lỗi rõ ràng). Backoff đề xuất 1 → 5 → 15 phút, tối đa 3 lần. Mỗi lần retry **đánh giá lại chính sách gửi bù**, nên trễ quá ngưỡng sẽ thành `skipped`.
- **`unknown`:** hiện trên trang giám sát. Admin chọn "đánh dấu đã gửi" hoặc "bỏ"; không có nút gửi lại tự động.

### 5.3 Chính sách gửi bù (hàm thuần `decideReminderDelivery`)

Đầu vào: `kind`, `scheduled_for`, `now`, trạng thái task (`status`, `due_at`, `version`), `task_version` của lịch, quyền người nhận (active, quyền kênh, liên kết). `lateness = now − scheduled_for`.

| Thứ tự | Điều kiện | Kết quả |
|---|---|---|
| 1 | người nhận bị khóa / mất quyền kênh / liên kết bị thu hồi | `skip: access_revoked` |
| 2 | task `done` hoặc `cancelled` | `skip: task_closed` |
| 3 | `task_version` ≠ `version` hiện tại | `skip: superseded` |
| 4 | DAY hoặc HOUR và `now ≥ due_at` | `skip: past_deadline` |
| 5 | DAY và `lateness < 60 phút` | `send` |
| 6 | DAY và `lateness ≥ 60 phút` | `skip: too_late` |
| 7 | HOUR và `lateness < 15 phút` | `send` |
| 8 | HOUR và `lateness ≥ 15 phút` | `skip: too_late` |
| 9 | MORNING và giờ VN hiện tại < 10:00 **và** cùng `local_date` | `send` |
| 10 | MORNING còn lại | `skip: morning_window_closed` |
| 11 | OVERDUE và còn ≥ 1 task của người đó đang quá hạn | `send` **một** tin tổng hợp. Các OVERDUE khác cùng người, cùng ngày → `skip: collapsed` |
| 12 | OVERDUE và không còn task quá hạn | `skip: nothing_overdue` |

Ngưỡng là hằng số cấu hình được. Ranh giới: "dưới 1 giờ" = `< 60:00`; trễ đúng 60 phút là **bỏ**.

### 5.4 Ranh giới service

```
                      ┌───────────── Transport (theo kênh) ─────────────┐
  Zalo OA webhook ───►│ src/lib/zalo/**  (KHÔNG ĐỔI)                     │
  Web /apps/shopee/ai►│ src/lib/conversation/web.ts (KHÔNG ĐỔI)          │
  zca-js listener ───►│ workers/zalo-personal/* + src/lib/zalo-personal/ │
                      └───────────────┬──────────────────────────────────┘
                                      ▼
            ┌─── Conversation (1-1) ─────────────┐   ┌── Group service ─────────────┐
            │ conversation/service.ts + ChannelPolicy │  │ zalo-personal/groups.ts       │
            │ (thread theo kênh, liên kết, quyền)│   │ (chế độ, đồng ý, mention UID) │
            └───────────────┬────────────────────┘   └──────────────┬───────────────┘
                            ▼                                      ▼
            ┌──────────── AI Engine (dùng chung) ───────────────────────────────┐
            │ ProductAnalystProvider.run contract · Claude | Gemini | Fake       │
            │ ai/assistant.ts (trò chuyện chung, trích xuất có schema)           │
            │ ai/tools/registry.ts ── System Tools (authorize backend mỗi lần)   │
            │ ai/memory/* (lọc workspace+channel+conversation/group+owner)       │
            │ ai/retrieval.ts (interface Retriever — chưa có triển khai RAG)     │
            └───────────────┬───────────────────────────────────────────────────┘
                            ▼
            ┌── Tasks & Reminders ───────────────┐   ┌── Outbound ─────────────────┐
            │ tasks/* · reminders/policy.ts (thuần)│──►│ OutboundSender theo kênh      │
            │ RPC claim / sending / recover      │   │ (cờ gửi mặc định TẮT)         │
            └────────────────────────────────────┘   └───────────────────────────────┘
```

| Module | Trách nhiệm | Không được làm |
|---|---|---|
| `src/lib/conversation/channels.ts` (mới) | `ChannelPolicy`: role được phép, có cần `ai_channel_access` không, hành vi với người chưa liên kết, độ dài tối đa, sender | không chứa logic kênh OA mới; mặc định `zalo`/`web` = hành vi hiện tại |
| `src/lib/ai/tools/registry.ts` (mới) | khai báo tool: `name`, schema, `requiredPermission`, `allowedChannels`, `groupSafe`, `authorize(ctx)`, `execute(ctx)`. Bọc 7 tool hiện có, **không viết lại** | không nhận `internalUserId`/role từ model; `ctx` do backend dựng từ liên kết |
| `src/lib/ai/memory/` (mới) | chọn/ghép/giới hạn ký ức; store chỉ có hàm đọc **trong phạm vi** | không có hàm đọc chéo kênh |
| `src/lib/zalo-personal/` (mới) | chuẩn hóa sự kiện, chính sách nhóm, mention theo UID, lọc tin của bot | không gửi tin |
| `src/lib/tasks/`, `src/lib/reminders/` (mới) | task (đề xuất → xác nhận), lịch, chính sách gửi bù, máy trạng thái | không gọi Zalo trực tiếp |
| `workers/zalo-personal/` (mới) | phiên, listener, lease, dispatcher nhắc việc, sender có giới hạn tốc độ | không import module `server-only` / alias `@/` |

---

## 6. Thay đổi trên đường code dùng chung (phải chứng minh không đổi hành vi)

| File | Thay đổi | Bảo đảm |
|---|---|---|
| `src/lib/conversation/service.ts` | `ConversationChannel` thêm `"zalo_personal"`; `ConversationDeps.policy?` (tùy chọn). Không truyền thì dùng chính sách mặc định = `CONVERSATION_ALLOWED_ROLES` + thông báo "chưa liên kết" 24h như hiện tại | toàn bộ `conversation.test.ts`, `conversation.integration.test.ts` chạy **không sửa** test cũ |
| `src/lib/conversation/supabase-store.ts` | `findLink` / `createLink` / `consumeLinkCode`: thêm nhánh `zalo_personal` → bảng mới; nhánh `zalo` giữ nguyên từng dòng | như trên + test mới cho nhánh personal |
| `src/lib/product-analytics/agent-tools.ts` | `authorizeShopTool` / `authorizeProductTool` nhận `allowedRoles` tùy chọn (mặc định = hằng số hiện tại) | `product-analyst.test.ts` + integration, ma trận quyền giữ nguyên |
| `src/lib/product-analyst/config.ts` | provider dùng allowlist (`anthropic` \| `gemini` \| `fake`); giá trị lạ → lỗi cấu hình rõ ràng, không âm thầm dùng Claude | test cấu hình mới; giá trị mặc định không đổi |
| `src/lib/auth/permissions.ts` | thêm `assistant:zalo_personal` (admin, staff) | `permissions.test.ts`; không quyền nào cũ thay đổi |

Không đụng: `src/lib/zalo/**`, `src/app/api/zalo/**`, `src/lib/notifications/**`, `src/lib/conversation/web.ts`, `/settings/zalo-agent`, `/settings/notifications`, migration 00001–00072.

---

## 7. Xung đột với tài liệu hiện có (báo trước, **chưa sửa** các tài liệu đó)

| Tài liệu | Nội dung hiện tại | Quan hệ với quyết định | Đề xuất |
|---|---|---|---|
| `docs/product-analyst-agent.md` (đầu file, "Rollout") | "the role must be in `CONVERSATION_ALLOWED_ROLES` (admin today)… The grants apply to both Zalo and web." | D2 cho Staff dùng ở kênh personal | **Không mâu thuẫn** nếu áp dụng §3.2: OA/Web vẫn admin. Khi phase 02 xong, thêm một dòng nói kênh personal có chính sách riêng |
| `docs/product-analyst-agent.md` (Channels / Web) | "Thread: one per user, separate from Zalo." | D1 | **Khớp**. Không cần sửa |
| `docs/zalo-ai-agent-architecture.md` §3 | "Early rollout: `CONVERSATION_ALLOWED_ROLES = ["admin"]`… checked when a code is consumed and on every message" | D2 | Đúng cho OA, giữ nguyên. Chính sách personal ghi trong tài liệu này |
| `docs/zalo-ai-agent-architecture.md` §2 | `ai_conversations` "One per (channel, external user)" | D3 (nhóm) | Nhóm **không** dùng `ai_conversations` (§4.1) → không mâu thuẫn |
| `docs/zalo-ai/architecture-audit.md` (Phase 00) | E.4 "bỏ qua tin nhóm"; E.5 schema sơ bộ; E.6 flag `ZALO_PERSONAL_GROUPS_ENABLED`; T9/T10 và J.2 mục 10 là câu hỏi mở | D1–D4 trả lời các câu hỏi đó | **Đã cập nhật** tài liệu này: ghi chú thay thế, trỏ sang đây |

---

## 8. Quyết định còn cần xác nhận

| # | Câu hỏi | Đề xuất mặc định nếu không có ý kiến khác |
|---|---|---|
| Q1 | "Owner" là admin hiện có, hay cần role mới? | Owner = admin, không thêm role |
| Q2 | Thêm bảng `workspaces` (1 dòng mặc định) cho bảng mới, chưa thêm cột vào bảng `ai_*` cũ? | Đồng ý như đề xuất |
| Q3 | RAG dùng chung là RAG trên dữ liệu nào? Project có bật được pgvector không? | Chưa xây RAG; chỉ định nghĩa interface |
| Q4 | "Chức năng công khai" cho người chưa liên kết gồm những gì? | Rỗng: im lặng, không lưu nội dung |
| Q5 | Staff có được dùng tool Shopee (phân tích shop/sản phẩm) qua kênh personal không? | Không; Staff chỉ dùng công việc / nhắc việc / hỏi đáp chung |
| Q6 | "Sự đồng ý phù hợp" của nhóm ghi nhận thế nào: admin xác nhận + ghi chú, hay phải có thông báo trong nhóm (cần gửi tin)? | Admin xác nhận bằng văn bản trên UI + ghi chú; thông báo trong nhóm để sau khi bật gửi |
| Q7 | Thời gian lưu tin nhóm? Có lưu tin của thành viên chưa liên kết ở chế độ monitor không? | 30 ngày; có lưu (cần cho tóm tắt), nhưng không dùng cho ký ức `private` |
| Q8 | DAY = nhắc trước hạn 1 ngày lúc mấy giờ? HOUR = trước 1 giờ? MORNING = mấy giờ, nội dung gì? | DAY = 08:00 ngày trước hạn; HOUR = hạn − 60 phút; MORNING = 07:30 tóm tắt việc hôm nay |
| Q9 | OVERDUE "một cảnh báo tổng hợp": tổng hợp theo người/ngày? Lặp lại mỗi ngày không? | 1 tin/người/ngày lúc 09:00, liệt kê mọi task quá hạn |
| Q10 | Chỉ một tài khoản Zalo bot? | Một tài khoản |
| Q11 | Task phát hiện trong nhóm: nhắc ở nhóm hay nhắn riêng người được giao? | Nhắn riêng, nếu người đó đã liên kết |
| Q12 | Ai được đổi chế độ nhóm và ghi nhận đồng ý? | Chỉ admin (`integration:manage`) |
| Q13 | Khi khóa user: chỉ chặn lúc dùng (như OA hiện tại), hay hủy luôn lịch nhắc đang chờ? | Chặn lúc dùng (bắt buộc) + job dọn dẹp chuyển lịch sang `cancelled: access_revoked` |
| Q14 | Lỗi `unknown` có cần thông báo admin qua Zalo OA không? Nếu có thì phải thêm một event type vào `src/lib/notifications/event-types.ts` (đây là module OA nằm trong danh sách "không đụng") | Chưa: chỉ hiển thị trên trang giám sát. Nếu bật sau này → thay đổi 1 dòng, cần chủ dự án duyệt riêng |
