# Vận hành đồng bộ Shopee (SHOPEE-PERF-1)

Tài liệu vận hành cho kiến trúc đồng bộ nền nhiều shop. Thiết kế chi tiết:
`docs/shopee-financial-core.md` → mục **Multi-Shop Sync Architecture**.

```
Shopee API ──► sync job (worker, chạy nền) ──► Supabase ──► UI (chỉ đọc DB)
```

Trang `/shopee/orders`, `/shopee/products`, `/shopee/sync` **không bao giờ**
gọi Shopee. Nút "Đồng bộ ngay" chỉ thêm một job vào hàng đợi
`channel_sync_jobs` rồi trả lời ngay.

---

## 1. Thành phần

| Thành phần | Ở đâu | Việc |
|---|---|---|
| Hàng đợi | bảng `channel_sync_jobs` (migration 00045) | trạng thái, checkpoint, số liệu từng job |
| Enqueue | `requestShopeeSync()` → RPC `enqueue_sync_job` | idempotent: đã có job đang hoạt động thì trả lại job đó |
| Claim | RPC `claim_next_sync_job` | nguyên tử (advisory lock + `FOR UPDATE SKIP LOCKED`) |
| Worker | `POST/GET /api/internal/shopee/sync-worker` | thu hồi job treo, chạy các lượt (slice) có giới hạn trong ~45 s |
| Scheduler | `POST/GET /api/internal/shopee/sync-scheduler` | thu hồi job treo, tạo job incremental đến hạn cho từng shop, kích worker |
| Log | `channel_sync_logs` (cột `job_id`) | 1 dòng tóm tắt / job |
| Checkpoint | `channel_sync_states` | `last_success_at` chỉ tiến khi job sạch lỗi |
| Màn hình | `/shopee/sync` | trạng thái từng shop, hàng đợi, job gần đây, cấu hình |

## 2. Hàng đợi & ưu tiên

- Trạng thái: `pending` → `running` → `success` | `retry` | `failed` | `cancelled`.
- **Ưu tiên: số NHỎ chạy TRƯỚC** — thủ công `5`, tự động (incremental) `10`,
  sửa lỗi (repair) `50`, backfill `100`. Backfill không bao giờ chặn job
  incremental.
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
- hết ngân sách → job về `pending` (chạy tiếp ngay ở lượt sau), không giữ
  request mở cho tới khi xong cả shop.

Worker chạy các lượt liên tiếp tới khi hết `SHOPEE_SYNC_WORKER_BUDGET_MS`
(mặc định 45 s; route `maxDuration = 60`). Worker chết giữa chừng → phát lại
tối đa 1 trang / 1 lô (upsert idempotent nên an toàn).

**Self-chaining**: nếu một lần chạy bị cắt vì hết thời gian mà vẫn còn job đến
hạn, worker tự gọi lần chạy kế tiếp (tối đa `SHOPEE_SYNC_MAX_CHAIN_HOPS`, mặc
định 10). Không chain khi job còn lại đang bị chặn (cap toàn cục / cùng shop)
để tránh vòng gọi rỗng. Cần `SYNC_WORKER_SECRET` (hoặc `CRON_SECRET`).

## 5. Giảm số lệnh gọi API

- **Đơn**: `get_order_list` không trả `update_time` từng đơn, nhưng một đơn
  xuất hiện trong cửa sổ [from, to] nghĩa là `update_time ∈ [from, to]`. Đơn
  chỉ được gọi `get_order_detail` khi: mới; đổi trạng thái; thiếu dòng hàng;
  bản lưu cũ hơn đầu cửa sổ; đơn đang xử lý (UNPAID / READY_TO_SHIP /
  PROCESSED / SHIPPED / IN_CANCEL…) cũ hơn TTL
  (`SHOPEE_SYNC_ACTIVE_ORDER_TTL_MINUTES`, mặc định 30); repair. Quy tắc nằm
  trong `shouldRefreshOrderDetail()` (`src/lib/channels/shopee/sync-decisions.ts`).
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
cũ hơn `SHOPEE_SYNC_STALE_JOB_MINUTES` (mặc định 10) được scheduler/worker
đưa về `retry` (chạy lại ngay, giữ checkpoint, `metadata.recoveries` + 1);
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

## 10. Lên lịch chạy (bắt buộc cho đồng bộ tự động)

Endpoint nhận `Authorization: Bearer <SYNC_WORKER_SECRET>` hoặc
`Bearer <CRON_SECRET>`; thiếu cả hai biến → luôn 401. Cả GET và POST.

