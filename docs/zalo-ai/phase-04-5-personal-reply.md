# Phase 04.5 — Zalo Personal AI Reply MVP

> Đọc kèm [phase-02-integration.md](phase-02-integration.md) (worker, ingestion có chữ ký), [phase-03-dashboard.md](phase-03-dashboard.md) (phạm vi quyền), [phase-04-ai-memory.md](phase-04-ai-memory.md) (Gemini, RAG, chính sách dữ liệu), [phase-05-system-assistant.md](phase-05-system-assistant.md) (trợ lý, System Tools, liên kết danh tính).
> Code: `src/lib/zalo-reply/**`, `services/zalo-personal-worker/src/outbound/**`, migration `00079_zalo_personal_reply.sql`, rollback [phase-04-5-rollback.sql](phase-04-5-rollback.sql).
> Trạng thái: code đã lên `master` (09ab544), 00079 đã áp lên cloud (cron `zp-reply-tick` ngủ đông: chưa có Vault `zp_reply_tick_url`). Mọi cờ **mặc định TẮT**. **Chưa gửi tin Zalo thật nào**.

Người dùng đã liên kết có thể hỏi bot qua chat 1-1, `@nhắc bot` (metadata) hoặc `/bot` trong nhóm. Hệ thống tạo **bản nháp**. Người có quyền duyệt (hoặc, với hội thoại thử nghiệm đã bật, tự động). Chỉ worker của đúng kết nối gửi tin, sau khi database kiểm tra lại mọi điều kiện ngay trước lúc gửi.

## 0. Kết quả kiểm tra điều kiện (mục II của spec)

| Điều kiện | Kết quả kiểm tra source |
|---|---|
| Worker nhận tin mới | Có (Phase 01/02). `message-listener` → normalize → outbox → `/api/internal/zalo-personal/events` có HMAC |
| Ingestion chống trùng | Có: `UNIQUE(connection_id, event_key)` + `UNIQUE(connection, conversation, external_message_id)` |
| Gemini Provider | Có (Phase 04): `GeminiProvider`, `generateWithRetry`, `FakeAiProvider`, budget `zp_ai_reserve` |
| RAG kiểm tra quyền | Có: `ask()` Phase 04 lọc theo scope Phase 03 (`canReadConversation`) |
| System Tool Registry | Có (Phase 05): 10 tool, quyền vai trò + quyền màn hình + audience |
| Identity mapping Zalo UID → user | Có (Phase 05): `ai_channel_identities` + mã `LINK <mã>`; **thiếu** UI tạo mã và luồng worker → bổ sung ở phase này |
| Outbox / notification tái sử dụng | Outbox worker (gửi về backend) dùng lại client có chữ ký. Không có hàng gửi tin Zalo → tạo mới (bảng draft = job) |
| zca-js gửi tin | `zca-js@2.4.0`: `api.sendMessage(message: MessageContent \| string, threadId, type = ThreadType.User)` → `{ message: { msgId } \| null, attachment }`. `ThreadType.User = 0`, `Group = 1`. Lỗi `ZaloApiError(message, code)`, `code` = `error_code` khi Zalo trả lời từ chối. **Không có idempotency key, không có timeout**. Đã đối chiếu trong `node_modules/zca-js/dist/apis/sendMessage.{d.ts,js}` và `utils.js` |

Không tạo Gemini provider mới, không tạo API giả: mọi thứ gọi lại Phase 04/05.

## 1. Kiến trúc Reply Router

```
Zalo ──zca-js──▶ worker (listener) ──HMAC──▶ /api/internal/zalo-personal/events ──▶ zalo_personal_messages   (Phase 02, không đổi)
                                                                                         │
pg_cron (1 phút, ngủ đông tới khi có Vault 'zp_reply_tick_url') ──▶ /api/internal/zalo-personal/reply/tick
   1. recover   draft quá hạn → expired; 'sending' mất lease → delivery_unknown
   2. scan      cursor (ingested_at, id) theo kết nối → router (router.ts) → zalo_personal_reply_inbound (UNIQUE message_id)
   3. process   pipeline.ts → zalo_personal_reply_drafts (UNIQUE inbound_id)
                                                                                         │
Dashboard (owner / manage grant) ── duyệt / sửa / từ chối / hủy ──▶ queued
                                                                                         │
worker (outbound/) ──HMAC claim──▶ zp_reply_claim_outbound (kiểm lại mọi cổng) ──▶ 1 job
       └─ journal "attempting" → api.sendMessage (timeout) → journal kết quả ──HMAC result──▶ zp_reply_report
```

