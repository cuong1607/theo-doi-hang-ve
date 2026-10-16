# Vận hành đồng bộ Shopee (SHOPEE-PERF-1 + PERF-2)

Tài liệu vận hành cho kiến trúc đồng bộ nền nhiều shop. Thiết kế chi tiết:
`docs/shopee-financial-core.md` → mục **Multi-Shop Sync Architecture**.

```
pg_cron (mỗi phút) ──► /sync-scheduler ──► channel_sync_jobs ──► worker (bounded, after())
                                                                   │
Shopee API ◄───────────────────────────────────────────────────────┘──► Supabase ──► UI (chỉ đọc DB)
```

Từ PERF-2, **vận hành bình thường không cần bấm nút**: đơn hàng (5 phút),
tài chính/escrow (15 phút) và sản phẩm (60 phút) tự đồng bộ. Trang
`/shopee/orders`, `/shopee/products`, `/shopee/sync` **không bao giờ** gọi
Shopee. Nút "Đồng bộ ngay" chỉ đưa một job lên đầu hàng đợi rồi trả lời
ngay (vẫn giữ cho: cần ngay, sửa lỗi, backfill, debug).

## 0. Vì sao trước PERF-2 đồng bộ "đứng"

Kiểm tra production ngày 16/10/2026: job đơn `manual` `pending` từ 14/10,
job escrow `pending` sau 3 lượt (18/98 đơn), không có `channel_sync_states`
cho đơn/escrow, chưa cài `pg_cron`/`pg_net`.

1. **Chưa có scheduler production**: Vercel Hobby chỉ cho cron 1 lần/ngày,
   lịch pg_cron trong tài liệu PERF-1 chưa từng được tạo → scheduler chưa
   chạy lần nào.
2. **Job chỉ chạy tiếp khi có người bấm**: lượt kế tiếp phụ thuộc `after()`
   của nút "Đồng bộ ngay" + self-chain HTTP; chain không chạy tiếp trên
   production → job nằm `pending` (vẫn claim được, chỉ là không ai gọi worker).
3. Click "Đồng bộ tài chính" và "Đồng bộ đơn" cùng ưu tiên 5 → FIFO, job
   escrow chặn job đơn.

Không có job nào bị đánh `success` sớm; không có job `pending` nào bị chặn
claim ngoài cap toàn cục / cùng shop+loại đang chạy (đúng thiết kế).

---

## 1. Thành phần

| Thành phần | Ở đâu | Việc |
|---|---|---|
| Hàng đợi | bảng `channel_sync_jobs` (migration 00045) | trạng thái, checkpoint, số liệu từng job |
| Enqueue | `requestShopeeSync()` → RPC `enqueue_sync_job` | idempotent: đã có job đang hoạt động thì trả lại job đó |
| Claim | RPC `claim_next_sync_job` | nguyên tử (advisory lock + `FOR UPDATE SKIP LOCKED`) |
| Lịch | Supabase `pg_cron` job `shopee-sync-scheduler` (migration 00050) | mỗi phút: `public.shopee_sync_cron_tick()` → `pg_net` POST scheduler |
| Scheduler | `POST/GET /api/internal/shopee/sync-scheduler` | heartbeat, thu hồi job treo, tạo job đến hạn cho từng shop, dọn job cũ, trả lời ngay rồi chạy worker burst trong `after()` |
| Worker | `POST/GET /api/internal/shopee/sync-worker` | (vận hành/thủ công) thu hồi job treo, chạy các lượt có giới hạn trong ~45 s |
| Đo region | `GET /api/internal/shopee/latency-probe` | đo round-trip Supabase + Shopee từ region đang chạy (chỉ đọc) |
| Sức khỏe | `channel_sync_heartbeats` | `shopee_sync_scheduler` / `shopee_sync_worker`: lần chạy, lần thành công, lỗi gần nhất |
| Log | `channel_sync_logs` (cột `job_id`) | 1 dòng tóm tắt / job |
| Checkpoint | `channel_sync_states` | nguồn lập lịch: `last_success_at` chỉ tiến khi job sạch lỗi |
| Màn hình | `/shopee/sync` | ma trận Shop × Đơn/Sản phẩm/Tài chính, hàng đợi, scheduler, job gần đây, cấu hình |

## 2. Hàng đợi & ưu tiên

- Trạng thái: `pending` → `running` → `success` | `retry` | `failed` | `cancelled`.
- **Ưu tiên: số NHỎ chạy TRƯỚC** (`SYNC_PRIORITY` trong `sync-config.ts`):
  thủ công đơn `1` / tài chính `2` / sản phẩm `3`, sửa lỗi `5`, tự động đơn
  `10`, tự động tài chính `20`, tự động sản phẩm `30`, backfill `100`. Đơn
  mới luôn được xử lý trước backlog tài chính / danh mục / lịch sử.
