# Phase 07 — Zalo Personal: vận hành production & tự trả lời có kiểm soát

> Đọc kèm [phase-04-5-personal-reply.md](phase-04-5-personal-reply.md) (hàng gửi, duyệt, realtime), [phase-06-task-reminders.md](phase-06-task-reminders.md) (lịch nhắc, chính sách gửi bù), [phase-02-integration.md](phase-02-integration.md) (worker, ingestion có chữ ký).
> Code: migration `00081_zalo_personal_ops.sql`, `src/lib/zalo-reply/{ops,service,policy,pipeline,supabase-store}.ts`, `src/lib/ai-tasks/channels.ts`, trang `/apps/zalo/personal/operations`, worker `ops/windows/*`, `ops/docker/*`, `Dockerfile`.
> Trạng thái: code + 00081 ở **local**, chưa commit / push / áp lên cloud. Không bật cờ production nào, không gửi tin thật nào trong phase này.

## 0. Audit hiện trạng (OPS-01) — kiểm chứng ngày 26/11/2026

Nguồn: code, migration, DB cloud (truy vấn chỉ đọc), log worker, test thật. Không dựa vào tài liệu.

| Thành phần | Trạng thái | Bằng chứng |
|---|---|---|
| Worker zca-js | Triển khai, chạy thật | `zca-js` **2.4.0** (ghim trong `package.json`), Node v24.16 trên Windows. Đo thật: 58 MB working set, đỉnh 108 MB, CPU ~0,2% một nhân |
| Ingestion Supabase | Triển khai, chạy thật | 41 sự kiện / 24h trên cloud, 0 bị từ chối |
| Reply Router + Draft + Outbound | Triển khai, **chạy thật** | Cloud: 12 tin đã gửi (3 duyệt tay, 9 tự động 1-1), 0 lỗi, 0 "chưa rõ" |
| Realtime (after() + nudge) | Triển khai, chạy thật | Câu hỏi được xử lý ~3 giây sau khi lưu (cloud, 26/11) |
| Identity / LINK | Triển khai, chạy thật | 3 tin xác nhận LINK đã gửi |
| **Allowlist nội dung 1-1** | **Có lỗ hổng → đã sửa** | Chế độ `content` lưu chữ của **mọi** người nhắn tới tài khoản bot. Thêm chế độ `linked` (mục 2) |
| **`content_stored`** | **Có lỗi → đã sửa** | Server ghi "đã lưu" cả khi worker không gửi chữ (sự cố 26/11 10:11–10:55: 5 tin bị bỏ qua, khó chẩn đoán). Nay = chữ thật sự được lưu + lý do `text_not_sent` |
| Gemini + RAG | Triển khai, **chưa chạy thật trên production** | `ai_request_usage` cloud trống 3 ngày: chưa có lần gọi Gemini nào. Câu trả lời hiện là mẫu cố định từ System Tools. Local dùng `AI_PROVIDER=fake` |
| System Tool Registry | Triển khai, có test | 10 tool **chỉ đọc**; không tool nào sửa công nợ / thanh toán / đơn / quyền (Phase 05) |
| Approval Inbox | Triển khai, chạy thật | 3 tin duyệt tay đã gửi |
| Reminder Engine | Triển khai, có test | Web inbox chạy; **kênh Zalo chưa có adapter** (`unavailableAdapter`) → đã làm ở phase này |
| Web Notifications | Triển khai | Độc lập với Zalo |
| Nhóm | Triển khai, **chưa test thật** | Cloud chưa có nhóm nào được đồng ý |
| Health / alert | **Chưa triển khai** → đã làm | Trước đây chỉ có `health.json` local và trang Kết nối |
| `kicked_by_server` | Đã xảy ra | 25/11 10:14 (Zalo đá phiên; worker dừng đúng thiết kế, không tự thử lại). Nguyên nhân thường gặp: mở Zalo Web / PC cùng tài khoản |
| Windows runbook / Task Scheduler | Chưa có → đã làm | `ops/windows/*` |
| Docker / VPS | Chưa có → đã chuẩn bị (không deploy) | `Dockerfile`, `ops/docker/*` |
| Cờ production kiểm chứng được | | `PERSONAL_REPLY_ENABLED` bật (tick 200), `PERSONAL_SEND_ENABLED` bật (tin đã gửi), `PERSONAL_AUTO_REPLY_ENABLED` bật (kết nối lưu được chế độ auto, server từ chối khi cờ tắt). Cron `zp-reply-tick` chạy mỗi phút. Không đọc được biến Vercel trực tiếp (chưa cài Vercel CLI) |
| Migration cloud | | Đến **00080**. 00081 chỉ ở local |