- Chỉ dùng **sự kiện đã chuẩn hóa và đã lưu**. Router không bao giờ thấy object zca-js.
- **Tin chưa lưu được** (ví dụ nhóm `mention_only` mà không có @bot, hoặc 1-1 ở chế độ `metadata`): không có liên kết nguồn thì không trả lời. Router chỉ đọc bảng messages, nên không bao giờ có bản nháp mất nguồn (FK `source_message_id`).
- Cursor mới bắt đầu tại `now()`: bật tính năng **không** trả lời tin cũ.
- Tin không hợp lệ: mention metadata sai định dạng bị bỏ qua (`parseMentions`); lỗi pipeline được retry sau lease (tối đa 3 lần), sau đó `failed`. Tick không bao giờ crash.

## 2. Eligibility Policy

**Kích hoạt** (`detectTrigger`). Ngoài các trường hợp dưới đây, tin không được ghi lại:

| Nguồn | Điều kiện |
|---|---|
| `direct` | Tin văn bản trong chat 1-1 với tài khoản bot |
| `link` | `LINK <mã>` (toàn bộ tin) trong chat 1-1 |
| `mention` | Metadata mention có `uid` = tài khoản bot của kết nối (`zalo_account_id`, gắn bởi heartbeat), `kind = user`. Chữ "@Bot" gõ tay và @All **không** tính |
| `command` | Tin nhóm bắt đầu bằng `/bot` (đúng một từ) |

Tin của chính tài khoản bot (`isSelf`, gồm cả tin trả lời quay về qua selfListen) không bao giờ kích hoạt.

**Điều kiện xử lý** (`routeMessage` lúc quét, kiểm lại trong `decide` lúc xử lý):

| Tình huống | Kết quả |
|---|---|
| Kết nối `reply_mode = off` | skip `replies_off` |
| Nhóm `disabled` / chưa có đồng ý | skip `group_disabled` |
| Nhóm `monitor` | skip `group_monitor_only` (chỉ theo dõi) |
| Nhóm `mention_only` + mention | xử lý → bản nháp |
| Nhóm `interactive` + mention / `/bot` | xử lý → bản nháp, hoặc tự động nếu đủ điều kiện (mục 9) |
| 1-1 tắt (`direct_enabled = false`) | skip `direct_disabled` |
| Không phải văn bản / nội dung không lưu | skip |
| Câu hỏi rỗng / dài hơn 500 ký tự | skip |
| Người gửi bị chặn | skip `sender_blocked` |
| Vượt giới hạn câu hỏi mỗi người mỗi giờ / mỗi hội thoại mỗi ngày | skip (đếm trong DB, nguyên tử) |
| Câu hỏi cũ hơn TTL bản nháp | skip `stale` |

Lưu ý: ở nhóm `mention_only`, ingestion Phase 02 chỉ lưu tin có mention bot. Vì vậy `/bot` không kèm @mention chỉ hoạt động ở nhóm `interactive` và chat 1-1.

## 3. Identity & Permissions

- **Danh tính** dùng lại Phase 05: `resolvePersonalIdentity(connection, sender UID)` → `ai_channel_identities` → `profiles` (đọc lại mỗi lần). UID ở kết nối khác không được coi là cùng người.
- Liên kết: phase này bổ sung UI **Tạo mã liên kết** (Cài đặt trả lời; dùng `issuePersonalLinkCode` của Phase 05: 8 ký tự, 10 phút, chỉ lưu SHA-256) và luồng `LINK <mã>` trong chat 1-1 (`linkPersonalIdentity`), có xác nhận dạng bản nháp. Người dùng tự hủy liên kết được.
- **Câu hỏi chạy với quyền NGƯỜI HỎI**, không bao giờ với quyền chủ tài khoản bot. Ở trong cùng nhóm với bot không đem lại quyền gì.
- Người chưa liên kết: trong nhóm thì bỏ qua (không spam). Trong 1-1, nếu kết nối bật `unlinked_help`, người đó chỉ nhận bản nháp hướng dẫn liên kết, không bao giờ nhận dữ liệu.
- Tài khoản bị khóa: trong nhóm thì bỏ qua; trong 1-1 nhận thông báo "đã bị khóa". Khóa sau khi đã duyệt thì vẫn bị chặn lúc claim (`asker_not_authorized`).
- Mọi System Tool vẫn tự kiểm quyền ở backend (Phase 05). Vai trò khai trong tin nhắn ("tôi là admin") không có tác dụng.