- **Duy nhất**: mỗi shop + loại đồng bộ có tối đa 1 job đang hoạt động
  (pending/running/retry) cho mỗi "làn": làn **live** (incremental, manual,
  repair) và làn **backfill**. Bấm "Đồng bộ ngay" khi đã có job tự động đang
  chờ → không tạo job mới, chỉ đẩy job đó lên ưu tiên 5.
- **Không chạy song song cùng shop + loại**: claim bỏ qua job nếu shop đó đang
  có job cùng loại `running` (kể cả job ở làn kia). Đơn hàng và sản phẩm của
  cùng một shop vẫn chạy song song được.
- **Giới hạn toàn cục**: tối đa `SHOPEE_SYNC_GLOBAL_WORKERS` job `running`
  cùng lúc trên mọi shop (mặc định **1**).

## 3. Incremental vs backfill

| | Incremental / thủ công | Backfill |
|---|---|---|
| Đơn hàng | cửa sổ `update_time` = [lần thành công − 10 phút, lúc bắt đầu job]; chưa có lần nào → 15 ngày gần nhất | khoảng do admin chọn (mặc định 30 ngày, tối đa 180), tự chia cửa sổ ≤ 15 ngày, đi lần lượt |
| Sản phẩm | `get_item_list` lọc `update_time` từ lần thành công − 5 phút; chưa có lần nào → quét toàn bộ | quét toàn bộ danh mục (mọi trạng thái), vẫn bỏ qua sản phẩm không đổi |
| Tiến checkpoint | có (nếu không lỗi) | đơn: không; sản phẩm: có (quét toàn bộ phủ hết tới lúc bắt đầu) |
| Ưu tiên | 10 (thủ công 5) | 100 |

Backfill được thiết kế là **một job duy nhất có thể resume**, đi qua từng
cửa sổ 15 ngày (checkpoint lưu cửa sổ hiện tại + cursor). Cách này tương
đương "6 job × 15 ngày" nhưng giữ được quy tắc một job đang hoạt động mỗi làn.

**Repair** (`mode = repair`): chỉ xử lý những mã nằm trong
`metadata.scope.orderSns` / `metadata.scope.itemIds` (tối đa 200 mã/job), luôn
gọi chi tiết; repair sản phẩm không có danh sách → quét toàn bộ và tải lại hết.

## 4. Giới hạn mỗi lượt chạy (bounded execution)

Một lần gọi worker = vài **lượt (slice)**. Mỗi lượt:

- tối đa `SHOPEE_SYNC_MAX_BATCH_API_CALLS` lệnh gọi Shopee (mặc định 30) và
  `SHOPEE_SYNC_SLICE_BUDGET_MS` (mặc định 20 s);
- kiểm tra ngân sách **trước** mỗi trang danh sách / mỗi lô chi tiết;
- lưu checkpoint **sau mỗi trang** (cursor/offset + danh sách mã cần tải chi
  tiết, ghi cùng lúc) và **sau mỗi lô chi tiết**;
- hết ngân sách → job về `pending` (chạy tiếp ở lượt sau), không giữ
  request mở cho tới khi xong cả shop. Đây là **tiếp tục bình thường**, không
  phải `retry`/`failed`/`success`; lý do ghi ở `metadata.continuationReason`
  (`time_budget` = hết thời gian lượt, `batch_limit` = hết số lệnh API) và
  `metadata.remainingWork` (`more_pages` / `more_details` / `more_records`).
- job chỉ `success` (có `finished_at`) khi **không còn việc trong phạm vi**:
  đơn — hết trang + hết chi tiết cần tải; sản phẩm — hết trang + hết chi
  tiết/biến thể; escrow — hết đơn đủ điều kiện.

Worker chạy các lượt liên tiếp tới khi hết `SHOPEE_SYNC_WORKER_BUDGET_MS`
(mặc định 45 s — soft deadline; route `maxDuration = 60`). Worker chết giữa
chừng → phát lại tối đa 1 trang / 1 lô (upsert idempotent nên an toàn).

**Drain hàng đợi**: mỗi phút pg_cron gọi scheduler → 1 worker burst
(`SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS`, ≤ `SHOPEE_SYNC_GLOBAL_WORKERS`).
08:00 lượt 1 → 08:01 lượt 2 → … → `success`, không ai bấm. Self-chaining
(`SHOPEE_SYNC_MAX_CHAIN_HOPS`) mặc định **tắt (0)** từ PERF-2 — chính cơ chế
này không chạy tiếp được trên production; chỉ bật khi không có cron dày.

## 5. Giảm số lệnh gọi API