Nhịp đề xuất: scheduler **5 phút**; worker **1–2 phút**. Đơn đến hạn mỗi
`SHOPEE_SYNC_ORDER_INTERVAL_MINUTES` (10), sản phẩm mỗi
`SHOPEE_SYNC_PRODUCT_INTERVAL_MINUTES` (60). Scheduler chạy 2 lần liên tiếp
cũng an toàn (enqueue idempotent; shop vừa chạy chưa đến hạn).

### Vercel Hobby (hiện tại)

Cron của Vercel Hobby chỉ chạy **1 lần/ngày** — thêm lịch dày vào
`vercel.json` sẽ làm deploy lỗi, nên repo **không** thêm. Dùng Supabase
`pg_cron` + `pg_net` (có sẵn trên Supabase, miễn phí). Chạy một lần trong
SQL Editor của project cloud (thay URL + secret):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Secret lưu trong Vault, không nằm trong định nghĩa cron.
select vault.create_secret('<SYNC_WORKER_SECRET>', 'sync_worker_secret');

select cron.schedule('shopee-sync-scheduler', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://theo-doi-hang-ve.vercel.app/api/internal/shopee/sync-scheduler',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'sync_worker_secret')),
    timeout_milliseconds := 10000
  );
$$);

select cron.schedule('shopee-sync-worker', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://theo-doi-hang-ve.vercel.app/api/internal/shopee/sync-worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'sync_worker_secret')),
    timeout_milliseconds := 10000
  );
$$);
```

Gỡ: `select cron.unschedule('shopee-sync-scheduler'); select cron.unschedule('shopee-sync-worker');`
Xem lịch sử: `select * from cron.job_run_details order by start_time desc limit 20;`

Không cấu hình gì → đồng bộ chỉ chạy khi có người bấm "Đồng bộ ngay" (job
vẫn được xử lý nền nhờ `after()` + self-chaining).

### Vercel Pro (khi nâng cấp)

Thêm vào `vercel.json` (Vercel tự gửi `Bearer $CRON_SECRET`), rồi gỡ 2 lịch
`pg_cron` ở trên để không chạy trùng (chạy trùng vẫn an toàn, chỉ tốn lượt gọi):

```json
{ "path": "/api/internal/shopee/sync-scheduler", "schedule": "*/5 * * * *" },
{ "path": "/api/internal/shopee/sync-worker", "schedule": "*/2 * * * *" }
```

Cron không chạy dưới 1 phút; Vercel cũng không đảm bảo đúng từng giây —
hệ thống không phụ thuộc vào điều đó.

## 11. Cấu hình (env, server-only)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SYNC_WORKER_SECRET` | — | secret cho `/api/internal/*` (pg_cron, cron ngoài, self-chain) |
| `SHOPEE_SYNC_GLOBAL_WORKERS` | 1 | số job chạy cùng lúc (mọi shop) |
| `SHOPEE_SYNC_ORDER_CONCURRENCY` | 3 | lô `get_order_detail` song song trong 1 job |
| `SHOPEE_SYNC_PRODUCT_CONCURRENCY` | 3 | `get_model_list` song song trong 1 job |
| `SHOPEE_SYNC_ORDER_OVERLAP_MINUTES` | 10 | chồng lấn cửa sổ đơn |
| `SHOPEE_SYNC_PRODUCT_OVERLAP_MINUTES` | 5 | chồng lấn cửa sổ sản phẩm |
| `SHOPEE_SYNC_ACTIVE_ORDER_TTL_MINUTES` | 30 | TTL làm mới đơn đang xử lý |
| `SHOPEE_SYNC_MAX_BATCH_API_CALLS` | 30 | lệnh gọi tối đa / lượt |
| `SHOPEE_SYNC_SLICE_BUDGET_MS` | 20000 | thời gian tối đa / lượt |
| `SHOPEE_SYNC_WORKER_BUDGET_MS` | 45000 | thời gian tối đa / lần gọi worker (< `maxDuration` 60 s) |
| `SHOPEE_SYNC_STALE_JOB_MINUTES` | 10 | ngưỡng job treo |
| `SHOPEE_SYNC_ORDER_INTERVAL_MINUTES` | 10 | nhịp đơn |
| `SHOPEE_SYNC_PRODUCT_INTERVAL_MINUTES` | 60 | nhịp sản phẩm |
| `SHOPEE_SYNC_MAX_CHAIN_HOPS` | 10 | số lần tự gọi tiếp (0 = tắt) |
| `SHOPEE_SYNC_SHOP_IDS` | (trống = mọi shop) | rollout: chỉ đồng bộ các shop id này (phân tách bằng dấu phẩy) |