**Quyền công bố** (người đọc là **audience**):

| Kênh | Được công bố |
|---|---|
| 1-1 | Mọi thứ người hỏi được xem (quyền màn hình Phase 05; scope hội thoại Phase 04) |
| Nhóm, dữ liệu nghiệp vụ | Chỉ tool `knowledge` (định nghĩa). Cả admin hỏi công nợ trong nhóm cũng **không** nhận số liệu (`AUDIENCE_ALLOWS.group`) |
| Nhóm, lịch sử | Chỉ tin của **chính nhóm đó**. Bản nháp trích dẫn hội thoại khác bị chặn (`foreign_conversation`) |

Hệ thống không tự chuyển câu trả lời sang tin riêng.

**Người duyệt** (`canReview`): chủ kết nối duyệt mọi bản nháp. Người có grant `manage` chỉ duyệt bản nháp nhóm (bản nháp 1-1 chỉ chủ kết nối duyệt, giống quy tắc xem tin 1-1). Ngoài ra, **vai trò của người duyệt phải có mọi quyền mà dữ liệu trong câu trả lời cần** (`required_permissions`, ví dụ `debt:view`), để người duyệt không thấy số liệu mà màn hình không cho họ xem.

## 4. AI Response Pipeline

`pipeline.ts → decide()`:

1. Đọc lại context từ DB (`zp_reply_inbound_context`). Không dùng lại dữ liệu lúc quét.
2. Kiểm tra eligibility lần hai: chế độ nhóm, 1-1, block.
3. `LINK` → liên kết.
4. Xác thực danh tính (verified link + profile active).
5. Câu hỏi = text bỏ đoạn @mention theo metadata, hoặc bỏ `/bot`.
6. Định tuyến (`routeQuestion`): câu hỏi về lịch sử hội thoại ("tóm tắt", "ai nói", "đã chốt", …) đi tới **Phase 04 `ask()`**, chỉ trong `[conversationId]` hiện tại và scope của người hỏi. Các câu khác đi tới **Phase 05** qua `personalAdapter` (cần `AI_SYSTEM_PERSONAL_DRAFTS_ENABLED`).
7. System Tools theo quyền + audience (Phase 05). Giới hạn số tool, timeout, số dòng, kỳ 92 ngày, rate limit.
8. Gemini (nếu có): dùng chung provider, budget và **chính sách dữ liệu** (`sharingDecision`). Free Tier chưa duyệt thì không gửi dữ liệu nghiệp vụ, khi đó dùng formatter xác định.
9. Kiểm tra nguồn: Phase 05 validator (nhãn nguồn, số liệu có trong dữ liệu), Phase 04 `validateClaims`.
10. Kiểm tra công bố: `systemDraft` (audience) / `memoryDraft` (cùng hội thoại); `sanitizeReply` (bỏ markup, ký tự điều khiển, ≤ 1800 ký tự).
11. Tạo bản nháp (`zp_reply_store_result`, có kiểm lease, idempotent).
12. Đề xuất tự động gửi chỉ khi đủ điều kiện (mục 9). DB kiểm lại.

Thiếu nguồn thì nói rõ ("chưa tìm thấy trong các tin đã lưu"). AI không dùng được thì nói "AI chưa xử lý được", không bịa. Worker offline: Phase 04 trả cảnh báo coverage, được đưa vào "Lưu ý". Nội dung chat chỉ là DATA (cả hai pipeline đã rào). Prompt injection không đổi được pipeline, tool hay audience (có test).

## 5. Draft Approval

Bảng `zalo_personal_reply_drafts`: một bản nháp cho mỗi inbound (`UNIQUE inbound_id`). Có `original_text` (bất biến) và `text` (sửa được), `version` (khóa lạc quan), `expires_at` (TTL, mặc định 60 phút), `citations`, `caveats`, `required_permissions`.