- **Đơn**: `get_order_list` không trả `update_time` từng đơn, nhưng một đơn
  xuất hiện trong cửa sổ [from, to] nghĩa là `update_time ∈ [from, to]`. Đơn
  chỉ được gọi `get_order_detail` khi: mới; đổi trạng thái; thiếu dòng hàng;
  bản lưu cũ hơn đầu cửa sổ; đơn đang xử lý cũ hơn TTL theo trạng thái;
  repair. Quy tắc nằm trong `shouldRefreshOrderDetail()`, bảng TTL **duy
  nhất** là `ORDER_DETAIL_TTL_MINUTES` (`src/lib/channels/shopee/sync-decisions.ts`):

  | Trạng thái | TTL |
  |---|---|
  | UNPAID, READY_TO_SHIP, PROCESSED, RETRY_SHIP | 30 phút |
  | SHIPPED, TO_CONFIRM_RECEIVE, TO_RETURN | 60 phút |
  | IN_CANCEL | 15 phút |
  | COMPLETED, CANCELLED | không tải lại theo tuổi (chỉ khi đổi trạng thái / update_time / repair) |
  | trạng thái đang xử lý khác | `SHOPEE_SYNC_ACTIVE_ORDER_TTL_MINUTES` (30) |
- **Sản phẩm**: so `update_time` của `get_item_list` với
  `channel_products.source_updated_at`; chỉ tải lại khi khác, khi mới, hoặc
  khi chưa có biến thể nào được lưu (`shouldRefreshProductDetail()`).
- Lý do tải / bỏ qua được đếm trong `metadata.stats.refreshReasons` và
  `detailsSkippedUnchanged`.
- Token: mỗi job đọc + giải mã token **một lần** cho mỗi shop
  (`JobTokenCache`), cơ chế refresh an toàn đồng thời của SHOPEE-1 giữ nguyên.

Số đo thật (production build, fixture, bản e2e): đồng bộ đơn lần 2 khi không
có thay đổi: **6 → 2 lệnh gọi** (chỉ còn `get_order_list`); sản phẩm
**4 → 2** (chỉ còn `get_item_list`). Với dữ liệu thật, tỉ lệ tiết kiệm tăng
theo số đơn: phần lớn đơn trong cửa sổ chồng lấn (overlap) không còn bị tải
lại chi tiết.

## 6. Retry, rate limit, lỗi

| Lỗi | Xử lý |
|---|---|
| timeout, network, 5xx, provider busy | `retry`, backoff ~1 → 5 → 15 phút (+ ≤ 20 % jitter) |
| rate limit (429 / mã "too many…") | `retry`; tôn trọng `Retry-After` nếu dài hơn; đếm `rateLimitHits` |
| sai chữ ký, token hết hạn/thu hồi, auth, tham số sai, payload hỏng, thiếu cấu hình, shop sai nguồn dữ liệu | `failed` ngay, **không** retry mù |
| lỗi một đơn / một sản phẩm | ghi vào `metadata.failures`, lô vẫn chạy tiếp; job kết thúc `success` với log `partial`, checkpoint **không** tiến |

- Sau `max_attempts` (mặc định 3) lần liên tiếp không tiến triển → `failed`
  (dead letter). Admin bấm **"Thử lại"** ở `/shopee/sync`: job về `pending`,
  **giữ checkpoint** (backfill chạy tiếp từ chỗ dừng), có log mới.
- Không ngủ dài trong request: client của worker chỉ retry 1 lần, nghỉ tối đa
  2 s; chờ lâu hơn = `next_attempt_at`.
- `attempt_count` = số lần liên tiếp chưa tiến triển (về 0 khi một lượt chạy
  xong có tiến triển).

## 7. Job treo (stale)

Mỗi checkpoint làm mới `locked_at` (heartbeat). Job `running` có `locked_at`
cũ hơn `SHOPEE_SYNC_STALE_JOB_MINUTES` (mặc định **3** — một lượt ≤ 20 s và
mỗi trang/lô đều heartbeat, function bị kill ở 60 s, nên lease cũ hơn 3 phút
chắc chắn đã chết) được scheduler (mỗi phút) / worker đưa về `retry` (chạy
lại ngay, xóa `lock_owner`/`locked_at`, giữ checkpoint, `metadata.recoveries`
+ 1, đếm vào `recovered` của log `SYNC_SCHEDULER_RUN` — tương đương
`STALE_JOB_RECOVERED`);
đã quá `max_attempts` → `failed` (log đóng lại). Worker cũ "sống lại" không
ghi đè được vì mọi lệnh ghi đều yêu cầu `lock_owner` = chính nó.

## 8. Hủy job

- `pending` / `retry` → hủy ngay.
- `running` → đặt `cancel_requested`; worker dừng ở checkpoint kế tiếp (không
  kill giữa transaction).
- Quyền: admin (`channel:manage`).

## 9. Quyền