Giá trị sai → dùng mặc định và hiện cảnh báo ở thẻ "Cấu hình đồng bộ" trên
`/shopee/sync`. Tăng dần, đừng bắt đầu bằng mức tối đa.

## 12. Rollout 5 shop

1. **Pilot 1 shop**: `SHOPEE_SYNC_SHOP_IDS=<id shop đang dùng>`, mặc định
   (1 job, concurrency 3). Theo dõi 2–3 ngày trên `/shopee/sync`: thời gian
   chạy, số lệnh API mỗi job, `rate-limit`, lỗi.
2. **2 shop**: thêm id thứ 2. Nếu job đơn mất > 1 phút hoặc hàng đợi tồn
   (`Đang chờ` tăng dần) → cân nhắc `SHOPEE_SYNC_GLOBAL_WORKERS=2`.
3. **5 shop**: bỏ `SHOPEE_SYNC_SHOP_IDS`. Chỉ tăng concurrency khi không có
   rate-limit trong vài ngày.

**Cài đặt khuyến nghị**

| | 1 shop | trước khi bật 5 shop |
|---|---|---|
| `SHOPEE_SYNC_GLOBAL_WORKERS` | 1 | 2 (chỉ khi hàng đợi bị dồn) |
| `SHOPEE_SYNC_ORDER_CONCURRENCY` | 3 | 3 (lên 5 chỉ khi 0 rate-limit) |
| `SHOPEE_SYNC_PRODUCT_CONCURRENCY` | 3 | 3 |
| `SHOPEE_SYNC_MAX_BATCH_API_CALLS` | 30 | 30 |
| `SHOPEE_SYNC_ORDER_INTERVAL_MINUTES` | 10 | 10 (5 nếu cần nhanh hơn và quota cho phép) |
| `SHOPEE_SYNC_PRODUCT_INTERVAL_MINUTES` | 60 | 60 |
| Lịch | pg_cron 5 / 2 phút | như cũ (hoặc Vercel Cron khi lên Pro) |

## 13. Lưu giữ dữ liệu

- `channel_sync_jobs`: giữ job `success` 30–90 ngày, job `failed` lâu hơn
  nếu cần điều tra. Chưa có cron dọn tự động — dọn tay khi cần:
  ```sql
  delete from public.channel_sync_jobs
  where status in ('success', 'cancelled') and finished_at < now() - interval '60 days';
  ```
  (`channel_sync_logs.job_id` tự về NULL; log tóm tắt vẫn còn.)
- `channel_sync_logs`: lịch sử/audit (1 dòng/job), giữ lâu hơn jobs.
- Snapshot thô: chính sách cũ giữ nguyên (sản phẩm: chỉ bản mới nhất; đơn:
  lần đầu + khi thay đổi có ý nghĩa). Job bỏ qua đơn/sản phẩm không đổi nên
  cũng không ghi thêm snapshot.

## 14. Xử lý sự cố

| Triệu chứng | Kiểm tra |
|---|---|
| "Dữ liệu cập nhật lần cuối" đứng yên | `/shopee/sync`: có job `Đang chờ` mãi? → lịch (mục 10) chưa chạy: xem `cron.job_run_details`, log Vercel `SYNC_SCHEDULER_RUN` / `SYNC_JOB_SLICE` |
| Job `Thất bại` mã `error_auth` / token | kết nối lại shop ở Tích hợp Shopee, rồi "Thử lại" |
| Job `Chờ thử lại` nhiều, `rate-limit` > 0 | giảm `SHOPEE_SYNC_ORDER_CONCURRENCY`, tăng nhịp đơn; job tự chạy lại theo backoff |
| Job `partial` lặp lại, checkpoint không tiến | xem `metadata.failures` (lỗi từng đơn); sửa nguyên nhân hoặc tạo job repair cho các mã đó |
| `source_mismatch` | shop fixture chạy ở live mode (hoặc ngược lại) — đúng thiết kế, không fallback |
| Job `running` lâu | lượt chạy tối đa ~20 s; > 10 phút không heartbeat → tự thu hồi |
| Worker 401 | `SYNC_WORKER_SECRET` / `CRON_SECRET` trên Vercel và trong Vault khác nhau |

Log Vercel (JSON, không có token/payload): `SYNC_JOB_SLICE` (mỗi lượt: job,
shop, trạng thái, số lệnh API, thời gian), `SYNC_SCHEDULER_RUN`,
`SYNC_KICK_FAILED`, `SYNC_WORKER_FAILED`.

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