| Thao tác | Từ → tới | Ai |
|---|---|---|
| approve | pending_approval → queued (`approval = manual`, `approved_by`) | reviewer |
| edit | pending_approval (text, version+1) | reviewer |
| reject | pending_approval → rejected | reviewer |
| cancel | pending_approval / queued → cancelled | reviewer |
| confirm_sent / confirm_not_sent | delivery_unknown → sent / failed | reviewer (sau khi xem trên điện thoại) |

Bản nháp hết hạn không duyệt được. Sai `version` trả 409. Mọi thao tác ghi vào `zalo_personal_reply_audit` (append-only, trigger chặn sửa). Không có đường nào để một lần gọi Gemini khác tự duyệt: chỉ API có session người dùng hoặc quy tắc tự động trong DB mới đặt `approval`.

"draft" và "approved" trong spec tương ứng `pending_approval` và `queued` (+ `approved_by`).

## 6. Outbound Queue

- Hàng đợi bền vững = bảng draft (`status = queued`). Next.js **không bao giờ** gọi Zalo.
- Worker gọi `POST /api/internal/zalo-personal/outbound/claim` (HMAC, timestamp, nonce, rate limit giống `/events`, endpoint nonce `outbound`). Body chỉ có `{ v, connectionKey, accountId, listenerState: "active" }`. Body có thêm key (ví dụ một đích gửi) thì bị từ chối.
- `zp_reply_claim_outbound` kiểm theo thứ tự: dừng khẩn cấp → worker / kết nối active → **accountId = tài khoản gắn với kết nối** → `reply_mode`, `send_paused` → giới hạn ngày toàn hệ thống / kết nối → với từng draft: hết hạn, nhóm còn `mention_only` / `interactive` + đồng ý, 1-1 còn bật, điều kiện tự động, block, **danh tính + profile người hỏi**, **profile người duyệt**, cooldown / người / nhóm / hội thoại. Trả **một** job, mỗi hội thoại chỉ một tin `sending` cùng lúc.
- Đích gửi lấy từ hội thoại của inbound (`external_conversation_id`), không từ model hay request.
- Worker gửi bằng `session.sendText` (bọc `api.sendMessage({ msg }, threadId, ThreadType)`), là API ghi **duy nhất** được mở trong `zalo-client.ts`. Không log nội dung, thread id, cookie hay session.
- Tắt an toàn (graceful): `outbound.stop()` không claim thêm, chờ lần gửi đang chạy (≤ timeout) và lần báo kết quả, trước khi ingestion tắt. Tin chưa claim vẫn `queued` trên server.

## 7. Delivery State Machine

```
queued ──claim──▶ sending ──sent──────────────▶ sent
                     │ not_sent (≤3 lần) ─────▶ queued   (chắc chắn chưa rời máy)
                     │ failed ────────────────▶ failed   + tạm dừng gửi cả kết nối
                     │ unknown / mất lease ───▶ delivery_unknown ──(người vận hành)──▶ sent | failed
```

Phân loại ở worker (`outbound/sender.ts`):

| Kết quả zca-js | Trạng thái |
|---|---|
| Trả về `msgId` | sent |
| Timeout của worker (mặc định 20 giây) | unknown. Nếu sau đó zca-js trả thành công, journal nâng lên sent và báo lại |
| `ZaloApiError` có `error_code` | failed (Zalo từ chối) → **pause** kết nối |
| HTTP 5xx / phản hồi không đọc được | unknown |
| HTTP 4xx | failed |
| Lỗi kiểm tra / mã hóa trước khi gửi request | not_sent |
| DNS / connection refused | not_sent |
| Lỗi mạng khác | unknown |

**Không giả định có idempotency.** Tin `delivery_unknown` không bao giờ được xếp hàng lại. Journal cục bộ (`outbound-journal.json` trong data dir, ghi nguyên tử, không chứa nội dung) ghi `attempting` **trước** khi gửi. Nếu worker khởi động lại giữa lúc gửi, mục đó thành `unknown` và được báo như vậy; một draft đã có trong journal không bao giờ bị gửi lại, kể cả khi server giao lại. Lease hết mà không có báo cáo thì `zp_reply_recover` chuyển sang `delivery_unknown`. Báo cáo đến muộn (unknown → sent) vẫn được nhận.

## 8. Anti-loop và rate limiting