| Việc | admin | staff | viewer |
|---|---|---|---|
| Xem trạng thái đồng bộ | ✔ | ✔ | ✔ |
| "Đồng bộ ngay" (incremental) | ✔ | ✔ (`channel:sync`) | — |
| Backfill / quét toàn bộ / thử lại / hủy | ✔ (`channel:manage`) | — | — |
| Xem nội dung lỗi chi tiết | ✔ | chỉ mã lỗi | chỉ mã lỗi |
| Worker / scheduler | chỉ server (secret) | | |

## 10. Lịch chạy production (PERF-2)

### Vì sao pg_cron + pg_net (không phải Vercel Cron)

- Project đang ở **Vercel Hobby**: cron chỉ chạy tối đa **1 lần/ngày**; lịch
  dày trong `vercel.json` làm deploy lỗi.
- Supabase `pg_cron` chạy **mỗi phút**, không phụ thuộc trình duyệt / người
  dùng, lịch sử chạy truy vấn được (`cron.job_run_details`), và đã có sẵn
  trong project Supabase. Secret nằm trong **Vault**, không nằm trong repo.
- Chỉ **một** lịch: scheduler mỗi phút. Scheduler tự chạy worker burst trong
  `after()` (cùng invocation, ≤ 45 s) — không cần lịch worker riêng.

Migration **00050** cài `pg_cron` + `pg_net`, tạo hàm
`public.shopee_sync_cron_tick()` và lịch `shopee-sync-scheduler`
(`* * * * *`). Lịch ở trạng thái **ngủ** cho tới khi có 2 secret trong
Vault — hàm trả `not_configured` và không gửi gì.

### Bật lên production (làm một lần)

1. **Tạo secret** (máy cá nhân): `openssl rand -hex 32`.
2. **Vercel** → Project → Settings → Environment Variables → Production:
   `SHOPEE_SYNC_INTERNAL_SECRET = <secret>` (Sensitive; **không**
   `NEXT_PUBLIC_`). Redeploy để function nhận biến.
3. **Deploy code + migration**: `npx supabase db push --linked` (00050), rồi
   deploy app (push lên nhánh Vercel đang build).
4. **Supabase** → SQL Editor (project cloud), thay 2 giá trị:
   ```sql
   select vault.create_secret('https://theo-doi-hang-ve.vercel.app/api/internal/shopee/sync-scheduler', 'shopee_sync_scheduler_url');
   select vault.create_secret('<secret ở bước 1>', 'shopee_sync_internal_secret');
   ```
   Không dán secret vào file migration / repo / chat.
5. **Kiểm tra** (sau 1–2 phút):
   ```sql
   select status, return_message, start_time from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'shopee-sync-scheduler')
   order by start_time desc limit 5;                       -- succeeded, "1 row"
   select status_code, left(content, 200) from net._http_response order by id desc limit 5;  -- 200
   select * from public.channel_sync_heartbeats;           -- last_run_at mỗi phút
   ```
   và `/shopee/sync` → thẻ "Scheduler chạy gần nhất" cập nhật mỗi phút.

`status_code` 401 → secret trên Vercel ≠ secret trong Vault (hoặc chưa
redeploy). 500 → xem log Vercel `SYNC_SCHEDULER_FAILED`.

### Tạm dừng / bật lại / đổi secret

```sql
-- tạm dừng (giữ cấu hình)
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'shopee-sync-scheduler'), active := false);
-- bật lại
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'shopee-sync-scheduler'), active := true);
-- đổi secret: đổi trên Vercel + redeploy, rồi
select vault.update_secret((select id from vault.secrets where name = 'shopee_sync_internal_secret'), '<secret mới>');
-- tắt hẳn: xóa secret (hàm về not_configured) hoặc
select cron.unschedule('shopee-sync-scheduler');
```

Tắt lịch → sau `SHOPEE_SYNC_SCHEDULER_WARN_AFTER_MINUTES` (5) phút admin
thấy cảnh báo **"Scheduler đồng bộ Shopee có thể đang không hoạt động"** ở
`/shopee/sync`, `/shopee/orders`, `/shopee/products`.

### Chạy hàng đợi ngay (vận hành)

```bash
curl -X POST -H "Authorization: Bearer $SHOPEE_SYNC_INTERNAL_SECRET" https://theo-doi-hang-ve.vercel.app/api/internal/shopee/sync-worker
```

### Khi lên Vercel Pro

Có thể thay pg_cron bằng Vercel Cron (`"* * * * *"` cho
`/api/internal/shopee/sync-scheduler`, Vercel gửi `Bearer $CRON_SECRET`), rồi
tạm dừng lịch pg_cron. Chạy trùng vẫn an toàn (enqueue idempotent, claim
nguyên tử) nhưng tốn lượt gọi. Chưa cần đổi: pg_cron đủ dùng.