## 1. Kiến trúc vận hành

```
 Zalo ◀──zca-js──▶ Worker (Windows / VPS, MỘT bản / tài khoản)
                      │ HMAC                     ▲ claim / report (HMAC)
                      ▼                          │
   /api/internal/zalo-personal/events ──after()──▶ reply tick (realtime)
                      │                          │
                Supabase (durable) ◀── pg_cron mỗi phút: reply tick + health check + alerts
                      │                          ◀── pg_cron mỗi phút: ai-tasks tick (nhắc việc)
                      ▼
   Dashboard: Hộp duyệt · Lịch sử gửi · Cài đặt · Vận hành (admin)
```

- **Mọi tin rời tài khoản đều đi qua một hàng duy nhất** (`zalo_personal_reply_drafts`): trả lời AI, tin hệ thống, và từ phase này cả nhắc việc. Chỉ worker của đúng kết nối mới claim được.
- **Lập lịch không phụ thuộc máy Windows.** pg_cron (Supabase) gọi Vercel mỗi phút: nhắc web vẫn chạy khi worker tắt. Chỉ phần *gửi qua Zalo* cần worker.
- **Không có bảo đảm 24/7.** Worker trên một máy Windows cá nhân tắt khi máy tắt / ngủ / mất mạng. Nhắc Zalo trong lúc đó sẽ hết hạn (mục 5), không gửi bù hàng loạt.

## 2. Chính sách trả lời (OPS-02 / OPS-03)

**Chế độ của kết nối** (`reply_mode`, chỉ admin chủ kết nối đổi):

| Chế độ | Phân tích & tạo bản nháp | Gửi |
|---|---|---|
| `disabled` | Không | Không |
| `draft_only` (mặc định kết nối mới) | Có | **Không bao giờ** (duyệt bị từ chối) |
| `manual_approval` | Có | Sau khi người có quyền duyệt |
| `auto_reply_allowlist` | Có | Tự động **trong phạm vi**; ngoài phạm vi vẫn duyệt tay |

**Phạm vi tự động** (chỉ có tác dụng ở `auto_reply_allowlist`, cần cờ `PERSONAL_AUTO_REPLY_ENABLED`):

| | Mặc định | Giá trị |
|---|---|---|
| 1-1 `auto_direct` | `off` | `off` · `allowlist` (chỉ chat trong danh sách cho phép) · `all_linked` (mọi người đã liên kết) |
| Nhóm `auto_groups` | tắt | Bật: chỉ nhóm trong danh sách cho phép + chế độ **Tương tác** + đã xác minh gửi + được @nhắc / `/bot` |

**Công tắc gửi theo kết nối** `send_enabled`: mặc định **tắt** cho kết nối mới. Tắt = không tin nào rời kết nối (kể cả tin đã duyệt và nhắc việc). Không bật được khi `PERSONAL_SEND_ENABLED` tắt.

**Nội dung 1-1 được lưu** (`direct_message_mode`, admin đổi trên trang Cài đặt):

