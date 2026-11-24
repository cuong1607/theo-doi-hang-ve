# Zalo Personal Worker (Phase 01 — connector)

Một worker Node.js chạy lâu dài, kết nối **một tài khoản Zalo cá nhân** qua [`zca-js`](https://github.com/RFS-ADRENO/zca-js) để nhận sự kiện tin nhắn. Đây là nền móng cho trợ lý AI của CONGTRANGBEDDING ở các phase sau.

Worker độc lập hoàn toàn với ứng dụng Next.js. Nó có `package.json` riêng, không chạy trong API route hay Vercel Function, và **không đụng tới Zalo OA**.

> ⚠️ `zca-js` là API **không chính thức**: nó giả lập Zalo Web. README của chính thư viện ghi rõ tài khoản có thể bị khóa. Phase 01 chỉ **nghe**: worker không gửi tin, không tham gia nhóm, không đọc lịch sử.

Hướng dẫn chạy thử từng bước trên Windows: [WINDOWS-MANUAL-TEST.md](WINDOWS-MANUAL-TEST.md).

## Lệnh

| Lệnh | Việc làm | Mạng |
|---|---|---|
| `npm run login` | Đăng nhập bằng QR, lưu phiên đã mã hóa rồi thoát (không mở listener). `-- --force` thay phiên đang có | có |
| `npm run dev` | Chạy worker từ source với phiên đã lưu. Cố ý **không** dùng `--watch`: mỗi lần tự khởi động lại là một lần đăng nhập lại Zalo | có |
| `npm run build` → `npm start` | Build ra `dist/` rồi chạy bản build | có |
| `npm run status` | Trạng thái kết nối, bộ đếm, trạng thái phiên. Không giải mã, không gọi mạng | không |
| `npm run stop` / `npm run resume` | Bật / gỡ **dừng khẩn cấp** (file `STOP`) | không |
| `npm run logout` | Đăng xuất phiên phía Zalo, sau đó xóa phiên cục bộ | có |
| `npm run session:clear` | Chỉ xóa phiên cục bộ | không |
| `npm test` / `npm run typecheck` | Unit test (mock, không cần Zalo) / kiểm tra type | không |

Mã thoát của worker:

| Mã | Ý nghĩa |
|---|---|
| 0 | ok |
| 1 | lỗi ngoài dự kiến |
| 2 | sai cấu hình |
| 3 | **cần người vận hành xử lý**: chưa có phiên, phiên bị từ chối, bị đá, QR thất bại, kết nối lại quá số lần. Supervisor **không được** tự khởi động lại khi gặp mã này |
| 4 | bị chặn: tắt bằng `ZP_ENABLED`, đang có file `STOP`, hoặc đã có worker khác chạy |

## Kiến trúc

```
zca-js ──► zalo-client.ts (file DUY NHẤT import zca-js; chỉ đọc, không có API gửi)
              │
connection-manager.ts ── vòng đời + backoff ── connection-state.ts (máy trạng thái thuần)
              │   session-manager.ts ── session-protector.ts (DPAPI | AES-256-GCM)
              │   instance-lock.ts (1 worker / tài khoản) · stop-signal.ts (dừng khẩn cấp)
              ▼
message-listener.ts: normalize ─► group-filter ─► dedupe ─► metadata-sink (JSONL cục bộ)
              │            event-normalizer.ts    group-filter.ts   dedupe.ts   metadata-sink.ts
              ▼
health-monitor.ts (health.json: trạng thái + bộ đếm, không ID / nội dung)
qr-login.ts (chỉ dùng cho `npm run login`) · logger.ts (che thông tin nhạy cảm)
```

Module yêu cầu → file tương ứng: `connection-manager` → `connection-manager.ts` + `connection-state.ts`; `qr-login` → `qr-login.ts`; `session-manager` → `session-manager.ts` + `session-protector.ts`; `message-listener` → `message-listener.ts`; `event-normalizer` → `event-normalizer.ts`; `group-filter` → `group-filter.ts`; `health-monitor` → `health-monitor.ts`; `logger` → `logger.ts`.

### Trạng thái kết nối

`disconnected → connecting → connected`. Mất kết nối thì chuyển `reconnecting`: backoff lũy thừa có jitter, chặn trên bởi `ZP_RECONNECT_MAX_MS`, tối đa `ZP_RECONNECT_MAX_ATTEMPTS` lần liên tiếp; vượt quá thì `error`. `qr_pending` chỉ xuất hiện khi chạy `npm run login`.

Các trường hợp vào thẳng `error`, **không** tự thử lại:
- Zalo từ chối phiên: phiên được đánh dấu `rejected` và không bao giờ được dùng lại.
- Mã đóng 3000: tài khoản được mở trên Zalo Web ở nơi khác.
- Mã đóng 3003: phiên bị đá.
- Không có phiên, hoặc không đọc được phiên.

Listener của zca-js được chạy với `retryOnClose: false`. Mỗi lần thử, listener cũ được gỡ và dừng trước, nên không bao giờ có hai listener cùng lúc.

### Sự kiện

Kiểu nội bộ `NormalizedMessage` (`src/types.ts`) gồm các trường: `channel`, `connectionId`, `conversationId`, `conversationType`, `externalMessageId`, `senderExternalId`, `text`, `messageType`, `mentions`, `isSelf`, `sentAt`, `receivedAt`, và `issues` (các vấn đề không chặn).

- **Được nghe:** `message` (1-1 và nhóm, kể cả tin do chính tài khoản gửi vì `selfListen: true`), `undo`, `reaction`, `group_event`.
- **Không nghe:** typing, seen/delivered, `old_messages` (không backfill), friend_event, sync_event.

### Nhóm

- Nhóm chỉ được xử lý khi ID nằm trong `ZP_ALLOWED_GROUP_IDS`. Nhóm khác bị bỏ **trước** khi lưu bất cứ thứ gì; chỉ tăng một bộ đếm.
- **Phát hiện ID nhóm:** từ chính tài khoản của bạn, gửi đúng chuỗi `ZP_DISCOVERY_TOKEN` vào nhóm cần tìm. Worker in ra ID nhóm và ghi `{at, groupId}` vào `discovered-groups.jsonl`, không lưu gì khác. Thành viên khác gõ token này thì bị bỏ qua.

## Bảo mật

| Dữ liệu | Cách xử lý |
|---|---|
| Phiên (cookie, imei, user agent) | Lưu ở `session.json` trong thư mục dữ liệu (mặc định `%LOCALAPPDATA%\CongTrangBedding\zalo-personal`, ngoài repo). Payload được mã hóa bằng **Windows DPAPI** (scope CurrentUser, có entropy riêng của ứng dụng); dữ liệu đi qua stdin của PowerShell, không qua tham số dòng lệnh. Trên Linux dùng **AES-256-GCM** với `ZP_SESSION_KEY`. Đặt thư mục dữ liệu trong repo Git sẽ bị từ chối, trừ `.data/` (đã được ignore) |
| QR | Chỉ ghi ra `<dataDir>/qr/login-qr.png` để quét, **xóa ngay** khi đã quét, hết hạn, bị từ chối hoặc kết thúc đăng nhập. Không bao giờ log. Luôn truyền callback cho zca-js để thư viện không tự ghi `./qr.png` |
| Nội dung tin nhắn | Không ghi ra đâu cả. Log metadata chỉ có loại, độ dài, số mention, thời gian, và ID đã băm HMAC (salt ngẫu nhiên cho mỗi máy cài) |
| Log | Che theo tên khóa (cookie, token, session, imei, qr, text, content, tên hiển thị…) và theo dạng giá trị (chuỗi base64/hex dài). Lỗi chỉ log **tên + mã**, không bao giờ log message, vì lỗi của zca-js có thể nhúng phản hồi của server |
| Log của thư viện | Tắt (`logging: false`, `checkUpdate: false`) |

## Chạy trên Linux VPS (sau này)

- Dùng `ZP_SESSION_PROTECTION=aes-key`, với `ZP_SESSION_KEY` lấy từ secret store hoặc systemd credential, không ghi trong file của repo.
- Node ≥ 22.18. Chạy `npm ci && npm run build && npm start`.
- systemd: `Restart=on-failure` kèm `RestartPreventExitStatus=3 4`, để không vòng lặp đăng nhập khi phiên bị từ chối.
- Chỉ chạy **một** instance cho mỗi tài khoản.
- Phiên DPAPI tạo trên Windows **không** dùng được trên Linux. Trên VPS phải đăng nhập QR lại.

## Phase 02 — đồng bộ về backend

Bật bằng `ZP_INGEST_ENABLED=true` (mặc định tắt). Chi tiết: [docs/zalo-ai/phase-02-integration.md](../../docs/zalo-ai/phase-02-integration.md).

- **Luồng:** event được phép → `ingest/serializer.ts` (bỏ text 1-1 trừ khi `ZP_DIRECT_MESSAGES=content`) → outbox cục bộ mã hóa, bền qua restart → gửi HTTPS có ký HMAC tới `/api/internal/zalo-personal/events`. Heartbeat gửi tới `/heartbeat`.
- **Không có khóa Supabase trong worker.** Chỉ có HMAC secret của worker, nạp bằng `npm run ingest:set-secret` và lưu bằng DPAPI.
- **Retry:** backoff lũy thừa có jitter, tôn trọng `Retry-After`; quá `ZP_INGEST_MAX_ATTEMPTS` thì dead-letter. Gặp 401 / 403 / tài khoản không khớp thì **dừng gửi** (không retry vô hạn), giữ nguyên outbox.
- **Lệnh:** `ingest:set-secret`, `ingest:clear-secret`, `ingest:status`, `outbox:retry-dead`, `outbox:clear -- --yes`.

| File | Vai trò |
|---|---|
| `src/ingest/serializer.ts` | Wire event + `eventKey` ổn định, tối thiểu hóa dữ liệu |
| `src/ingest/outbox.ts` | Outbox: file nguyên tử, AES-256-GCM, giới hạn số event / dung lượng, dead-letter |
| `src/ingest/http-client.ts` | Client có ký (bắt buộc HTTPS), phân loại phản hồi |
| `src/ingest/delivery.ts` | Vòng gửi at-least-once |
| `src/ingest/heartbeat.ts` | Session / listener / backend / thời điểm tin gần nhất, tách riêng |
| `src/ingest/secret-store.ts` | Ingest secret + khóa outbox (DPAPI / AES) |
| `src/ingest/signing.ts` | **Bản sao** của `src/lib/zalo-personal/signing.ts`; hai bộ test cùng kiểm một vector cố định |
| `src/ingest/runtime.ts` | Lắp ráp các phần trên |

## Không có trong Phase 01

Gemini, Supabase, dashboard, tự trả lời, gửi tin, đồng bộ toàn bộ nhóm, backfill lịch sử, triển khai lên VPS hoặc Vercel.