| Biện pháp | Ở đâu |
|---|---|
| Self-message | `isSelf` không kích hoạt (cả tin bot vừa gửi quay về) |
| Chống trùng inbound | `UNIQUE message_id` + dedupe ingestion Phase 02 |
| Chống trùng outbound | `UNIQUE inbound_id` + claim token + journal worker |
| Cooldown hội thoại | `cooldown_seconds` (mặc định 60) + một `sending` / hội thoại |
| Mỗi người / giờ | `per_user_per_hour` (10): đếm cả câu hỏi vào và tin gửi ra |
| Mỗi nhóm / giờ | `per_group_per_hour` (20) |
| Mỗi ngày / kết nối | `daily_send_limit` (50) |
| Toàn hệ thống / ngày | `PERSONAL_REPLY_GLOBAL_DAILY_LIMIT` (100) |
| Tối đa trả lời / hội thoại / ngày | `max_per_conversation_per_day` (20) |
| Hạn trả lời | `draft_ttl_minutes` (60) |
| Dừng khẩn cấp | Nút trên dashboard (DB) · `PERSONAL_SEND_ENABLED=false` · `ZP_SEND_ENABLED=false` · `npm run stop` |
| Bot khác | Không nhận diện được tự động → danh sách chặn theo Zalo ID |
| Phanh cục bộ | Worker giãn tối thiểu `ZP_SEND_MIN_INTERVAL_MS` (5 giây) giữa hai lần gửi |

Khi Zalo từ chối: tin chuyển `failed`, kết nối `send_paused` (`zalo_rejected`), và vòng gửi của worker tự dừng tới khi khởi động lại. Chỉ chủ kết nối mới cho phép gửi lại. Hệ thống không cố vượt giới hạn.

## 9. Feature Flags

| Cờ (server) | Mặc định | Tác dụng |
|---|---|---|
| `PERSONAL_REPLY_ENABLED` | false | Router, bản nháp, dashboard. Tắt: trang và API trả 404, tick trả 503 |
| `PERSONAL_SEND_ENABLED` | false | Worker được claim (cần cờ trên). Tắt: claim trả `job: null, send_disabled` (kill switch toàn cục) |
| `PERSONAL_AUTO_REPLY_ENABLED` | false | Cho phép tự động (cần SEND) |
| `AI_SYSTEM_PERSONAL_DRAFTS_ENABLED` | false | Phase 05 adapter Zalo Personal (câu hỏi dữ liệu nghiệp vụ) |
| `PERSONAL_REPLY_GLOBAL_DAILY_LIMIT` / `_MAX_PER_TICK` / `_LEASE_SECONDS` | 100 / 5 / 120 | |

| Worker | Mặc định | |
|---|---|---|
| `ZP_SEND_ENABLED` | false | Bật vòng gửi (cần `ZP_INGEST_ENABLED`) |
| `ZP_SEND_POLL_MS` / `ZP_SEND_TIMEOUT_MS` / `ZP_SEND_MIN_INTERVAL_MS` | 15000 / 20000 / 5000 | |

Theo kết nối (DB, chỉ chủ kết nối đổi): `reply_mode` (`off` / **`draft_only` mặc định** / `auto`), 1-1, hướng dẫn liên kết, các giới hạn, TTL, tạm dừng.
Theo nhóm: chế độ Phase 03. `interactive` chỉ mở khi `send_verified_at` có giá trị, tức sau khi **một tin duyệt tay gửi thành công vào nhóm**.
Theo hội thoại: **allowlist tự động** bắt buộc kèm ghi chú đồng ý.
Theo người: block list, liên kết danh tính, quyền vai trò.

Tự động gửi chỉ xảy ra khi **đủ tất cả** điều kiện: cờ hệ thống, kết nối `auto`, hội thoại trong allowlist, người hỏi đã liên kết và active, câu trả lời `answered` loại `ai_answer`, đường gửi đã kiểm chứng (nhóm: `interactive` + `send_verified_at`; 1-1: đã có ít nhất một tin duyệt tay gửi thành công). Không có nút "bật tự động cho mọi nhóm". Backend thực thi mọi điều kiện (`zp_reply_store_result` và claim kiểm lại); checkbox chỉ là giao diện.

## 10. Dashboard

Nhóm menu **"Trả lời AI"** (ẩn khi cờ tắt):