| Chế độ | Chữ được lưu |
|---|---|
| `off` | Không nhận tin 1-1 |
| `metadata` | Không lưu chữ nào (bot không trả lời được 1-1) |
| **`linked` (khuyên dùng)** | Chỉ chat với **người đã liên kết** (cả chiều bot trả lời) + lệnh `LINK <mã>`. Tin của người khác: chỉ metadata |
| `content` | Mọi người. Chỉ dùng khi đã cân nhắc quyền riêng tư |

Worker phải gửi chữ (`ZP_DIRECT_MESSAGES=content`); server mới là nơi quyết định giữ hay bỏ. Khi một liên kết bị thu hồi, tin sau của người đó không còn được lưu chữ (có test).

**Quy tắc trả lời** (kiểm tra ở pipeline, lưu bản nháp **và** lúc worker claim):

- Người đã liên kết: hỏi theo **quyền của chính họ**. Chạy với vai trò người hỏi, không bao giờ với quyền chủ tài khoản bot.
- Người chưa liên kết: không truy vấn dữ liệu. Ở chế độ tự động: không trả lời. Ở chế độ duyệt: chỉ bản nháp "hướng dẫn liên kết" nếu bật.
- Nhóm: `disabled` → bỏ, `monitor` → chỉ thu thập, `mention_only` → bản nháp khi được gọi, `interactive` → có thể tự động khi được gọi. Nhóm mới luôn `disabled`; `interactive` chỉ mở sau một tin duyệt tay gửi thành công vào nhóm. Trong nhóm: chỉ công cụ *kiến thức*, không số liệu nội bộ.
- System Tools: chỉ đọc. AI không chọn người nhận: đích lấy từ hội thoại đã lưu.

## 3. Ngữ nghĩa gửi (OPS-04)

| Yêu cầu | Cách làm |
|---|---|
| Hàng bền | Bảng PostgreSQL `zalo_personal_reply_drafts` |
| Idempotency | Trả lời: `UNIQUE(inbound_id)` (một tin vào → tối đa một tin ra). Nhắc việc: `UNIQUE(source_key)` = `<notification>:zalo_personal` |
| Claim nguyên tử | `FOR UPDATE SKIP LOCKED`, một job / lần, một tin `sending` / hội thoại |
| Lease | 120 giây; hết lease khi đang `sending` → `delivery_unknown` (không đưa lại hàng) |
| Retry có giới hạn | Chỉ `not_sent` (chắc chắn chưa rời máy) được xếp lại, tối đa 3 lần |
| State machine | `pending_approval → queued → sending → sent / failed / delivery_unknown`; `rejected`, `cancelled`, `expired` |
| Audit | `zalo_personal_reply_audit` chỉ ghi thêm; trang Vận hành hiện 25 dòng gần nhất |
| Dừng êm | Worker hoàn tất tin đang gửi + báo kết quả trước khi thoát; nhật ký gửi ghi **trước** khi gửi |

zca-js **không** có idempotency key: hệ thống không giả định exactly-once. Kết quả không rõ → `delivery_unknown`, **không tự gửi lại**, người vận hành đối soát trên điện thoại rồi bấm xác nhận.

## 4. Giới hạn & chống vòng lặp (OPS-05)

| Biện pháp | Mặc định |
|---|---|
| Tin của chính bot (`is_self`) | Không bao giờ được phân tích lại |
| Chống trùng | Sự kiện: `UNIQUE(connection, event_key)`; tin: `UNIQUE(connection, conversation, external_message_id)`; inbound / draft như mục 3 |
| Giãn cách / hội thoại | 60 giây (tối thiểu 5) |
| Mỗi người / giờ | 10 |
| Mỗi nhóm / giờ | 20 |
| Mỗi hội thoại / ngày | 20 |
| Mỗi kết nối / ngày | 50 |
| Toàn hệ thống / ngày | `PERSONAL_REPLY_GLOBAL_DAILY_LIMIT` = 100 |
| Worker | Tối thiểu 5 giây giữa hai lần gửi |
| Độ dài trả lời | 1.800 ký tự |
| Lượt AI | Giới hạn của Phase 04/05 (token vào/ra, số lần gọi / phút / người / ngày) |
| Người lạ | Không trả lời tự động |
| Bot khác | Danh sách chặn theo Zalo ID; mọi giới hạn trên chặn ping-pong (một bot khác chỉ nhận ≤ 10 tin / giờ, và chỉ khi nó đã được liên kết) |
| Dừng khẩn cấp | Nút trên trang Vận hành / Cài đặt; `npm run stop` trên máy worker |

