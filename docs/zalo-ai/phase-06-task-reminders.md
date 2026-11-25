# Phase 06: AI Task Detection & Smart Reminder Engine

> Đọc kèm: [phase-04-ai-memory.md](phase-04-ai-memory.md) (Gemini provider, budget, data policy) · [phase-05-system-assistant.md](phase-05-system-assistant.md) (`ai_channel_identities`) · [phase-03-dashboard.md](phase-03-dashboard.md) (phạm vi owner/grant) · [decisions.md](decisions.md) §5.2–5.3 (máy trạng thái lịch nhắc, chính sách gửi bù).
> Code nằm ở:
> - logic: `src/lib/ai-tasks/**`
> - migration: `supabase/migrations/00078_ai_tasks_reminders.sql`
> - API: `src/app/api/zalo-personal/{tasks,notifications,reminders}/**` và `src/app/api/internal/ai-tasks/tick`
> - trang: `/apps/zalo/personal/tasks/**` và `/apps/zalo/personal/notifications`
>
> Trạng thái: **chạy được ở local, mặc định tắt** (`AI_TASKS_ENABLED=false`). Chưa deploy, chưa áp 00078 lên cloud, chưa gửi tin Zalo thật.

Hệ thống đọc các tin Zalo Personal đã được phép lưu từ Phase 02–04 và làm các việc sau:

- nhận ra khi một người được nhắc tên theo UID;
- nhận ra tin có dấu hiệu giao việc;
- trích xuất công việc. Kết quả luôn ở trạng thái `pending_confirmation`, chỉ người quản lý mới kích hoạt được;
- nhắc việc DAY, HOUR, OVERDUE và MORNING qua hộp thư Web. Khi bộ chạy nền gián đoạn, nhắc việc được gửi bù theo một chính sách có kiểm soát.

AI không có hành động nào thay đổi hệ thống. Không có tin Zalo nào được gửi đi.

## 1. Kiến trúc Task Engine

```
pg_cron (Supabase, mỗi phút) ──net.http_post──► POST /api/internal/ai-tasks/tick  (Vercel, Bearer internal secret)
                                                     │  runTick(): ngân sách thời gian, dừng giữa các bước khi hết giờ / bị hủy
   1 scan     ai_task_scan_claim (lease) → ai_task_scan_messages → detect.ts (mention + candidate)
              → ai_task_scan_commit (1 transaction: mention, candidate, thông báo, con trỏ)
   2 extract  ai_task_claim_candidates (SKIP LOCKED + lease) → kiểm tra lại chính sách nhóm
              → Gemini (extractor.ts, qua provider Phase 04 + zp_ai_reserve) hoặc bộ quy tắc
              → ai_task_store_extraction (task pending_confirmation + nguồn + người được giao + thông báo xác nhận)
   3 overdue  ai_task_mark_overdue (accepted / in_progress quá hạn + 5 phút)
   4 morning  ai_reminder_ensure_morning (MORNING hôm nay trước 10:00 / ngày mai sau 18:00)
   5 remind   ai_reminder_claim (thu hồi lease hết hạn → SKIP LOCKED) → reminders.ts decideDelivery
              → ai_reminder_resolve (hộp thư + trạng thái cuối trong CÙNG transaction)
Dashboard (Next.js, session) ── service.ts ── ai_task_list / ai_task_apply (revision, lập lại lịch nhắc, audit)
```

| Module | Trách nhiệm |
|---|---|
| `detect.ts` | MentionDetector (chỉ dựa vào metadata UID) và TaskCandidateDetector (quy tắc tiếng Việt, không gọi model) |
| `deadline.ts` | DeadlineResolver: cụm từ chỉ hạn → thời điểm UTC, mốc là giờ của tin nhắn, đánh dấu mọi giả định |
| `extractor.ts` | Prompt (chỉ có nhãn, không có id), schema Zod strict, bộ kiểm tra chống bịa, trích xuất theo quy tắc |
| `lifecycle.ts` | Trạng thái, chuyển trạng thái, vai trò theo từng task (manager / assignee / reader) |
| `reminders.ts` | ReminderPlanner và chính sách gửi bù `decideDelivery` (hàm thuần) |
| `channels.ts` | Web Inbox; adapter Zalo (interface + cổng an toàn; chưa có bộ gửi thật) |
| `engine.ts` | Tick chạy nền |
| `service.ts` | Dashboard: danh sách, chi tiết, hành động, hộp thư, cài đặt, lịch sử |
| `access.ts` | Quyền xem task suy ra từ phạm vi Phase 03 (owner/grant), tính lại ở mỗi request và mỗi tick |

Các thành phần dùng lại từ phase trước (không viết lại):