## 11. Cấu hình (env, server-only)

Mọi con số nằm ở `src/lib/channels/core/sync-config.ts` (env) và
`ORDER_DETAIL_TTL_MINUTES` / `SYNC_PRIORITY`; không rải số trong vòng lặp.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SHOPEE_SYNC_INTERNAL_SECRET` | — | secret cho `/api/internal/*` (pg_cron). `SYNC_WORKER_SECRET`, `CRON_SECRET` vẫn được chấp nhận |
| `SHOPEE_SYNC_GLOBAL_WORKERS` | 1 | số job chạy cùng lúc (mọi shop) |
| `SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS` | 1 | số worker burst mỗi tick (≤ GLOBAL_WORKERS) |
| `SHOPEE_SYNC_ORDER_INTERVAL_MINUTES` | **5** | nhịp đơn |
| `SHOPEE_SYNC_ESCROW_INTERVAL_MINUTES` | **15** | nhịp tài chính |
| `SHOPEE_SYNC_PRODUCT_INTERVAL_MINUTES` | 60 | nhịp sản phẩm |
| `SHOPEE_SYNC_ORDER_OVERLAP_MINUTES` | 10 | chồng lấn cửa sổ đơn |
| `SHOPEE_SYNC_PRODUCT_OVERLAP_MINUTES` | 5 | chồng lấn cửa sổ sản phẩm |
| `SHOPEE_SYNC_ACTIVE_ORDER_TTL_MINUTES` | 30 | TTL dự phòng cho trạng thái đang xử lý không có trong bảng TTL |
| `SHOPEE_SYNC_ORDER_CONCURRENCY` | 3 | lô `get_order_detail` song song trong 1 job |
| `SHOPEE_SYNC_PRODUCT_CONCURRENCY` | 3 | `get_model_list` song song trong 1 job |
| `SHOPEE_SYNC_ESCROW_CONCURRENCY` | **2** | `get_escrow_detail` song song trong 1 job |
| `SHOPEE_SYNC_MAX_BATCH_API_CALLS` | 30 | lệnh gọi tối đa / lượt |
| `SHOPEE_SYNC_SLICE_BUDGET_MS` | 20000 | thời gian tối đa / lượt |
| `SHOPEE_SYNC_WORKER_BUDGET_MS` | 45000 | soft deadline / lần chạy worker (< `maxDuration` 60 s) |
| `SHOPEE_SYNC_STALE_JOB_MINUTES` | 3 | ngưỡng job treo |
| `SHOPEE_SYNC_ESCROW_REFRESH_WINDOW_DAYS` | 14 | đơn hoàn tất trong N ngày còn được làm mới escrow |
| `SHOPEE_SYNC_SCHEDULER_INTERVAL_MINUTES` | 1 | nhịp cron mong đợi |
| `SHOPEE_SYNC_SCHEDULER_WARN_AFTER_MINUTES` | 5 | cảnh báo khi scheduler im lặng quá lâu (≥ 3 nhịp) |
| `SHOPEE_SYNC_JOB_RETENTION_DAYS` | 30 | job `success`/`cancelled` cũ hơn bị xóa (500 / tick) |
| `SHOPEE_SYNC_MAX_CHAIN_HOPS` | **0** | self-chain (tắt; chỉ dùng khi không có cron dày) |
| `SHOPEE_SYNC_SHOP_IDS` | (trống = mọi shop) | rollout: chỉ đồng bộ các shop id này |

Giá trị sai → dùng mặc định và hiện cảnh báo ở thẻ "Cấu hình đồng bộ" trên
`/shopee/sync`. Tăng dần, đừng bắt đầu bằng mức tối đa.

## 12. Rollout 5 shop

1. **Pilot 1 shop** (hiện tại chỉ có 1 shop live): đặt
   `SHOPEE_SYNC_SHOP_IDS=78cf7c29-2a15-4fb6-8b5d-b391763873ea`. Theo dõi ít
   nhất vài chu kỳ (lý tưởng 2–3 ngày) trên `/shopee/sync`: job đơn mỗi 5
   phút xong trong 1 lượt, API/lượt, `rate-limit` = 0, không có job `failed`,
   heartbeat đều mỗi phút.
2. **2 shop**: thêm id thứ 2 (phân tách dấu phẩy). Theo dõi hàng đợi: nếu
   `Đang chờ` tăng dần hoặc đơn > 5 phút mới vào → `SHOPEE_SYNC_GLOBAL_WORKERS=2`
   + `SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS=2`.
3. **5 shop**: bỏ `SHOPEE_SYNC_SHOP_IDS`. Chỉ tăng concurrency khi nhiều ngày
   không có rate-limit.

Không bật 5 shop cùng lúc trước khi pilot ổn định. Shop mới kết nối chạy job
đầu tiên = 15 ngày đơn + quét toàn bộ sản phẩm → nên thêm từng shop một.

**Cài đặt khởi đầu**

| | Giá trị |
|---|---|
| Global workers / worker trigger | 1 / 1 |
| Nhịp đơn / tài chính / sản phẩm | 5 / 15 / 60 phút |
| Chồng lấn đơn | 10 phút |
| Concurrency chi tiết đơn / sản phẩm / escrow | 3 / 3 / 2 |
| Soft deadline worker | 45 s (`maxDuration` 60) |
| Lịch | pg_cron mỗi phút → scheduler |

## 12a. Region (đo, không đoán)

Đã xác nhận (16/10/2026): function Vercel chạy ở **iad1** (header
`x-vercel-id: hkg1::iad1::…`); Supabase ở **ap-southeast-2 (Sydney)**;
Shopee Open API phân giải về `sg-sg10…shopeemobile.com` (**Singapore**).

Baseline thật ở iad1 (metadata job production 14/10): escrow **18 đơn /
64,2 s ≈ 3,6 s/đơn**; product 55 lệnh API / 57,7 s.

Mỗi đơn escrow = 1 lệnh Shopee + ~6 round-trip Supabase (đọc đơn, snapshot,
RPC apply, đọc COGS, checkpoint) → số round-trip DB lớn hơn số lệnh Shopee
nhiều lần. Ứng viên:

| Region | Supabase (Sydney) | Shopee (Singapore) |
|---|---|---|
| iad1 (hiện tại) | xa (Mỹ ↔ Úc) | xa (Mỹ ↔ SG) |
| sin1 | ~1 vòng SG ↔ Sydney / query | gần |
| syd1 | gần | ~1 vòng Sydney ↔ SG / lệnh |

Giả thuyết: **syd1** nhanh nhất cho sync (và cho mọi trang, vì trang nào cũng
đọc DB nhiều lần); sin1 tốt hơn iad1 nhưng mỗi query DB vẫn phải đi
SG ↔ Sydney. **Phải đo trước khi đổi**: Hobby chỉ cho 1 region cho cả
project (`"regions"` trong `vercel.json`; `preferredRegion` chỉ dành cho Edge
— không dùng).

Quy trình đo:
1. Deploy PERF-2 ở iad1 (chưa đổi region). Gọi probe 3 lần:
   `curl -H "Authorization: Bearer $SHOPEE_SYNC_INTERNAL_SECRET" https://theo-doi-hang-ve.vercel.app/api/internal/shopee/latency-probe`
   → `supabaseSelectMs.p50`, `shopeeGetOrderListMs.p50`.
2. Để vài chu kỳ chạy; mỗi job ghi `metadata.latencyMs` (n / tổng / max /
   mẫu cho p50) theo **từng API** (`get_order_detail`, `get_item_base_info`,
   `get_model_list`, `get_escrow_detail`, …) và `db_checkpoint` (1 lần ghi
   Supabase), cùng `metadata.regions`.
3. Thêm `"regions": ["syd1"]` (hoặc `sin1`) vào `vercel.json`, deploy, lặp
   lại bước 1–2. So sánh bằng:
   ```sql
   select metadata->'regions' r, sync_type,
          avg(((metadata->'latencyMs'->'db_checkpoint'->>'totalMs')::numeric) / nullif((metadata->'latencyMs'->'db_checkpoint'->>'n')::numeric, 0)) db_ms,
          avg(((metadata->'latencyMs'->'get_escrow_detail'->>'totalMs')::numeric) / nullif((metadata->'latencyMs'->'get_escrow_detail'->>'n')::numeric, 0)) escrow_ms,
          avg(((metadata->'latencyMs'->'get_order_detail'->>'totalMs')::numeric) / nullif((metadata->'latencyMs'->'get_order_detail'->>'n')::numeric, 0)) order_detail_ms,
          avg((metadata->>'durationMs')::numeric) job_ms
   from public.channel_sync_jobs where created_at > now() - interval '2 days' group by 1, 2 order by 2, 1;
   ```
4. Giữ region có tổng thời gian job thấp hơn; ghi số đo vào mục này.

## 12b. Job tài chính (escrow, SHOPEE-5)

- `sync_type = 'escrow'`, scheduler tự tạo mỗi `SHOPEE_SYNC_ESCROW_INTERVAL_MINUTES`
  (mặc định **15**, ưu tiên 20 — sau đơn, trước sản phẩm); nút "Đồng bộ tài
  chính" chỉ đưa job lên đầu hàng đợi.
- Mỗi lượt: hỏi DB các đơn cần lấy escrow (chỉ `COMPLETED`), tối đa
  `SHOPEE_SYNC_ESCROW_BATCH_SIZE` (20) đơn / lô, 1 lệnh `get_escrow_detail` / đơn,
  tối đa `SHOPEE_SYNC_ESCROW_CONCURRENCY` (2) lệnh song song, checkpoint sau
  mỗi nhóm.
- Tiến độ: `metadata.stats.eligible` (đếm lúc bắt đầu, RPC
  `count_orders_needing_escrow_sync` — cùng một quy tắc với danh sách),
  `ordersChecked` (đã xử lý), `remaining` (còn lại, cập nhật mỗi lượt),
  `matched` / `mismatch` / `warning`, `missingCogs`, `notReady`, `errors`.
  Backlog (vd. ~98 đơn hoàn tất) được xử lý qua nhiều lượt cron cho tới
  `remaining = 0` → `success`.
- Điều kiện (một chỗ, `get_orders_needing_escrow_sync`): chưa có escrow; đổi
  `FINANCIAL_CALCULATION_VERSION`; Shopee cập nhật đơn sau lần lấy escrow;
  đơn hoàn tất trong 14 ngày và lần lấy cuối > 24 giờ; lỗi trước đó (sau
  backoff 6 giờ). Đơn cũ hơn 14 ngày đã ổn định → bỏ qua. Repair luôn lấy.
- Làm mới: đơn hoàn tất trong `SHOPEE_SYNC_ESCROW_REFRESH_WINDOW_DAYS` (14) ngày
  được lấy lại mỗi `SHOPEE_SYNC_ESCROW_REFRESH_INTERVAL_HOURS` (24) giờ; đơn cũ
  ổn định không lấy lại (dùng repair nếu cần).
- Shopee trả "chưa có escrow" → ghi lỗi trên đơn, chờ
  `SHOPEE_SYNC_ESCROW_ERROR_BACKOFF_HOURS` (6) giờ mới thử lại.
- Repair: `requestShopeeSync({ syncType: "escrow", mode: "repair", orderSns })`
  (tối đa 200 đơn) — lấy lại bắt buộc, kể cả đơn vừa sync. Dùng sau khi đổi
  `financial-dictionary.ts` / `FINANCIAL_CALCULATION_VERSION`.
- Kiểm tra nhanh:
  ```sql
  select reconciliation_status, count(*) from public.order_financials group by 1;
  select escrow_last_error_code, count(*) from public.order_financials
  where escrow_last_error_code is not null group by 1;
  ```

## 13. Lưu giữ dữ liệu

- `channel_sync_jobs`: lịch tự động tạo ~400 job/ngày/shop (đơn 288, tài
  chính 96, sản phẩm 24). Scheduler tự xóa job `success`/`cancelled` cũ hơn
  `SHOPEE_SYNC_JOB_RETENTION_DAYS` (30) — tối đa 500 job/tick
  (RPC `prune_channel_sync_jobs`). Job `failed` được giữ để điều tra.
  (`channel_sync_logs.job_id` tự về NULL; log tóm tắt vẫn còn.)
- `channel_sync_logs`: lịch sử/audit (1 dòng/job), chưa tự dọn (~400 dòng
  nhỏ/ngày/shop).
- `cron.job_run_details`: lịch `cron-run-history-cleanup` (03:17 mỗi ngày)
  xóa bản ghi > 7 ngày. `net._http_response`: pg_net tự xóa sau vài giờ.
- Snapshot thô (carry-forward #6): đồng bộ định kỳ **không** làm snapshot
  tăng theo nhịp: sản phẩm chỉ giữ bản mới nhất; đơn chỉ lần đầu + khi thay
  đổi có ý nghĩa (fingerprint); escrow chỉ mỗi phiên bản tài chính khác nhau,
  lần lấy trùng cập nhật tại chỗ; đơn/sản phẩm không đổi bị bỏ qua nên không
  ghi gì. Số snapshot tăng theo số thay đổi thật, không theo số lần chạy.

## 14. Xử lý sự cố

| Triệu chứng | Kiểm tra |
|---|---|
| Cảnh báo "Scheduler … có thể đang không hoạt động" | `select * from cron.job where jobname = 'shopee-sync-scheduler'` (`active`?), `cron.job_run_details` (failed?), `net._http_response` (401 = lệch secret, 5xx = xem log Vercel), `select public.shopee_sync_cron_tick()` trả `not_configured` = thiếu secret Vault |
| "… được cập nhật gần nhất lúc" đứng yên nhưng scheduler chạy | `/shopee/sync`: job `Đang chờ`/`Đang thử lại`? `metadata.continuationReason`, `next_attempt_at`, có job `running` chặn cap toàn cục không; heartbeat `shopee_sync_worker.last_result` |
| Job kẹt `running` | tự thu hồi sau 3 phút không heartbeat (tick kế tiếp). Gỡ tay: `update public.channel_sync_jobs set status = 'retry', lock_owner = null, locked_at = null, next_attempt_at = now() where id = '<id>' and status = 'running';` |
| Job `failed` cần chạy lại | `/shopee/sync` → "Thử lại" (giữ checkpoint), hoặc chờ lần đến hạn tiếp theo (scheduler tạo job mới) |
| Job `Thất bại` mã `error_auth` / token | kết nối lại shop ở Tích hợp Shopee, rồi "Thử lại" |
| Job `Chờ thử lại` nhiều, `rate-limit` > 0 | giảm `SHOPEE_SYNC_ORDER_CONCURRENCY`, tăng nhịp đơn; job tự chạy lại theo backoff |
| Job `partial` lặp lại, checkpoint không tiến | xem `metadata.failures` (lỗi từng đơn); sửa nguyên nhân hoặc tạo job repair cho các mã đó |
| `source_mismatch` | shop fixture chạy ở live mode (hoặc ngược lại) — đúng thiết kế, không fallback |
| Worker / scheduler 401 | `SHOPEE_SYNC_INTERNAL_SECRET` trên Vercel ≠ `shopee_sync_internal_secret` trong Vault, hoặc chưa redeploy sau khi đặt biến |

Log Vercel (JSON, không có token/payload/secret): `SYNC_JOB_SLICE` (mỗi lượt:
job, shop, trạng thái, `continuationReason`, số lệnh API, thời gian),
`SYNC_SCHEDULER_RUN` (region, recovered, enqueued, notDue, pruned, workDue),
`SYNC_SCHEDULER_FAILED`, `SYNC_KICK_FAILED`, `SYNC_WORKER_FAILED`.

## 14b. "Đồng bộ sản phẩm" ≠ "Tự động ghép SKU"

| Nút | Luồng | Gọi Shopee? |
|---|---|---|
| Đồng bộ sản phẩm | Shopee API → `channel_products` / `channel_product_models` (job nền) | có |
| Tự động ghép SKU | biến thể đã lưu → SKU nội bộ (RPC `auto_map_channel_models`, migration 00046) | **không** |

Ghép SKU chạy hoàn toàn trong Postgres (một câu lệnh theo tập, ~0,4 s cho
5.937 biến thể), chạy được cả khi Shopee lỗi. Có biến thể mới trên Shopee →
đồng bộ sản phẩm trước, xong mới ghép. Lỗi ghép được log `AUTO_MAP_FAILED`
kèm `operation`, `shopId`, `postgresCode`, `details`, `hint`.

Scheduler (PERF-2) không bao giờ gọi auto-map hay `get_model_list`: ghép SKU
chỉ chạy (DB-only, chỉ dòng chưa ghép, không ghi đè ghép tay/lịch sử) ở
bước cuối của job đồng bộ sản phẩm, hoặc khi người dùng bấm nút.

Region: xem mục 12a.

## 15. Giới hạn đã biết

- Danh sách đơn của Shopee không có `update_time` → đơn đã tải trong vùng
  chồng lấn, cùng trạng thái, được coi là không đổi (trừ đơn đang xử lý quá
  TTL). Một thay đổi cùng trạng thái của đơn đã hoàn tất trong vòng ~10 phút
  sau lần tải trước có thể chậm tới lần đổi trạng thái kế tiếp hoặc job
  repair. Chưa kiểm chứng trên payload Go-Live.
- Một đơn lỗi vĩnh viễn giữ checkpoint không tiến → mỗi lần chạy quét lại cửa
  sổ dài hơn (rẻ vì đơn không đổi chỉ tốn trang danh sách); cần repair/xử lý.
- `ensureItems` (đơn tham chiếu sản phẩm chưa có) gọi thêm API sản phẩm trong
  lô chi tiết — được đếm nhưng có thể vượt nhẹ ngân sách lượt.
- Giới hạn tốc độ thật của Shopee chưa được công bố/kiểm chứng → mặc định thấp.

## 16. Đồng bộ tự động và giá vốn

- Đơn mới/đổi trạng thái do lịch tự động tải về đi qua đúng luồng COGS đã
  có (SHOPEE-4: `cost_process_order` theo giá vốn bình quân hiện tại). Đồng
  bộ tự động **không** tính lại giá vốn lịch sử và không ghi đè COGS đã chốt
  (trigger CG001/CG002).
- Nút "Dựng lại sổ giá vốn (sửa lỗi)" ở `/inventory/costs` (trước đây "Tính
  lại giá vốn"): chỉ admin (`cost:manage`), là thao tác sửa lỗi — dựng lại
  sổ/bình quân từ phiếu nhập + đơn đã ghi; COGS đã chốt của đơn cũ giữ
  nguyên. Không cần cho vận hành hằng ngày. Việc tính lại COGS lịch sử (nếu
  cần) thuộc một phase riêng.