Khi Zalo từ chối gửi: tin `failed`, kết nối tự `send_paused`. Khi Zalo từ chối / đá phiên: worker dừng (mã thoát 3) và **không tự đăng nhập lại**. Không có cơ chế vượt giới hạn hay xác minh của Zalo.

## 5. Nhắc việc qua Zalo (OPS-06)

`zaloPersonalQueueAdapter` (`src/lib/ai-tasks/channels.ts`) **không nói chuyện với Zalo**: nó đưa nhắc việc vào hàng ở mục 3 (`kind = 'reminder'`). Thứ tự cổng:

1. Phase 06: kill switch `ZALO_NOTIFY_KILL_SWITCH` (mặc định **bật**) → `ZALO_NOTIFY_PERSONAL_ENABLED` → cài đặt của người dùng → adapter khả dụng (`PERSONAL_SEND_ENABLED`) → **người nhận đã xác minh** (liên kết `ai_channel_identities` của chính người đó, ưu tiên kết nối của task) → giới hạn / giờ.
2. `zp_reply_enqueue_reminder`: kiểm tra lại liên kết + hồ sơ còn hoạt động + hội thoại 1-1 tồn tại; idempotent.
3. Lúc claim: dừng khẩn cấp, `send_enabled`, tạm dừng, giới hạn, liên kết, **kênh còn bật**, **task chưa đóng**.

Trạng thái giao `notification_deliveries` = `pending` khi xếp hàng, rồi `sending` / `sent` (+ msg id) / `failed` / `unknown` / `skipped` theo trigger. Không bao giờ ghi `sent` khi chưa có báo cáo của worker.

**Không gửi hàng loạt khi khôi phục:** mỗi nhắc có hạn gửi = chính sách gửi bù của Phase 06: DAY 60′, HOUR 15′, OVERDUE (+ tổng hợp) 60′, MORNING tới 10:00 giờ VN. Worker offline quá hạn → `expired`, giao = `skipped expired`. Nội dung chỉ là tiêu đề task (`[Nhắc việc] …`), gửi vào chat 1-1 của chính người nhận, không bao giờ vào nhóm. Thông báo web luôn chạy độc lập.

## 6. Giám sát sức khỏe (OPS-07)

Mỗi phút, sau reply tick: `runOpsCheck` → `zp_ops_snapshot` → `classifyConnection` → `zp_ops_observe`.

| Trạng thái | Điều kiện |
|---|---|
| `stopped` | Kết nối bị tắt |
| `unknown` | Chưa từng nhận trạng thái worker |
| `authentication_required` | Listener không chạy **và** phiên bị từ chối / bị đá / không có phiên |
| `disconnected` | Heartbeat > 3 phút, hoặc listener dừng |
| `degraded` | Đang kết nối lại; dead letter; hàng chờ ≥ 100; tạm dừng gửi; có tin `delivery_unknown`; có tin lỗi 24h; cron trả lời > 5 phút không chạy |
| `healthy` | Heartbeat mới + phiên đã đăng nhập + listener chạy + không có lý do nào ở trên |

**Cảnh báo:** thông báo web `ops_alert` cho chủ kết nối khi chuyển *vào* trạng thái xấu, và một lần khi hồi phục. Tối đa 1 cảnh báo / trạng thái / 6 giờ: worker chập chờn không làm ngập hộp thư.

