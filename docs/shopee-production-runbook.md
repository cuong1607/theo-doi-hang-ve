# Shopee — runbook vận hành production (SHOPEE-9A)

> **SHOPEE-ADS-0 (28/10/2026):** các module Shopee cũ đã ngừng (`SHOPEE_LEGACY_MODULES_ENABLED=false`) — trang `/shopee/system-health` và `/shopee/sync` chuyển về `/shopee/ads`, scheduler không còn job cũ. Phần queue / scheduler / worker / token / retention / rate limit dưới đây vẫn đúng và sẽ dùng cho Ads. Xem [shopee-ads-migration.md](shopee-ads-migration.md).

Trang theo dõi chính: **`/shopee/system-health`** (admin; chỉ khi bật module cũ). Bảng job chi tiết: `/shopee/sync`.
Kiến trúc: pg_cron (mỗi phút) → `/api/internal/shopee/sync-scheduler` → tick (heartbeat, thu hồi job treo, lên lịch job đến hạn, dọn dữ liệu, thông báo hàng hoàn) → worker bursts trong `after()`. Không gì gọi Shopee khi render trang; mọi nút bấm chỉ đưa job vào hàng đợi.

## 0. Mục tiêu độ mới (SLO) và ngưỡng cảnh báo

| Loại | SLO mặc định | Nhịp scheduler | Biến môi trường |
|---|---|---|---|
| Đơn hàng | ≤ 10 phút | 5 phút | `SHOPEE_SLO_ORDER_MINUTES` |
| Trả hàng | ≤ 15 phút | 15 phút | `SHOPEE_SLO_RETURN_MINUTES` |
| Vận chuyển Hoàn Trả | ≤ 20 phút | 10 phút | `SHOPEE_SLO_RETURN_LOGISTICS_MINUTES` |
| Vận chuyển Hoàn Hủy | ≤ 25 phút | 15 phút | `SHOPEE_SLO_FAILED_DELIVERY_MINUTES` |
| Tài chính (escrow) | ≤ 30 phút | 15 phút | `SHOPEE_SLO_ESCROW_MINUTES` |
| Giải ngân | ≤ 30 phút | 20 phút | `SHOPEE_SLO_INCOME_MINUTES` |
| Payout | ≤ 90 phút | 60 phút | `SHOPEE_SLO_PAYOUT_MINUTES` |
| Sản phẩm | ≤ 90 phút | 60 phút | `SHOPEE_SLO_PRODUCT_MINUTES` |

SLO payout / sản phẩm là 90 phút (không phải 60) vì job của chúng chạy mỗi giờ — 60 sẽ báo động mỗi giờ. Độ mới = lần cuối một job của loại đó **kết thúc** (thành công hoặc một phần).

Ngưỡng khác (tập trung ở `src/lib/channels/core/sync-config.ts`): scheduler cũ > `SHOPEE_SYNC_SCHEDULER_WARN_AFTER_MINUTES` (5), worker cũ > `SHOPEE_SYNC_WORKER_WARN_AFTER_MINUTES` (10), job chờ > `SHOPEE_SYNC_OLDEST_PENDING_WARN_MINUTES` (20).

## 1. Scheduler không chạy ("Scheduler chưa chạy trong N phút")
1. Supabase → SQL: `select * from cron.job_run_details order by start_time desc limit 5;` — lỗi gì?
2. `select public.shopee_sync_cron_tick();` → `not_configured` = thiếu Vault secret `shopee_sync_scheduler_url` / `shopee_sync_internal_secret`.
3. Gọi tay: `curl -X POST -H "Authorization: Bearer $SHOPEE_SYNC_INTERNAL_SECRET" https://<app>/api/internal/shopee/sync-scheduler` → 401 = secret lệch giữa Vault và Vercel.
4. Tạm thời: nút **Chạy scheduler 1 lần** trên trang health.