| Thành phần | Nguồn |
|---|---|
| Tin nhắn, nhóm, chế độ, đồng ý | `zalo_personal_*` (00073 / 00074). Không sửa |
| Phạm vi đọc | `buildScope` / `canReadConversation` / `can(…, "manage_groups")` (Phase 03) |
| Liên kết UID → người dùng | `ai_channel_identities` (00077, mã liên kết một lần) |
| Gemini | `AiTextProvider`, `generateWithRetry`, `FakeAiProvider`, `sharingDecision`, `redact` (Phase 04) |
| Budget | `zp_ai_reserve` / `zp_ai_finish`, dùng chung bảng `ai_request_usage` (thêm feature `task_extract`) |
| Lịch chạy | Cùng cơ chế pg_cron + pg_net + Vault như 00050 (Shopee scheduler) |
| Bí mật nội bộ | `isAuthorizedInternalRequest` |

Module `src/lib/notifications/**` hiện tại không được dùng lại. Lý do: đây là module **phát tin Zalo OA** tới một danh sách người nhận cố định (`notification_recipients` / `notification_logs`), không phải hộp thư riêng của từng người dùng web. Phase 06 thêm `user_notifications` (hộp thư) và `notification_deliveries` (trạng thái theo kênh), còn module OA giữ nguyên.

## 2. Phát hiện mention (TASK-01)

- **Căn cứ:** metadata `mentions` `{uid, pos, len, kind}` do zca-js cung cấp (worker lưu vào `zalo_personal_messages.mentions`) cùng cờ `mentions_self`. Metadata được kiểm tra lại: UID phải là số và vị trí phải nằm trong văn bản.
- **Quy đổi UID sang người dùng:** chỉ có hai trường hợp:
  - UID là chính tài khoản của kết nối → chủ kết nối;
  - UID có liên kết `active` trong `ai_channel_identities`.

  Tên hiển thị không bao giờ được dùng để quy đổi, nên hai người cùng tên "Minh" không bị nhầm (có test).
- **"@Minh" gõ tay, không có metadata:** chỉ là gợi ý (+1 điểm cho bộ phát hiện ứng viên), không tạo mention, không gửi thông báo.
- **Reply / quote:** contract của connector (Phase 02) chưa có metadata trích dẫn, nên **chưa phát hiện**. Hệ thống không đoán.
- **Phạm vi:** chỉ nhóm có `mode ≠ disabled` và `consent_status = granted`, xét theo **chế độ hiện tại** lúc quét. Nhóm bị tắt sau khi tin đã lưu thì cũng không được xử lý (có test).
- **Chống trùng:** `UNIQUE (message_id, mentioned_external_id)`. Khóa thông báo là `mention:{message}:{user}`. Khi connector phát lại sự kiện, ingest trả `duplicate`; quét lại thì không sinh dòng mới (có test).
- **Ai nhận thông báo:** người dùng đã quy đổi được, có quyền xem hội thoại, đang hoạt động và không tắt `mention_enabled`.
  - Thông báo **không chứa nội dung tin**.
  - Không thông báo cho người tự nhắc chính mình.
  - Không thông báo cho chủ kết nối khi tin đó do chính chủ tài khoản gửi.

## 3. Ứng viên và schema trích xuất (TASK-02/03)

### 3.1 Bộ phát hiện ứng viên

Bộ phát hiện chạy trên văn bản đã bỏ dấu và không gọi model. Bảng cộng/trừ điểm:

| Dấu hiệu | Điểm |
|---|---|
| Động từ giao việc (kiểm tra, gửi, xác nhận, cập nhật, xử lý, báo cáo…) | +2 |
| Động từ yếu (làm, xem, lo) | +1 |
| Lời nhờ ("giúp", "nhé", "nhớ", "anh ơi"…) | +1 |
| Câu hỏi phân công ("ai phụ trách / ai làm…") | +3 |
| Có cụm chỉ hạn | +2 |
| Có mention bằng metadata | +2 |
| Chỉ có "@Tên" gõ tay | +1 |
| Câu suy đoán ("chắc", "có lẽ", "nếu"…) | −2 |
| Báo đã xong ("xong rồi", "đã gửi"…) | −3 |

Một tin là ứng viên khi đạt **≥ 3 điểm và có hành động** (động từ hoặc câu hỏi phân công). Các trường hợp bị bỏ qua:

- tin bắt đầu bằng `[Nhắc việc]` (chống vòng lặp);
- tin không thuộc diện được phép lưu (cột `eligible` do SQL tính từ chính sách hiện tại).

Chi phí và chống lặp:

- Mỗi tin chỉ được phân tích một lần (`UNIQUE (message_id)`).
- Mỗi kết nối có giới hạn `AI_TASKS_MAX_CANDIDATES_PER_DAY` (mặc định 200) ứng viên mỗi ngày. Vượt mức → `skipped daily_cap`.
- Con trỏ quét `(ingested_at, id)` lưu nguyên chuỗi thời gian của Postgres (giữ microsecond) và lùi 10 giây so với hiện tại, để không bỏ sót tin đang được ingest song song.