AI: `unconfigured` / `fake` / `quota_limited` / `failing` / `ok` / `idle` từ cấu hình + `ai_request_usage` 24h. Nhắc việc: `off` / `stale` (bộ lập lịch > 5 phút không chạy) / `behind` / `failing` / `ok`.

Trang **Vận hành** (`/apps/zalo/personal/operations`, admin, permission `zalo_personal:operate`): worker, phiên, heartbeat, lỗi gần nhất, chế độ, phạm vi tự động, hàng gửi (chờ duyệt / chờ gửi / đang gửi / chưa rõ / lỗi), AI (lần gọi, lỗi hạn mức, token), nhắc việc, dừng khẩn cấp, tạm dừng kết nối, nhật ký. Mọi nút dùng lại API đã có kiểm quyền backend. Không hiển thị secret, session hay Zalo ID đầy đủ.

## 7. Bảo mật phiên (OPS-08)

| Yêu cầu | Hiện trạng (đã kiểm tra code) |
|---|---|
| Không log cookie / token | Logger chỉ ghi mã lỗi + bộ đếm; test kiểm tra cookie giả không xuất hiện trong file |
| Không commit session | Thư mục dữ liệu mặc định ngoài repo (`%LOCALAPPDATA%\CongTrangBedding\zalo-personal`); worker từ chối thư mục dữ liệu nằm trong Git (trừ `.data` đã ignore); `.dockerignore` loại `.env`, `.data` |
| Không lưu session trong DB | Session chỉ ở máy worker; DB chỉ có secret HMAC của worker (mã hóa bằng `APP_ENCRYPTION_KEY`) |
| Windows | DPAPI theo người dùng Windows |
| Linux | `aes-key` (AES-256-GCM) với `ZP_SESSION_KEY` từ secret của dịch vụ; file `0600`, thư mục `0700`, container chạy user `node` |
| Thu hồi | `npm run logout` (đăng xuất + xóa phiên), `npm run session:clear`; thu hồi worker trên dashboard (Kết nối) |
| Bị từ chối phiên | Dừng, mã thoát 3, không thử lại. Supervisor Windows / Docker không khởi động lại |
| Lỗi mạng | Backoff có giới hạn trong worker (2 s → 2 phút, 6 lần), rồi mã thoát 5 → supervisor chờ ≥ 5 phút, tối đa 6 lần / 24h (Windows) / 5 lần (Docker) |

**Không sao chép session Windows (DPAPI) sang Linux**: không giải mã được, và Zalo có thể coi là đăng nhập lạ. Trên VPS phải `login` bằng QR mới.

**Bảo vệ tài khoản chính:**
- Không mở Zalo Web / PC của tài khoản bot khi worker chạy.
- Không chạy 2 worker cùng tài khoản.
- Giữ giới hạn gửi thấp.
- Gặp yêu cầu xác minh / cảnh báo thì dừng ngay và kiểm tra trên điện thoại.
- Cân nhắc dùng một tài khoản Zalo riêng cho bot thay vì tài khoản cá nhân chính.

## 8. Runbook Windows (OPS-09)

Thư mục `services\zalo-personal-worker`:

| Việc | Lệnh / thao tác |
|---|---|
| Build | `npm ci` rồi `npm run build` |
| Khởi động có giám sát | `powershell -ExecutionPolicy Bypass -File ops\windows\run-worker.ps1` (`-Dev` để chạy `src/`) |
| Tự chạy khi đăng nhập Windows | `powershell -ExecutionPolicy Bypass -File ops\windows\register-task.ps1` (gỡ: thêm `-Remove`) |
| Trạng thái | `npm run status` (offline) · `npm run healthcheck` (mã 0 = đang kết nối) · trang **Vận hành** |
| Log | `%LOCALAPPDATA%\CongTrangBedding\zalo-personal\logs\` (`supervisor.log`, `events-*.jsonl` chỉ metadata) |
| Heartbeat | Trang Vận hành → "Heartbeat gần nhất" (phải < 3 phút) |
| Bật / tắt trả lời | Trang **Cài đặt trả lời** (chế độ, công tắc gửi); cờ server trên Vercel |
| Dừng khẩn cấp | Nút trên trang Vận hành, hoặc `npm run stop` (tạo file STOP; gỡ bằng `npm run resume`) |
| Sau mất điện / reboot | Task Scheduler tự chạy sau đăng nhập (trễ 1 phút). Kiểm tra trang Vận hành. Nếu "Cần đăng nhập lại": `npm run login` |
| Sao lưu cấu hình | Sao `.env` **không kèm** `ZP_WORKER_KEY`/secret sang nơi an toàn; không sao file phiên (DPAPI gắn với người dùng Windows) |
| Kiểm tra quyền dữ liệu nhạy cảm | Thư mục dữ liệu chỉ người dùng hiện tại đọc được (`icacls %LOCALAPPDATA%\CongTrangBedding`) |

Supervisor (`run-worker.ps1`): `0` dừng chủ động → kết thúc; `2/3/4` → kết thúc và ghi "MANUAL ACTION REQUIRED"; `1/5` → khởi động lại sau 30 s · 2ⁿ (≥ 5 phút nếu lỗi mạng), tối đa 6 lần / 24h. Task Scheduler: `MultipleInstances = IgnoreNew`; worker tự giữ lock (bản thứ hai thoát mã 4). Khởi động worker **không** bật gửi: gửi theo `.env` + cờ server + công tắc kết nối.

## 9. Runbook VPS / Docker (OPS-10) — chưa triển khai

| Thành phần | File |
|---|---|
| Image | `services/zalo-personal-worker/Dockerfile` (multi-stage, Node 24 slim, user `node`, không chứa session / `.env`) |
| Entrypoint | `ops/docker/entrypoint.sh`: chuyển tiếp SIGTERM, cùng chính sách mã thoát với Windows |
| Compose | `ops/docker/docker-compose.yml`: volume `/data`, `restart: on-failure:5`, healthcheck, giới hạn, log xoay vòng 3 × 10 MB |
| Biến môi trường | `ops/docker/worker.env.example` → `worker.env` (chmod 600, không commit) |

Đã kiểm chứng ở local: image build được (348 MB); `status` và `healthcheck` chạy trong container; lỗi cấu hình làm container đứng yên, không khởi động lại (`RestartCount = 0`); `docker stop` dừng trong 0,3 s. **Chưa** chạy worker thật trong container (cần QR + tài khoản).

Quy trình (khi được duyệt):
1. Dừng worker Windows của tài khoản đó (`npm run stop`, gỡ task). **Không bao giờ chạy song song.**
2. `worker.env` (khóa `ZP_SESSION_KEY` mới, `ZP_INGEST_SECRET` do admin cấp).
3. `docker compose run --rm zalo-worker login` → QR ở `/data/qr/` → `docker cp` ra máy, quét bằng điện thoại.
4. `docker compose up -d`; kiểm tra trang Vận hành.

Container **không cần** service-role key: worker chỉ nói chuyện với backend qua HTTPS + HMAC. Không đặt worker trong Vercel function (cần kết nối WebSocket lâu dài).

**Cấu hình đề xuất (từ số đo, không đoán):** worker đo được 58 MB working set, đỉnh 108 MB, CPU trung bình ~0,2% một nhân (41 phút, Windows, tải thật thấp). Giới hạn container 320 MB / 0,5 CPU (≈ 3× đỉnh). VPS nhỏ nhất có 1 vCPU / 1 GB RAM là đủ cho worker + Docker; tải tăng theo số tin, nên đo lại sau 1 tuần chạy thật.

## 10. Feature flags & mặc định an toàn

| Cờ / cài đặt | Mặc định | Ghi chú |
|---|---|---|
| `PERSONAL_REPLY_ENABLED` | tắt | Router, bản nháp, dashboard, cron |
| `PERSONAL_SEND_ENABLED` | tắt | Kill switch toàn cục cho mọi tin gửi |
| `PERSONAL_AUTO_REPLY_ENABLED` | tắt | Cho phép chế độ tự động |
| `PERSONAL_REPLY_FAST_PATH` | bật (khi trả lời bật) | Realtime |
| `ZALO_NOTIFY_PERSONAL_ENABLED` | tắt | Nhắc việc qua Zalo |
| `ZALO_NOTIFY_KILL_SWITCH` | **bật** | Chặn mọi nhắc qua kênh ngoài |
| Kết nối mới: `reply_mode` | `draft_only` | Không gửi |
| Kết nối mới: `send_enabled` | tắt | |
| Kết nối mới: `auto_direct` / `auto_groups` | tắt | |
| Kết nối mới: `direct_message_mode` | `metadata` | Khuyên chuyển sang `linked` khi cần trả lời 1-1 |
| Worker `ZP_SEND_ENABLED` | tắt | |

00081 **giữ nguyên hành vi** của kết nối đang chạy: `draft_only` cũ (= duyệt rồi gửi) → `manual_approval`; `auto` → `auto_reply_allowlist` + `auto_direct = all_linked` (quyết định của chủ tài khoản 26/11); `send_enabled = true` cho kết nối đã từng gửi thành công. `direct_message_mode` không bị đổi tự động.

## 11. Kiểm thử

| Bộ test | Nội dung | Kết quả (local, 26/11/2026) |
|---|---|---|
| `src/lib/zalo-reply/zalo-ops.test.ts` (mới) | Phân loại sức khỏe, AI, nhắc việc; adapter nhắc; hạn gửi; quyền | 14/14 |
| `src/lib/zalo-reply/zalo-ops.integration.test.ts` (mới) | Allowlist nội dung 1-1, `content_stored`, chế độ, công tắc gửi, bỏ qua cờ, phạm vi allowlist, nhắc việc (xác minh, idempotent, đóng task, hết hạn, kênh tắt, dừng khẩn cấp), sức khỏe + cảnh báo không lặp, giả mạo người nhận, liên kết bị thu hồi | 23/23 |
| `zalo-reply.test.ts` / `.integration.test.ts` | Phase 04.5 (cập nhật theo chế độ mới) | 46/46 · 21/21 |
| Phase 02–06 + Web Conversation / OA + permissions | Hồi quy | 311/311 |
| Worker | Toàn bộ (mock session) | 154/154 |
| E2E Playwright `scripts/e2e/zalo-reply-045.ts` | + chế độ nội dung 1-1, trang Vận hành, staff không thấy | 14/14 |
| `scripts/e2e/zalo-reply-realtime.ts` | Độ trễ server | ~2,0–2,2 s |

Test tự động chỉ dùng mock sender và AI giả. **Không gửi tin Zalo thật trong CI.**

**Kịch bản test thủ công** (tài khoản thử nghiệm đã được duyệt):
1. Kiểm tra tài khoản Zalo bot trên điện thoại (không cảnh báo, không yêu cầu xác minh).
2. Khởi động worker (`run-worker.ps1`), trang Vận hành → "Hoạt động tốt".
3. `npm run status`: phiên `active`.
4. Đặt "Nội dung chat 1-1" = **Chỉ người đã liên kết**. Gửi 1 tin 1-1 từ tài khoản đã liên kết và 1 tin từ tài khoản chưa liên kết.
5. Hội thoại: tin của người đã liên kết có nội dung, tin người lạ chỉ có metadata.
6. Chế độ **Duyệt tay rồi gửi**: bản nháp xuất hiện trong Hộp duyệt.
7. Mở chi tiết: nguồn, người đọc, quyền yêu cầu.
8. Duyệt một tin.
9. Người nhận nhận được; Lịch sử gửi → "Đã gửi".
10. Chuyển **Tự động trong phạm vi**, 1-1 = **Chỉ các chat trong danh sách cho phép**, thêm đúng một chat thử nghiệm.
11. Hỏi một câu không nhạy cảm từ chat đó: trả lời trong vài giây. Từ chat khác: chờ duyệt.
12. Gửi 3 câu liên tiếp: câu sau chờ giãn cách. Tin bot gửi không tạo bản nháp mới.
13. Đặt 1-1 = **Không tự động** (các tin tự động chưa gửi bị hủy).
14. **Dừng khẩn cấp** → duyệt một tin → không có gì được gửi. Gỡ dừng (admin).
15. Kiểm tra Zalo OA (webhook / gửi) và Web Conversation vẫn hoạt động.

## 12. Xử lý sự cố

| Dấu hiệu | Việc làm |
|---|---|
| "Cần đăng nhập lại" (bị đá / từ chối) | Kiểm tra điện thoại; đóng Zalo Web / PC của tài khoản; `npm run login`; không thử lại liên tục |
| "Mất kết nối" | Máy worker / mạng; `npm run status`; xem `supervisor.log` |
| "Cần chú ý: cron không chạy" | Kiểm tra Vault `zp_reply_tick_url`, `cron.job_run_details`, deploy Vercel |
| "Có tin chưa rõ đã gửi" | Xem chat trên điện thoại → bấm "Đã gửi" / "Chưa gửi" trong chi tiết tin |
| Zalo từ chối gửi (kết nối tự tạm dừng) | Kiểm tra tài khoản trên điện thoại trước khi "Cho phép gửi lại" |
| Bot không trả lời 1-1 | Trang Vận hành → "Nội dung chat 1-1 được lưu"; worker `ZP_DIRECT_MESSAGES=content`; người hỏi đã liên kết chưa; lý do trong Hộp duyệt ("Tin gọi bot không được trả lời") |
| Nghi bot trả lời sai / lộ dữ liệu | **Dừng khẩn cấp** ngay → xem nhật ký → chuyển chế độ `manual_approval` |
| Hết hạn mức AI | Trang Vận hành → AI "Hết hạn mức"; câu trả lời chuyển sang mẫu cố định; không tự bật trả phí |

## 13. Rollback

| Mức | Cách làm | Mất dữ liệu? |
|---|---|---|
| 0. Dừng gửi ngay | Dừng khẩn cấp / `npm run stop` / công tắc gửi của kết nối | Không |
| 1. Về duyệt tay | Chế độ `manual_approval`, 1-1 + nhóm tự động tắt (tin tự động chưa gửi bị hủy) | Không |
| 2. Tắt cờ | `PERSONAL_AUTO_REPLY_ENABLED` / `PERSONAL_SEND_ENABLED` / `ZALO_NOTIFY_PERSONAL_ENABLED` = false | Không |
| 3. Gỡ code | `git revert` commit Phase 07. Lưu ý: code Phase 04.5 cũ không hiểu giá trị chế độ mới → phải đi kèm mức 4 | Không |
| 4. Gỡ 00081 (**chỉ khi chủ dự án duyệt**) | Đổi lại giá trị chế độ (`disabled→off`, `manual_approval→draft_only`, `auto_reply_allowlist→auto`, `draft_only→draft_only`), xóa cột `send_enabled/auto_direct/auto_groups`, `source_key/notification_id`, bảng `zalo_personal_ops_state`, trigger + hàm mới; chạy lại định nghĩa hàm từ 00073 (`zp_ingest_events`), 00079 (`zp_reply_scan_claim`, `zp_reply_act`, `zp_reply_admin`) và 00080 (`zp_reply_store_result`, `zp_reply_claim_outbound` 5 tham số) | Bản nháp nhắc việc, trạng thái vận hành |

`direct_message_mode = linked` phải đổi về `content` / `metadata` trước khi gỡ CHECK.