| Trang | Nội dung |
|---|---|
| `/apps/zalo/personal/replies` | AI Reply Inbox: tab Cần xử lý / Chờ duyệt / Chưa rõ đã gửi / Tất cả, tin nguồn, trả lời đề xuất, số nguồn, trạng thái, lý do chờ. Có thêm danh sách tin gọi bot không được trả lời (lý do) |
| `/apps/zalo/personal/replies/[id]` | Chi tiết: tin nguồn (link vào hội thoại), đề xuất / bản gốc, nguồn, lưu ý, người đọc (audience), thao tác, nhật ký |
| `/apps/zalo/personal/replies/outbound` | Outbound History: hội thoại, người nhận (cả nhóm / riêng người hỏi), trạng thái, thời điểm tạo / duyệt / gửi, lỗi, "chưa rõ đã gửi" |
| `/apps/zalo/personal/replies/settings` | Dừng khẩn cấp, cảnh báo rủi ro zca-js, theo kết nối: chế độ, 1-1, hướng dẫn liên kết, giới hạn, tạm dừng, allowlist (ghi chú bắt buộc), block list, đã gửi hôm nay. Thêm phần "Liên kết tài khoản Zalo của tôi" (tạo mã, hủy liên kết) |

API: `GET /api/zalo-personal/replies`, `GET /replies/[id]`, `POST /replies/[id]/actions`, `GET|PATCH /replies/settings`, `POST /replies/control`, `POST /replies/link-code`, `DELETE /replies/identities/[id]`. Nội bộ: `POST /api/internal/zalo-personal/reply/tick` (secret cron), `POST /api/internal/zalo-personal/outbound/{claim,result}` (HMAC worker). Mọi nút đều có API thực thi. Không hiển thị secret, session hay Zalo ID đầy đủ (che `…1234`).

## 11. Windows Manual Test

> **Không tự thực hiện khi chưa có phê duyệt của chủ tài khoản.** Tài khoản đang dùng là tài khoản cá nhân chính. zca-js là thư viện **không chính thức**: Zalo có thể yêu cầu xác minh, hạn chế hoặc khóa tài khoản. Không tìm cách vượt captcha, khóa hay giới hạn. Gặp dấu hiệu bất thường thì dừng ngay (`npm run stop`).

Chuẩn bị: áp 00079 (local: `npx supabase migration up`). Trong `.env.local` của app: `PERSONAL_REPLY_ENABLED=true`, `PERSONAL_SEND_ENABLED=true`, `AI_SYSTEM_PERSONAL_DRAFTS_ENABLED=true` (auto **để tắt**). Worker đã đăng nhập và ingestion chạy (Phase 02).

1. **Chạy worker trên Windows.** Trong `services/zalo-personal-worker/.env`: `ZP_SEND_ENABLED=true`, `ZP_DIRECT_MESSAGES=content` (nếu thử 1-1). Chạy `npm run dev` và thấy dòng "GỬI TIN TRẢ LỜI: BẬT".
2. **Kiểm tra kết nối**: `npm run status` (session active), dashboard → Kết nối (heartbeat mới).
3. **Chọn hội thoại riêng được phép**: kết nối ở chế độ lưu nội dung 1-1 (`direct_message_mode = content`). Trong Cài đặt trả lời → "Tạo mã liên kết". Từ **một tài khoản Zalo thử nghiệm khác** (không phải bot), gửi `LINK <mã>` vào chat 1-1 với tài khoản bot.
4. **Gửi câu hỏi thử nghiệm** từ tài khoản đó, ví dụ "công nợ là gì?".
5. **Xác nhận hệ thống nhận tin**: Hội thoại → tin xuất hiện. Gọi tick: `curl -X POST -H "Authorization: Bearer <SHOPEE_SYNC_INTERNAL_SECRET>" http://localhost:3000/api/internal/zalo-personal/reply/tick`.
6. **Kiểm tra bản nháp**: Hộp duyệt trả lời → bản nháp "Chờ duyệt" (xác nhận liên kết + câu trả lời).
7. **Duyệt** trên dashboard (có thể sửa nội dung trước).
8. **Gửi**: trong ≤ 15 giây worker claim và gửi **một** tin. Log worker hiện `outbound_attempt outcome=sent`.
9. **Kiểm tra phía người nhận**: tin xuất hiện trên tài khoản thử nghiệm. Lịch sử gửi → "Đã gửi".
10. **Audit**: trang chi tiết → Nhật ký: Tạo → Duyệt → Worker nhận gửi → Đã gửi.
11. **Nhóm**: nhóm thử nghiệm đã có đồng ý → `mention_only` → @bot hỏi → duyệt → gửi. Sau tin này nhóm được "xác minh gửi", có thể chuyển `interactive`. Chỉ khi đó mới thử allowlist + `PERSONAL_AUTO_REPLY_ENABLED` (nếu được phê duyệt).
12. **Anti-loop / chống trùng**: tin bot vừa gửi quay về (selfListen) **không** tạo bản nháp mới. Gửi 2 câu liên tiếp thì câu thứ hai chờ cooldown. Chạy tick lần nữa không tạo bản nháp trùng.
13. **Kill switch**: bấm "Dừng khẩn cấp", duyệt một bản nháp, xác nhận không có tin nào được gửi (claim `emergency_stop`). Thử thêm `npm run stop`. Gỡ dừng (admin) sau khi xong.
14. **Zalo OA vẫn hoạt động**: kiểm tra webhook / gửi tin OA như thường lệ (phase này không đổi code OA).