## 2. Worker không chạy, scheduler vẫn chạy
- Log Vercel route `sync-scheduler`: `worker_triggered` có không? `SYNC_WORKER_FAILED`?
- `workDue=false` → hàng đợi trống (bình thường).
- Function bị kill (60 s): giảm `SHOPEE_SYNC_WORKER_BUDGET_MS` / `SHOPEE_SYNC_SLICE_BUDGET_MS`.
- Nút **Chạy worker 1 lượt** chạy một burst 30 s.

## 3. Job treo (đang "chạy" nhưng không cập nhật)
Tự thu hồi mỗi tick khi lease cũ hơn `SHOPEE_SYNC_STALE_JOB_MINUTES` (3): running → retry, giữ checkpoint, đếm `recoveries`. Quá `max_attempts` (5) → failed `stale_worker`. Nút **Thu hồi job treo** làm ngay.

## 4. Job thất bại
`/shopee/sync` → bảng job → lỗi + loại lỗi (`metadata.lastErrorCategory`). "Thử lại" tiếp tục từ điểm dừng.

| Loại lỗi | Ý nghĩa | Xử lý |
|---|---|---|
| AUTH | token hết hạn / bị thu hồi | **Kết nối lại** ở Cài đặt → Shopee; không tự retry |
| RATE_LIMIT | Shopee giới hạn | tự lùi ≥ 5 phút, worker giảm còn 1 burst trong `SHOPEE_SYNC_RATE_LIMIT_COOLDOWN_MINUTES` (10) |
| PROVIDER_TEMPORARY / NETWORK / TIMEOUT | Shopee 5xx, mạng | tự thử lại 1 → 5 → 15 → 30 → 60 phút |
| PROVIDER_INVALID_REQUEST / DATA_MAPPING / CONFIG | yêu cầu sai, payload lạ, cấu hình | không retry mù — sửa code / cấu hình rồi "Thử lại" |
| DATABASE | lỗi Supabase | tự thử lại; kéo dài → mục 7 |

Lỗi của **một bản ghi** (đơn / return) không làm hỏng job — job kết thúc "một phần" và ghi lại bản ghi lỗi.

## 5. Một shop lỗi liên tục (circuit breaker)
Sau `SHOPEE_SYNC_CIRCUIT_BREAKER_FAILURES` (5) lần lỗi phía Shopee liên tiếp, shop tạm dừng `SHOPEE_SYNC_CIRCUIT_BREAKER_COOLDOWN_MINUTES` (30) phút: scheduler không lên lịch, worker không nhận job tự động của shop đó (job bấm tay vẫn chạy). Một job thành công đóng lại. Shop khác không bị ảnh hưởng. **Bật lại** trên trang health xoá thời gian chờ.

## 6. Tạm dừng một shop / tắt đồng bộ
- Một shop: nút **Tạm dừng / Bật lại** (`channel_shop_sync_controls.sync_enabled`).
- Toàn bộ tự động: `SHOPEE_AUTO_SYNC_ENABLED=false` (scheduler ngừng tạo job; job đã có + bấm tay vẫn chạy).
- Một loại: `SHOPEE_SYNC_DISABLED_TYPES=payout,return_logistics`.
- Chỉ vài shop (rollout): `SHOPEE_SYNC_SHOP_IDS=<uuid>,<uuid>`.

## 7. Sự cố Shopee / cơ sở dữ liệu
- Shopee sập: job tự retry với backoff, circuit breaker chặn shop lỗi liên tục; không cần làm gì, theo dõi trang health. Kéo dài nhiều giờ: `SHOPEE_AUTO_SYNC_ENABLED=false` để khỏi tích job.
- Supabase lỗi: tick lỗi → heartbeat scheduler `last_error`. Kiểm tra Supabase status / connection; không xoá job.