### 3.2 Gọi Gemini

Mỗi lần gọi xử lý một hội thoại, tối đa 5 ứng viên, kèm tối đa 6 tin ngữ cảnh trước đó và tối đa 10 việc đang mở (đánh nhãn `K…`). Model chỉ được gọi khi đủ các điều kiện:

- `AI_TASKS_AI_EXTRACTION_ENABLED` và `AI_ENABLED` đều bật;
- provider đã cấu hình;
- `sharingDecision()` cho phép;
- chưa vượt `AI_TASKS_MAX_EXTRACTIONS_PER_DAY` (mặc định 30);
- `zp_ai_reserve` còn hạn mức (budget chung, tính cho chủ kết nối).

Chỉ cần thiếu một điều kiện, hoặc model lỗi hay trả sai schema, hệ thống chuyển sang **bộ quy tắc** (`AI_TASKS_RULES_FALLBACK`, mặc định bật):

- tiêu đề là chính văn bản của tin;
- người được giao chỉ lấy từ metadata mention;
- hạn lấy từ resolver;
- `confidence = 0.3`, ghi `missing = ai_not_used`.

### 3.3 Prompt

- **Nhãn thay cho id:** prompt chỉ có nhãn. `[M1]` là tin (ứng viên đánh dấu `(*)`), `U1…` là người gửi/người được nhắc, `@[U3]` là mention viết lại từ metadata, `K1` là việc đang mở. Prompt không chứa UID và không chứa id tin (có test).
- **Ranh giới dữ liệu:** nội dung tin chỉ nằm giữa `<<DATA>>` và `<<END>>`. System prompt nói rõ đó là dữ liệu, không phải chỉ dẫn.

### 3.4 Schema đầu ra (Zod strict)

Tương ứng với gợi ý trong spec:

| Spec | Schema |
|---|---|
| title | `title` (đã làm sạch, ≤ 200) |
| description | `description` |
| assignor_external_id | `assignorRef` (nhãn U) → UID, chỉ nhận khi là người gửi một tin được trích |
| assignee_external_ids | `assigneeRefs` (nhãn U) → UID |
| source_conversation_id / source_message_ids | `sourceRefs` (nhãn M) → id tin; phải có ít nhất một tin ứng viên |
| deadline / timezone | `deadlinePhrase` **nguyên văn**. Server tự quy đổi bằng `deadline.ts`, múi giờ `Asia/Ho_Chi_Minh` |
| priority_suggestion | `priority` |
| confidence | `confidence` |
| missing_information | `missing` (assignee / deadline / details) |
| evidence | `evidence[{ref, quote}]` |
| `no_task` / `needs_clarification` / nhiều task | `status` + `tasks[]` (≤ 8) + `deadlineChanges[]` |

### 3.5 Bộ kiểm tra kết quả (`validateExtraction`)

- **Suy đoán:** `isDecision = false` → bỏ.
- **Bằng chứng:** cần ≥ 1 đoạn `quote` xuất hiện **nguyên văn** (đã bỏ dấu) trong tin được trích. Không có → bỏ task.
- **Người được giao:** chỉ nhận nếu người đó được mention bằng metadata trong tin được trích, **hoặc** chính người gửi tự nhận việc ("em sẽ…", "để em…"). Nếu không: bỏ người đó và ghi `missing = assignee`. Model không thể gán trách nhiệm cho ai chỉ vì tên người đó xuất hiện trong tin.
- **Hạn:** cụm `deadlinePhrase` phải nằm trong tin được trích và được quy đổi với mốc là giờ của **chính tin đó**. Nếu không: không đặt hạn và ghi `missing = deadline`.
- **Prompt injection:** schema không có trường trạng thái hay hành động. Khóa lạ (ví dụ `status: completed`) hoặc văn bản tự do → toàn bộ câu trả lời bị từ chối và chuyển sang bộ quy tắc. Task vẫn ở `pending_confirmation`; SQL cũng chỉ tạo được `pending_confirmation`.
- **Đổi hạn (`deadlineChanges`):** chỉ nhận khi lấy từ tin ứng viên, có cụm nguyên văn và hạn mới khác hạn cũ. Kết quả chỉ là **đề xuất** `proposed_deadline_*`; hạn đã xác nhận không tự thay đổi.
- **Chính sách dữ liệu:** `AI_DATA_SHARING_POLICY=none` hoặc Gemini gói miễn phí chưa được duyệt → không gửi gì (có test). `redacted` → che số điện thoại, email, số dài… trước khi gửi.

## 4. Vòng đời task (TASK-05)

```
pending_confirmation ──confirm──► accepted ──start/progress──► in_progress
        │                            │   ╲                          │
        └─dismiss─► dismissed        │    ╲(quá hạn + 5′, hệ thống)─► overdue
                       └─reopen─► pending_confirmation
accepted | in_progress | overdue ──complete──► completed ──reopen──► accepted / in_progress / overdue
accepted | in_progress | overdue ──cancel────► cancelled ──reopen──► (như trên)
edit (tiêu đề, mô tả, người được giao, hạn) ở mọi trạng thái mở; dời hạn ra tương lai → overdue trở lại accepted/in_progress
```