Kết thúc: đặt lại `ZP_SEND_ENABLED=false` nếu chưa dùng tiếp.

## 12. Security

| Rủi ro | Biện pháp |
|---|---|
| Gửi trái phép / sai đích | Chỉ worker có HMAC của **đúng** kết nối claim được. Account phải khớp. Đích lấy từ DB. Body strict |
| Mạo danh / leo quyền | Danh tính chỉ qua link đã xác minh. Profile đọc lại lúc xử lý và lúc gửi. Chạy với quyền người hỏi. Nhóm không đem lại quyền |
| Lộ dữ liệu ra nhóm | Audience group chỉ nhận knowledge. Memory chỉ trong cùng hội thoại. Bản nháp vi phạm bị chặn |
| Người duyệt thấy dữ liệu vượt quyền | `required_permissions` so với vai trò người duyệt. 1-1 chỉ chủ kết nối duyệt |
| Prompt injection | Nội dung chat là DATA (Phase 04/05). Định tuyến bằng quy tắc. Tool trong enum đã lọc. Tự động chỉ qua quy tắc DB |
| Gửi trùng / vòng lặp | UNIQUE inbound / draft, claim token, journal, isSelf, cooldown |
| Tài khoản bị hạn chế | Lỗi từ chối thì pause kết nối và dừng vòng gửi. Có giới hạn tần suất nhiều tầng. Không retry mù |
| Lộ bí mật / nội dung trong log | Log chỉ có category / đếm. Journal không có text / thread. Audit không có nội dung |
| Truy cập DB trực tiếp | RLS bật, revoke anon / authenticated, chỉ `service_role`. Grant tường minh (cloud không có default grant) |
| CSRF / API | Session server + quyền Phase 03. Zod strict. Id không thuộc phạm vi thì trả 404 |

## 13. Regression Tests

| Bộ test | Kết quả (local, 25/11/2026) |
|---|---|
| `src/lib/zalo-reply/zalo-reply.test.ts` (router, eligibility, policy, lifecycle, flags, pipeline + identity + Phase 05 thật với tool giả, endpoint HMAC) | 39/39 |
| `src/lib/zalo-reply/zalo-reply.integration.test.ts` (Supabase local: tick thật, review, claim / report, cooldown, kill switch, pause, unknown, lease, retry, cổng cuối, rate limit, auto, RLS, audit) | 20/20 |
| `services/zalo-personal-worker` (toàn bộ, gồm 14 test outbound với mock session) | 152/152 |
| `scripts/e2e/zalo-reply-045.ts` (Playwright, UI thật) | 10/10 |
| `npm test` (hồi quy toàn dự án: OA, ingestion, dashboard, AI Memory, System Tools, Web Conversation, auth, task engine) | xem báo cáo cuối phase |

Test tự động chỉ dùng mock adapter và `FakeAiProvider`. **Không gọi Gemini thật, không gửi tin Zalo trong CI.**

## 14. Rollback Plan