## 8. Checklist "Đơn không cập nhật"
1. Trang health: scheduler? worker?
2. Hàng đợi: job đơn của shop đang chờ / thử lại / thất bại? chờ bao lâu?
3. Shop: kết nối (cần kết nối lại?), tạm dừng / circuit breaker?
4. Lỗi gần nhất của job đơn (loại lỗi).
5. `channel_sync_states` (shop, order): `last_success_at` + `metadata.lastJobFinishedAt`.
6. Rate limit gần đây?
7. Lỗi DB trong log?

## 9. Hàng đợi, công bằng, đồng thời
- Claim nguyên tử: advisory lock + `FOR UPDATE SKIP LOCKED` (`claim_next_sync_job`).
- Toàn hệ thống tối đa `SHOPEE_SYNC_GLOBAL_WORKERS` job; mỗi shop tối đa `SHOPEE_SYNC_MAX_RUNNING_PER_SHOP` (1).
- Ưu tiên: bấm tay 1–3 → đơn 10 → trả hàng 15–17 → tài chính 20 → giải ngân 22 → payout 25 → sản phẩm 30 → **shop mới (lần đầu) 45–65** → backfill 100.
- Cùng mức ưu tiên: job chờ lâu nhất kể từ lần cuối được xếp hàng (`COALESCE(next_attempt_at, created_at)`) — job vừa chạy xong một lượt quay về **cuối hàng** → các shop luân phiên. (Sự cố 20/10/2026: 2 shop mới chạy lượt đầu chiếm worker, shop chính chậm 13–22 phút.)
- Chưa xong trong một lượt → về `pending` kèm checkpoint (không bao giờ "success" giữa chừng).

## 10. Dữ liệu và retention
Mỗi tick dọn theo lô 1000 dòng:
- `channel_api_snapshots`: chỉ dòng **lịch sử** (không phải bản mới nhất của thực thể) cũ hơn `SHOPEE_SNAPSHOT_RETENTION_DAYS` (30); escrow / income / payout / return / return_logistics: `SHOPEE_FINANCIAL_SNAPSHOT_RETENTION_DAYS` (180). Bản mới nhất của mỗi thực thể luôn giữ.
- `channel_sync_logs`: thành công `SHOPEE_SYNC_LOG_SUCCESS_RETENTION_DAYS` (14), lỗi / một phần `SHOPEE_SYNC_LOG_FAILURE_RETENTION_DAYS` (60).
- `channel_sync_jobs`: job đã xong cũ hơn 30 ngày (đã có từ PERF-2).
- **Không bao giờ xoá**: đơn, dòng đơn, tài chính, thành phần tài chính, trả hàng, đơn hoàn, payout, sổ giá vốn, notification_logs.

## 11. Ngân sách API (đo thật trên prod, 24 giờ, 20/10/2026)
Shop chính ~1 100 lượt gọi / ngày (~45 / giờ); shop mới ít hơn sau khi đồng bộ lần đầu xong. Ước tính 5 shop: ~250 lượt / giờ — thấp xa so với giới hạn Shopee. Xem số thật theo endpoint ở trang health (bảng "API Shopee 24 giờ").

## 12. Region Vercel (đo thật, chưa đổi)
- Function chạy **iad1** (Mỹ), Supabase **Sydney**, Shopee **Singapore**.
- Mỗi lượt ghi Supabase: trung bình **421 ms** (p50 273, p95 728); Shopee: 0,4–2 s mỗi lượt.
- Lưu một đơn ≈ 7 lượt DB → riêng DB đã ~3 s/đơn; số lượt DB lớn hơn số lượt gọi Shopee.
- Khuyến nghị: thử deploy **preview** ở `syd1` (cạnh Supabase) và `sin1` (cạnh Shopee), chạy `/api/internal/shopee/latency-probe` + so sánh `db_checkpoint` / `get_order_detail` ở trang health; chọn region có tổng thời gian job thấp nhất (dự đoán `syd1`). Không đổi region production khi chưa đo.