| Hành động | Từ trạng thái | Ai được làm |
|---|---|---|
| confirm / dismiss | pending_confirmation | manager |
| edit, accept_proposal / reject_proposal | các trạng thái mở và pending | manager |
| start | accepted | manager, assignee |
| progress / complete | accepted, in_progress, overdue | manager, assignee |
| cancel | accepted, in_progress, overdue | manager |
| reopen | completed, cancelled, dismissed | manager |

Các vai trò:

- **manager:** chủ kết nối, hoặc người có grant `manage` cấp kết nối;
- **assignee:** người được giao đã quy đổi được (chủ tài khoản / liên kết đã xác minh / gán tay) và có quyền xem hội thoại;
- **reader:** chỉ có quyền xem hội thoại;
- **người khác:** task không tồn tại với họ (404).

Quy tắc bổ sung:

- AI và hệ thống không bao giờ xác nhận, hoàn thành hay hủy task.
- Tin "xong rồi" trong nhóm không làm task hoàn thành: bộ phát hiện trừ điểm và không có luồng tự hoàn thành.
- Mọi thay đổi đi qua `ai_task_apply`. Kiểm tra `revision` (sai → 409), cột được ghi nằm trong whitelist, việc lập lại lịch nhắc và dòng audit đều trong **một** transaction.
- `ai_task_activity` chỉ được ghi thêm: trigger chặn mọi UPDATE (có test).
- Không bảng nghiệp vụ nào bị đụng tới.

## 5. Chính sách hạn (TASK-04)

Mốc thời gian là **giờ của tin nguồn**, theo múi giờ Asia/Ho_Chi_Minh (UTC+7 cố định, không có giờ mùa hè). Database lưu `deadline_at` dạng UTC, kèm `deadline_timezone`, cụm gốc `deadline_phrase` và độ chính xác:

| Cụm từ | Kết quả | Độ chính xác | Giả định? |
|---|---|---|---|
| "17h hôm nay", "trước 17h", "5 giờ chiều mai", "2 tiếng nữa" | đúng giờ đó | exact | không |
| "9h" khi tin được gửi lúc 10:00 | 09:00 ngày hôm sau | exact | **có** |
| "chiều mai", "sáng thứ Hai", "chiều nay" | sáng 11:00, trưa 12:00, chiều 17:00, tối 21:00, đêm 23:00 | day_part | **có** |
| "mai", "thứ Sáu", "ngày 28", "28/11" | 23:59 ngày đó | date | **có** |
| "trước thứ Sáu", "trước ngày 28" | 23:59 ngày liền trước | date | **có** |
| "trong tuần này", "cuối tuần", "cuối tháng", "tuần sau" | 23:59 ngày cuối của khoảng | range | **có** |

Quy tắc chung:

- **Hạn có giả định:** mọi giả định đều có câu giải thích kèm theo. Trên UI, hạn hiển thị "(giả định, cần xác nhận)" cho tới khi người quản lý xác nhận hoặc sửa.
- **Từ mơ hồ:** "này", "tới", "sang" chỉ được hiểu là thời gian khi đứng cạnh một từ không mơ hồ. "tối" và "tới" đều thành "toi" khi bỏ dấu, nên "8h tối" là 20:00, không phải "8 tiếng tới". Ngày không tồn tại (31/11) cho kết quả null.
- **Hạn đã xác nhận** không đổi khi có tin mới. Tin mới chỉ tạo đề xuất, người quản lý chọn "Áp dụng hạn mới" hoặc "Giữ hạn cũ".

## 6. Database migration: `00078_ai_tasks_reminders.sql`

Migration chỉ **thêm mới**. Thay đổi duy nhất trên đối tượng cũ:

- CHECK `ai_request_usage.feature` thêm giá trị `task_extract`, theo đúng cách 00077 đã làm;
- một index mới `idx_zalo_personal_messages_scan (connection_id, ingested_at, id)`.

Các migration đã áp dụng không bị sửa.