| Mức | Cách làm | Mất dữ liệu? |
|---|---|---|
| 0. Dừng gửi ngay | Dashboard "Dừng khẩn cấp", hoặc `npm run stop` trên máy worker, hoặc `ZP_SEND_ENABLED=false` | Không |
| 1. Tắt | `PERSONAL_SEND_ENABLED=false`, `PERSONAL_AUTO_REPLY_ENABLED=false`, `PERSONAL_REPLY_ENABLED=false`. Không tạo Vault `zp_reply_tick_url` (cron ngủ đông) | Không |
| 2. Gỡ code | `git revert` commit Phase 04.5. Worker: `ZP_SEND_ENABLED=false` hoặc về bản cũ | Không |
| 3. Gỡ schema (**chỉ khi chủ dự án duyệt**) | [phase-04-5-rollback.sql](phase-04-5-rollback.sql) (đã thử ở local: gỡ → áp lại) | Có: bản nháp, lịch sử gửi, audit, cài đặt |

`send_verified_at` của nhóm (do tin đã gửi thật đặt) được giữ khi rollback. Nhóm đã ở `interactive` vẫn hợp lệ với ràng buộc Phase 02.

## 15. Phase 04.5.1 — Realtime + tự trả lời 1-1 (26/11/2026)

Sau buổi test thật đầu tiên (2 tin duyệt tay đã gửi), chủ tài khoản quyết định: trả lời gần như tức thì, bỏ bước duyệt cho chat 1-1 với người đã liên kết. Code `src/lib/zalo-reply/{engine,pipeline,policy,config,server}.ts`, route `events`, worker `outbound/service.ts`, migration `00080_zalo_personal_reply_realtime_auto.sql`.

**Realtime**

| Chặng | Trước | Sau |
|---|---|---|
| Server quét tin mới | cron mỗi phút (trung bình ~30 giây) | `after()` ngay trong request `events` khi batch có tin được lưu; cron vẫn chạy làm lưới an toàn |
| Độ trễ quét | 3 giây | `PERSONAL_REPLY_SCAN_LAG_MS` = 1,5 giây |
| Kết nối mới (chưa có `scan_state`) | con trỏ = bây giờ | con trỏ = 1 phút trước (tin vừa kích hoạt không bị bỏ) |
| Worker hỏi hàng gửi | 15 giây | có tin đến: claim ngay, rồi mỗi 1,5 giây trong 60 giây (`ZP_SEND_FAST_POLL_MS`, `ZP_SEND_FAST_WINDOW_MS`) |
| Cooldown tối thiểu / hội thoại | 10 giây | 5 giây |

Nhiều tin cùng lúc trong một instance được gộp: một lượt chạy và đúng một lượt bổ sung (`FastReplyScheduler`). Đo ở local (`scripts/e2e/zalo-reply-realtime.ts`, AI giả): server tạo xong bản nháp `auto` và giao job khoảng **2 giây** sau khi nhận tin. Với Gemini thật cộng thêm thời gian gọi model.

**Tự trả lời (`PERSONAL_AUTO_REPLY_ENABLED` + kết nối ở chế độ `auto`)**

| | 1-1 | Nhóm |
|---|---|---|
| Allowlist | không cần | bắt buộc (ghi chú đồng ý) |
| Loại tin tự gửi | `ai_answer` (người hỏi đã liên kết, mọi trạng thái), `notice`, `link_result` | `ai_answer` trạng thái `answered` |
| Điều kiện đường gửi | kết nối đã gửi thành công ≥ 1 tin duyệt tay | `interactive` + `send_verified_at` |
| Người lạ (chưa liên kết) | không trả lời, không tạo bản nháp | không trả lời |

DB vẫn kiểm tra lại ở `zp_reply_store_result` và `zp_reply_claim_outbound`. Mọi cổng khác giữ nguyên: dừng khẩn cấp, tạm dừng, chặn người gửi, profile còn hoạt động, giới hạn theo người / nhóm / ngày, giới hạn toàn hệ thống, worker giãn tối thiểu 5 giây giữa hai lần gửi.

**Rollback**: chuyển kết nối về `draft_only` (hoặc tắt cờ) thì mọi bản nháp mới chờ duyệt lại, bản nháp `auto` còn trong hàng bị hủy lúc claim. Tắt realtime: `PERSONAL_REPLY_FAST_PATH=false`, `ZP_SEND_FAST_WINDOW_MS=0`.