## 13. Onboarding một shop mới
1. Cài đặt → Shopee → **Kết nối** (OAuth) → trạng thái "Đã kết nối".
2. Trang health: shop xuất hiện, trạng thái **Đang khởi tạo** (chưa có lần đồng bộ sản phẩm / đơn / tài chính nào). Job lần đầu chạy ở ưu tiên 45–65: sản phẩm trước, rồi đơn, trả hàng, tài chính… — không chèn ép shop đang chạy.
3. Sản phẩm xong → `/shopee/products`: **Tự động ghép SKU** (chỉ DB), ghép tay các mẫu thường bán.
4. Đơn: cửa sổ lần đầu tôn trọng mốc `orders_from`; cần lịch sử cũ hơn → backfill **theo từng shop** (không bao giờ backfill nhiều shop cùng lúc).
5. Giá vốn: `/inventory/costs` → "Tính COGS còn thiếu" nếu có đơn thiếu.
6. Tài chính / trả hàng / giải ngân / payout tự chạy theo lịch.
7. Shop chuyển **Ổn định** khi mọi loại có lần đồng bộ thành công và trong SLO.

## 14. Cổng rollout (trước khi thêm shop kế tiếp)
- [ ] Không có job treo; job thất bại 24 h = 0 (hoặc đã hiểu nguyên nhân)
- [ ] Scheduler + worker "Ổn định" liên tục ≥ 12–24 h (không ai bấm)
- [ ] Đơn hàng của mọi shop trong SLO (≤ 10 phút); tài chính ≤ 30 phút
- [ ] Không lỗi AUTH lặp lại; không rate limit nghiêm trọng
- [ ] Job chờ lâu nhất < 20 phút; trang health không cảnh báo đỏ
- [ ] DB: bảng `channel_api_snapshots` / `channel_sync_logs` không tăng bất thường

Thứ tự: shop 2 → quan sát 24 h → shop 3 → 12–24 h → shop 4, 5 (từng shop). Có thể giới hạn bằng `SHOPEE_SYNC_SHOP_IDS` trong lúc rollout.

## 15. Triển khai
Trước khi deploy: migration đã push · env kiểm tra (`SHOPEE_SYNC_INTERNAL_SECRET`, `APP_ENCRYPTION_KEY`, partner) · `npm run build` · `npm test` · pg_cron + Vault secrets có · biết commit để quay lại.

Thứ tự: (1) `npx supabase db push --linked` → `npx supabase db query --linked "notify pgrst, 'reload schema';"` (2) deploy app (3) trang health: scheduler + worker xanh trong 5 phút (4) quan sát (5) mới thêm shop.

Migration 00063 tương thích ngược (bảng mới + hàm mới + index), không xoá cột: code đang chạy vẫn gọi được `claim_next_sync_job` mới (tham số `p_max_per_shop` có mặc định = 1). Chiều ngược lại thì KHÔNG: code mới trên DB chưa có 00063 sẽ lỗi khi nhận job → luôn push migration TRƯỚC khi deploy.

## 16. Quay lại (rollback)
1. `SHOPEE_AUTO_SYNC_ENABLED=false` (Vercel env → redeploy) — dừng tạo job tự động, giữ hàng đợi, bấm tay vẫn chạy.
2. Redeploy commit trước. Không xoá job / dữ liệu.
3. Nếu cần quay lại claim cũ: tạo lại hàm `claim_next_sync_job(text, integer, text[], uuid[])` từ migration 00045 (một câu SQL) — các bảng mới không ảnh hưởng code cũ.

## 17. Theo dõi sau deploy (24–48 h, không bấm tay)
Trang health mỗi vài giờ: scheduler / worker xanh, job chờ lâu nhất, độ mới từng shop, lỗi 24 h, rate limit, lượt API / shop, dung lượng bảng. Log Vercel: `scheduler_tick`, `job_*`, `shop_circuit_open`, `notification_tick`.