| Bảng | Vai trò | Phạm vi / ràng buộc chính |
|---|---|---|
| `ai_task_scan_state` | con trỏ quét + lease theo kết nối | PK `connection_id` |
| `ai_mention_events` | mention theo UID (chỉ metadata) | UNIQUE (message, uid); FK tổ hợp (conversation, connection) |
| `ai_task_candidates` | hàng đợi trích xuất (lease, lần thử) | UNIQUE `message_id`; CHECK processing ⇔ lease |
| `ai_tasks` | task | `dedupe_key` UNIQUE; CHECK trạng thái hoạt động ⇒ `confirmed_at`; `version` (lịch nhắc), `revision` (đồng thời) |
| `ai_task_source_messages` | nguồn: task ↔ tin | PK (task, message) |
| `ai_task_assignments` | UID trong chat **hoặc** người dùng gán tay | CHECK chỉ một trong hai; UNIQUE từng loại |
| `ai_task_recipients` | người nhận nhắc việc (assignee / confirmer) | PK (task, user) |
| `ai_task_activity` | audit, chỉ ghi thêm | trigger chặn UPDATE |
| `ai_reminder_preferences` | cài đặt theo người dùng | PK `user_id` |
| `ai_reminder_schedules` | một dòng cho mỗi **lần nhắc** | `idempotency_key` UNIQUE; CHECK claimed ⇔ lease |
| `user_notifications` | Web Inbox | `dedupe_key` UNIQUE; `link` chỉ trong `/apps/zalo/personal/` |
| `notification_deliveries` | trạng thái theo kênh | UNIQUE (notification, channel) |
| `ai_task_worker_runs` | mỗi tick một dòng (giám sát) | tự xóa sau 14 ngày |

**Phạm vi tenant:** ứng dụng này không có bảng workspace (single tenant, xem decisions C1). **Kết nối** (thuộc một profile) là ranh giới, giống 00073:

- mọi dòng task, mention và candidate đều mang `connection_id` + `conversation_id` với FK tổ hợp;
- SQL kiểm tra mọi tin nguồn phải thuộc đúng hội thoại của task;
- tin Zalo Personal không bao giờ trộn với Web Conversation (`ai_conversations` / `ai_messages`).

**Quyền:**

- Mọi bảng bật RLS, không cấp gì cho `anon` / `authenticated`; quyền cấp tường minh cho `service_role` (cloud không có default grant).
- Hàm `ai_tasks_cron_tick` chỉ `postgres` (pg_cron) gọi được.

**Hàm:** `ai_task_scan_claim/messages/commit/release`, `ai_task_claim_candidates`, `ai_task_context`, `ai_task_store_extraction`, `ai_task_apply`, `ai_task_list`, `ai_task_open_for_user`, `ai_task_mark_overdue`, `ai_reminder_claim/resolve/retry/ensure_morning`, `ai_task_health`, `ai_notify_insert`, `ai_task_assignee_user`.

## 7. Lịch nhắc (TASK-07)

- **Chỉ lập lịch cho task đã xác nhận:** `accepted` / `in_progress` và có hạn. Mỗi người nhận có các lần nhắc:
  - **DAY:** trước hạn 24 giờ;
  - **HOUR:** trước hạn 1 giờ;
  - **OVERDUE:** sau hạn 5 phút.

  Mốc nào đã qua thì không tạo. Cài đặt của từng người được tôn trọng.
- **MORNING:** 08:00 giờ VN, mỗi người một bản tin mỗi ngày, gom việc quá hạn, việc đến hạn hôm nay và số việc mở khác. Bản tin chỉ tạo cho người có việc đang mở.
- **Người nhận:** người được giao đã quy đổi được và có quyền xem hội thoại. Nếu không có ai, người xác nhận việc nhận thay.
- **Khóa chống trùng:** `{kind}:{task}:{version}:{user}:{giờ UTC}`, MORNING dùng `MORNING:-:-:{user}:{ngày}`, UNIQUE trong database (có test).
- **Lập lại lịch khi việc thay đổi:** khi hạn, người được giao hoặc trạng thái thay đổi, `version + 1`. Các lần nhắc `pending` cũ chuyển thành `cancelled superseded`, các lần mới được chèn vào; mọi thứ nằm trong một transaction.
  - Hoàn thành hoặc hủy task thì toàn bộ lịch chưa gửi bị hủy.
  - Khi một lần nhắc vừa được claim mà task đổi giữa chừng, `ai_reminder_resolve` kiểm tra lại `version` và trạng thái, rồi chuyển lần đó thành `cancelled superseded` và không ghi gì vào hộp thư.

## 8. Phục hồi lần nhắc bị lỡ (TASK-08)

Chính sách được quyết định ở thời điểm **claim**, kể cả sau khi bộ chạy nền gián đoạn. `lateness = now − scheduled_for`, các ngưỡng cấu hình bằng `AI_REMINDER_*`.

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | người nhận bị khóa / mất quyền module | `skipped access_revoked` |
| 2 | MORNING khác ngày VN, hoặc từ 10:00 | `skipped_expired morning_window_closed` |
| 3 | task bị xóa / đã đóng / chưa xác nhận | `cancelled task_closed` |
| 4 | lần nhắc thuộc version cũ | `cancelled superseded` |
| 5 | người nhận không còn quyền xem hội thoại | `skipped access_revoked` |
| 6 | người nhận đã tắt loại nhắc này | `skipped preference_off` |
| 7 | DAY / HOUR khi đã tới hạn | `skipped_expired past_deadline` |
| 8 | DAY trễ ≥ 60′, HOUR trễ ≥ 15′ | `skipped_expired too_late` |
| 9 | còn lại | gửi: `sent`, hoặc `sent_late` nếu trễ > 2′ |
| 10 | OVERDUE trễ ≥ 60′ (sau gián đoạn dài) | **một** cảnh báo tổng hợp cho mỗi người mỗi ngày: các lần nhắc đó thành `sent_late aggregated`. Không gửi hàng loạt |

Quy ước ngưỡng: "dưới 1 giờ" nghĩa là < 60:00; đúng 60:00 thì bỏ (có test).

- **Hệ thống offline nhiều ngày:**
  - DAY / HOUR cũ bị bỏ;
  - MORNING của những ngày cũ bị bỏ;
  - OVERDUE được gom thành một cảnh báo (có test).
- **Phân biệt trạng thái:** `pending`, `sent`, `sent_late`, `skipped_expired`, `skipped`, `cancelled`, `failed`.
- **Không có `unknown`:** kênh Web được ghi cùng transaction với trạng thái cuối, nên một lần nhắc không bao giờ bị ghi `sent` khi chưa có dòng hộp thư.

## 9. Worker bền vững và kênh thông báo (TASK-09/10/11)

### 9.1 Worker

- **Chạy ở đâu:** Vercel function `/api/internal/ai-tasks/tick`, được pg_cron của Supabase gọi mỗi phút. Lý do: Vercel Hobby chỉ cho cron chạy một lần mỗi ngày (xem 00050). Cách này **không phụ thuộc máy Windows**: worker Zalo trên Windows chỉ cần cho việc *nhận* tin; việc nhắc vẫn chạy khi máy tắt.
- **Khi toàn bộ hệ thống offline** (Supabase hoặc Vercel dừng): không có gì bảo đảm nhắc đúng giờ. Khi chạy lại, hệ thống áp dụng chính sách ở mục 8.
- **Claim atomic:** `FOR UPDATE SKIP LOCKED` cùng lease (`lease_owner`, `lease_until`). Hai worker không bao giờ nhận cùng một dòng (có test với 2 worker × 40 dòng).
- **Phục hồi sau restart:** lần claim sau tự đưa các dòng `claimed` / `processing` hết lease về `pending`. Làm vậy an toàn vì việc ghi chỉ xảy ra ở bước resolve atomic. Worker nào mất lease mà còn trả kết quả thì bị từ chối (`lost`, có test).
- **Retry:** lỗi database hoặc mạng ở bước resolve không ghi gì. `ai_reminder_retry` áp dụng backoff `60s · 2^(n−1)`, tối đa 1 giờ; quá `max_attempts` (mặc định 5) → `failed max_attempts` (dead letter, cần người kiểm tra; có test).
- **Giám sát:** `ai_task_worker_runs` (mỗi tick lưu trạng thái, bộ đếm, mã lỗi) và `ai_task_health` (số lần nhắc trễ chưa xử lý, số lỗi 24h, số ứng viên đang chờ, lần chạy OK gần nhất). Các chỉ số này hiển thị ở trang "Lịch sử nhắc việc".
- **Dừng êm (graceful shutdown):** tick có ngân sách thời gian (`AI_TASKS_TICK_BUDGET_MS`, mặc định 45 giây) và lắng nghe `request.signal`. Khi hết giờ hoặc bị hủy, tick không nhận việc mới; ứng viên đã claim mà chưa xử lý được trả về `pending` ngay, phần còn lại được trả khi lease hết hạn.

### 9.2 Kênh thông báo

**Web Inbox** là kênh chuẩn của Phase 06: mention, yêu cầu xác nhận, đề xuất đổi hạn, sắp đến hạn (24h / 1h), quá hạn, cảnh báo tổng hợp và bản tin sáng.

- Có trạng thái đọc / chưa đọc; mỗi thông báo có link tới task hoặc tin nguồn.
- **Không chứa nội dung tin nhóm**, chỉ tiêu đề task và số lượng.
- Mỗi lần mở hộp thư, quyền được **kiểm tra lại**: người đã mất quyền xem hội thoại sẽ thấy "Thông báo không còn trong phạm vi bạn được xem", không có nội dung và không có link (có test).
- Web Push **chưa triển khai**: hệ thống chưa có service worker hay hạ tầng push.

**Zalo Personal / Zalo OA:** chỉ có adapter (interface) và mock test. Phase 04.5, tức đường gửi Zalo Personal đã xác minh, **chưa có**: worker chỉ nghe, và chưa nhóm nào có `send_verified_at`. Zalo OA chỉ được nhắn trong khung tương tác mà code không xác minh được. Một lần gửi phải qua cổng theo thứ tự:

1. kill switch `ZALO_NOTIFY_KILL_SWITCH` (mặc định **bật**);
2. cờ của kênh (`ZALO_NOTIFY_PERSONAL_ENABLED` / `ZALO_NOTIFY_OA_ENABLED`, mặc định tắt);
3. cài đặt của người dùng;
4. adapter khả dụng (hiện **không có**);
5. người nhận đã xác minh (liên kết của chính người đó);
6. giới hạn mỗi người mỗi giờ;
7. chống vòng lặp.

Hai quy tắc bổ sung:

- Kết quả `unknown` (timeout sau khi request đã đi) **không bao giờ tự retry**.
- Tin nhắc có tiền tố `[Nhắc việc]`, và bộ phát hiện bỏ qua mọi tin có tiền tố này.

## 10. Dashboard (TASK-12)

Ứng dụng "Trợ lý Zalo AI" có thêm nhóm menu "Công việc", chỉ hiện khi `AI_TASKS_ENABLED` bật. Giao diện tiếng Việt, dùng design system hiện có và responsive.

| Màn hình | Đường dẫn |
|---|---|
| Task Inbox (tất cả) | `/apps/zalo/personal/tasks` |
| Chờ xác nhận | `/apps/zalo/personal/tasks?view=pending` |
| Việc của tôi | `/apps/zalo/personal/tasks?view=mine` |
| Quá hạn | `/apps/zalo/personal/tasks?view=overdue` |
| Chi tiết task: tin nguồn, bằng chứng, lịch nhắc, lịch sử, hành động | `/apps/zalo/personal/tasks/{id}` |
| Lịch sử nhắc việc + sức khỏe bộ nhắc | `/apps/zalo/personal/tasks/reminders` |
| Cài đặt nhắc việc | `/apps/zalo/personal/tasks/preferences` |
| Thông báo (Web Inbox) | `/apps/zalo/personal/notifications` |

- **Danh sách:** phân trang phía server, lọc theo nhóm, người được giao, trạng thái và hạn. Có trạng thái loading, rỗng và lỗi theo các pattern hiện có.
- **Staff chỉ thấy việc của hội thoại mình được xem:** cùng bộ mảng phạm vi `p_full` / `p_group` / `p_ids` như Phase 03.

API (mọi route đều qua session + `zalo_personal:use` + phạm vi; cờ tắt → 404):

| Method | Đường dẫn |
|---|---|
| GET | `/api/zalo-personal/tasks` |
| GET | `/api/zalo-personal/tasks/{id}` |
| POST | `/api/zalo-personal/tasks/{id}/actions` |
| GET | `/api/zalo-personal/notifications` |
| POST | `/api/zalo-personal/notifications/read` |
| GET / PATCH | `/api/zalo-personal/reminders/preferences` |
| GET | `/api/zalo-personal/reminders/history` |
| POST | `/api/internal/ai-tasks/tick` (Bearer internal secret; cờ tắt → 503) |

## 11. Bảo mật (TASK-13)

| Nhóm người | Quyền |
|---|---|
| Owner (chủ kết nối) | toàn quyền với kết nối của mình |
| Admin | **không có quyền đặc biệt với dữ liệu Zalo của người khác** (nguyên tắc Phase 03), cần grant |
| Staff | theo grant: `read` → reader, `manage` → manager |
| Thành viên nhóm chưa liên kết | không có tài khoản nội bộ, không nhận gì |

Các quy tắc:

- Tên được mention không có giá trị gì. Chỉ UID kèm liên kết đã xác minh mới quy đổi ra người dùng.
- Có mặt trong nhóm không tạo ra quyền.
- Mọi việc gửi đi đều kiểm tra quyền của **chính người nhận** lúc gửi (`TaskAccess.canRead`). Không bao giờ mượn quyền của owner để gửi cho staff.
- Tin nguồn được tải lại và kiểm tra quyền mỗi lần mở chi tiết task. Mất quyền thì task trả 404, nhắc việc thành `access_revoked` và hộp thư ẩn nội dung (có test).
- Prompt injection không thay đổi được trạng thái (schema, SQL và test đều chặn). AI không có tool thay đổi hệ thống. Công nợ và dữ liệu nội bộ không bao giờ được đưa vào nhóm.
- Mọi thao tác trên task đều được audit (`ai_task_activity`).
- Log chỉ ghi bộ đếm và mã lỗi, không ghi nội dung tin, tiêu đề hay prompt.

## 12. Kiểm thử

- `src/lib/ai-tasks/ai-tasks.test.ts`: **50 test thuần** chạy dưới 1 giây, gồm:
  - DeadlineResolver (các ví dụ trong spec, giả định, từ mơ hồ, mốc là giờ tin);
  - Mention (UID đúng, trùng tên, nhiều người, không có metadata, nhóm chưa được phép);
  - Candidate;
  - Extractor (giao việc rõ, người được giao không có bằng chứng, tự nhận việc, hạn bịa, không có bằng chứng, suy đoán, `no_task` / `needs_clarification` / nhiều task, prompt injection, đề xuất đổi hạn, che dữ liệu, bộ quy tắc);
  - Lifecycle (chuyển trạng thái, vai trò, lập lại lịch);
  - Planner;
  - Recovery (mọi ngưỡng);
  - Text thông báo;
  - Adapter Zalo (mặc định tắt, thứ tự cổng, mock sent / failed / unknown / exception).
- `src/lib/ai-tasks/ai-tasks.integration.test.ts`: **27 test trên Supabase local**, dùng RPC ingest thật, SQL 00078 thật, tick và service thật, cùng fake Gemini (không có mạng), gồm:
  - mention / candidate / bộ quy tắc;
  - thông báo chỉ tới đúng người;
  - phát lại sự kiện và quét lại không đổi gì;
  - Gemini (fake): giao việc rõ ràng, budget chung, injection, quota exceeded và cooldown, chính sách `none`;
  - vòng đời qua service (chặn đổi trạng thái trái phép, 404 khi ngoài phạm vi, revision);
  - lần nhắc DAY trễ được gửi bù, HOUR quá hạn gửi bù bị bỏ, offline nhiều ngày dồn thành một cảnh báo, MORNING ngày cũ bị bỏ;
  - chống trùng job, worker đồng thời, thu hồi lease, lỗi store → retry rồi dead letter;
  - thu hồi grant, cách ly giữa các kết nối, RLS với anon.
- `src/lib/apps/apps.test.ts`: menu "Công việc" mặc định ẩn, mục đang active đúng.
- **Không gọi Gemini thật**, không gửi tin Zalo thật trong test.
- Chạy:

  ```
  node --env-file=.env.local --test src/lib/ai-tasks/ai-tasks.test.ts src/lib/ai-tasks/ai-tasks.integration.test.ts
  ```

  Bộ đầy đủ chạy bằng `npm test`.

## 13. Yêu cầu khi triển khai

Các bước này đều **cần người phụ trách quyết định**; chưa bước nào được thực hiện.

1. Áp `00078` lên cloud (`npx supabase db push --linked`), sau đó chạy `notify pgrst, 'reload schema';`.
2. Bật `AI_TASKS_ENABLED=true` trên Vercel (cần sẵn `ZALO_PERSONAL_DASHBOARD_ENABLED=true`), rồi redeploy.
3. Kích hoạt lịch chạy bằng cách lưu URL vào Vault (SQL editor, quyền postgres):

   ```sql
   select vault.create_secret('https://<domain>/api/internal/ai-tasks/tick', 'ai_tasks_tick_url');
   ```

   Secret `shopee_sync_internal_secret` đã có sẵn từ 00050 nên được dùng lại. Nếu chưa có secret này thì tick trả `not_configured` và không gọi gì.
4. (Tùy chọn) Bật `AI_TASKS_AI_EXTRACTION_ENABLED=true`, **chỉ khi** chính sách dữ liệu cho phép (`AI_DATA_SHARING_POLICY` khác `none`; Gemini gói miễn phí còn cần thêm `AI_FREE_TIER_DATA_APPROVED=true`). Nếu không bật, hệ thống dùng bộ quy tắc.
5. Người dùng liên kết tài khoản Zalo của mình bằng mã liên kết (Phase 05) để có thể được quy đổi khi bị mention hoặc được giao việc.
6. Giữ `ZALO_NOTIFY_KILL_SWITCH=true`; chưa có bộ gửi Zalo.

## 14. Rollback

1. **Nhanh, giữ dữ liệu:** đặt `AI_TASKS_ENABLED=false` rồi redeploy. Kết quả: trang và API trả 404, tick trả 503, menu biến mất, tin Zalo vẫn được ingest bình thường. Hoặc tắt lịch chạy:

   ```sql
   select cron.unschedule('ai-tasks-tick');
   ```

   hoặc xóa secret Vault `ai_tasks_tick_url`.
2. **Tắt riêng AI:** `AI_TASKS_AI_EXTRACTION_ENABLED=false` → chỉ còn bộ quy tắc; hoặc `AI_ENABLED=false` để tắt mọi lời gọi Gemini.
3. **Gỡ schema (xóa dữ liệu task / nhắc việc / hộp thư):** chạy [phase-06-rollback.sql](phase-06-rollback.sql), sau đó:

   ```sql
   delete from supabase_migrations.schema_migrations where version = '00078';
   notify pgrst, 'reload schema';
   ```

   Script không đụng tới tin Zalo, bảng của Phase 04/05 hay thông báo Zalo OA. Script đã được chạy thử trên local: rollback rồi áp lại 00078 thành công.
4. **Code:** revert commit của Phase 06. Code Phase 06 chỉ thêm file mới. Các file cũ bị sửa gồm:
   - `nav.ts` (mục có cờ);
   - `app-shell.tsx` (truyền cờ);
   - `apps.test.ts`;
   - `package.json` (script test);
   - `.env.example`.
