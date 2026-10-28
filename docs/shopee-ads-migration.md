# Shopee: ngừng module cũ → chuẩn bị Quảng cáo (SHOPEE-ADS-0)

| Phần | Trạng thái |
|---|---|
| Module Shopee cũ (dashboard, phân tích, sản phẩm, đơn, trả hàng, hàng hoàn, giải ngân & payout, đồng bộ, sức khoẻ) | **DISABLED** (`SHOPEE_LEGACY_MODULES_ENABLED=false`, mặc định) |
| Kết nối Shopee dùng chung (OAuth, token, ký request, API client, queue / worker / scheduler, log, snapshot) | **ACTIVE** |
| Quảng cáo Shopee | **PREPARING** (`SHOPEE_ADS_ENABLED=true`, mặc định) — chỉ có khung trang + hợp đồng provider |

Không xoá bảng, cột hay dữ liệu nào; không có migration trong phase này. Code module cũ vẫn còn (tắt bằng cờ) để có thể bật lại hoặc xoá hẳn ở một phase sau.

## 1. Cờ (một chỗ duy nhất: `src/lib/feature-flags.ts`)

| Biến | Mặc định | Tác dụng |
|---|---|---|
| `SHOPEE_LEGACY_MODULES_ENABLED` | `false` | `false` = không menu, không trang (chuyển về `/shopee/ads`), không API / server action (404 `legacy_module_disabled`), scheduler không tạo job cũ và **huỷ** job cũ đang chờ, worker không nhận job cũ, không thông báo hàng hoàn, dashboard không hiện widget Shopee, trang giá vốn / combo không link sang trang đơn Shopee |
| `SHOPEE_ADS_ENABLED` | `true` | `false` = ẩn menu "Quảng cáo Shopee", `/shopee/ads` chuyển về `/dashboard` |
| `SHOPEE_TOKEN_KEEPALIVE_HOURS` | `24` | chu kỳ làm mới token cho shop không dùng (xem §4) |

Cố ý **không có** cờ "tắt toàn bộ Shopee": Ads cần kết nối Shopee.

## 2. Bảng phụ thuộc

| Feature | Route | UI | Service | API route | Job type | Bảng DB | Dùng chung | Quyết định |
|---|---|---|---|---|---|---|---|---|
| Dashboard Shopee | `/shopee/dashboard` | `shopee/dashboard/*`, `components/analytics/*` | `core/analytics.ts` | — | — | v_analytics_*, analytics_settings | — | DISABLE |
| Phân tích Shopee | `/shopee/analytics/*` | `shopee/analytics/*` | `core/analytics.ts` | `/api/shopee/analytics/export` | — | như trên | — | DISABLE |
| Sản phẩm Shopee (ghép SKU) | `/shopee/products` | `shopee/products/*` | `core/product-catalog`, `sku-mapping` | — | `product` | channel_products, channel_product_models | mapping lịch sử dùng cho giá vốn đơn | DISABLE + KEEP_FOR_HISTORY |
| Đơn hàng Shopee | `/shopee/orders/*` | `shopee/orders/*` | `order-sync*`, `core/order-*` | — | `order` | channel_orders, channel_order_items | sổ giá vốn (sale_out đã ghi) | DISABLE + KEEP_FOR_HISTORY |
| Tài chính đơn | (trong trang đơn) | — | `escrow-sync` | — | `escrow` | order_financials, order_financial_components | — | DISABLE + KEEP_FOR_HISTORY |
| Trả hàng | `/shopee/returns/*` | `shopee/returns/*` | `return-sync`, `core/returns` | — | `return` | channel_returns, channel_return_items, restocks | sổ giá vốn (return_in đã ghi) | DISABLE + KEEP_FOR_HISTORY |
| Hàng hoàn đã giao | `/shopee/returns/operations/*` | `…/operations/*` | `return-operations/*`, `return-logistics-*` | `/api/shopee/returns/operations/export` | `return_logistics`, `failed_delivery` | channel_return_operations(+items, events), return_delivery_windows, return_notification_* | thông báo Zalo (`notifications/service.ts`) | DISABLE + KEEP_FOR_HISTORY |
| Giải ngân & payout | `/shopee/payouts/*` | `shopee/payouts/*` | `income-sync`, `payout-sync`, `core/payouts` | — | `income`, `payout` | order_income_releases, payout_*, channel_wallet_transactions | — | DISABLE + KEEP_FOR_HISTORY |
| Đồng bộ Shopee | `/shopee/sync` | `shopee/sync/*` | `core/sync-status-queries` | — | — | channel_sync_jobs/states/logs | queue (KEEP) | DISABLE |
| Sức khoẻ hệ thống | `/shopee/system-health` | `shopee/system-health/*` | `core/system-health` | — | — | heartbeats, controls | health RPC (giữ cho Ads) | DISABLE |
| Widget Shopee trên Tổng quan | `/dashboard` | `dashboard/shopee-kpis`, `shopee-cashflow` | analytics | — | — | — | — | DISABLE (theo cờ) |
| Link đơn Shopee từ giá vốn / combo | `/inventory/costs/*`, `/products/combos/[id]` | link | `inventory-cost/queries` | — | — | — | giá vốn là lõi | SHARED (giữ trang, bỏ link) |
| Kết nối shop | `/settings/shopee` | `settings/shopee/*` | `token.ts`, `auth.ts` | `/api/shopee/auth/*`, `/api/shopee/test-connection` | — | shops, shop_connections | **Ads** | KEEP (+ nút Kết nối thêm shop, Ngắt kết nối) |
| OAuth / token / ký / client | — | — | `auth`, `token`, `signing`, `client`, `errors` | — | — | shop_connections | **Ads** | KEEP |
| Queue / worker / scheduler | — | — | `core/sync-*`, `shopee/sync-service`, `server.ts` | `/api/internal/shopee/sync-scheduler`, `sync-worker`, `latency-probe` | (chỉ loại đang bật) | channel_sync_jobs/states/logs, heartbeats, controls | **Ads** | KEEP |
| Retry / backoff / rate limit / phân loại lỗi / circuit breaker | — | — | `retry-policy`, `sync-errors`, `record_shop_sync_outcome` | — | — | — | **Ads** | KEEP |
| Snapshot thô + retention | — | — | `core/snapshots`, `pruneRetention` | — | — | channel_api_snapshots | **Ads** (entity_type `ads`) | KEEP |
| Sản phẩm, NCC, phiếu nhập, hoá đơn, thanh toán, giá vốn, combo | lõi | lõi | lõi | lõi | — | products, suppliers, receipts, invoices, payments, inventory_cost_ledger, product_cost_state, combo | — | KEEP (không đụng) |

## 3. Scheduler / worker sau phase này

- Trước: 8 loại job (`order`, `product`, `escrow`, `return`, `return_logistics`, `failed_delivery`, `income`, `payout`) + thông báo hàng hoàn mỗi phút.
- Sau (cờ mặc định): **0 loại** được lên lịch / nhận. Tick vẫn chạy mỗi phút: heartbeat, thu hồi job treo, retention, **huỷ** job cũ còn `pending` / `retry` (`error_code = legacy_module_disabled`, giữ lịch sử), keepalive token. Job đang `running` không bị cắt ngang — worker không nhận lại nữa, lượt tiếp theo về `pending` và bị huỷ ở tick sau.
- Lưu lượng Shopee mong đợi: chỉ làm mới token (≤ 1 lần / shop / ngày khi shop không dùng) và bấm "Kiểm tra kết nối". **Không** còn lời gọi đơn / sản phẩm / trả hàng / payout.
- Loại job Ads dự kiến (chưa chạy được, chưa có trong ràng buộc DB): `ads_campaign`, `ads_performance`, `ads_budget`, `ads_product` (`src/lib/channels/core/sync-domains.ts`).

## 4. Token khi không ai gọi Shopee

Trước đây token chỉ được làm mới khi có lời gọi API. Tắt sync cũ → access token hết hạn sau vài giờ, refresh token không dùng (~30 ngày) cũng hết → phải kết nối lại trước khi Ads chạy được. Tick scheduler giờ chạy `keepShopeeTokensAlive`: shop live đang kết nối mà ≥ 24 h chưa làm mới và access token đã hết hạn → đi qua đúng `getValidAccessToken` (single-flight trong process + lease DB của SHOPEE-1, lưu mã hoá nguyên tử). Shop đã ngắt kết nối / cần ủy quyền lại bị bỏ qua.

## 5. Khung Ads

| Gì | Ở đâu |
|---|---|
| Trang | `/shopee/ads` (khung: shop đã kết nối, chỉ số sẽ theo dõi) — `src/app/(authenticated)/shopee/ads/page.tsx` |
| Hợp đồng provider | `src/lib/channels/shopee/ads/provider.ts` — `ShopeeAdsProvider` (`listCampaigns`, `getCampaignPerformance`, `getAdsPerformance`, `getBudgetInfo`), triển khai duy nhất `NotImplementedShopeeAdsProvider` (từ chối, không gọi Shopee). **Chưa đoán tên endpoint** |
| Từ vựng / chỉ số | `src/lib/channels/shopee/ads/types.ts` — spend, impressions, clicks, orders, GMV, CTR, CPC, tỉ lệ chuyển đổi, ROAS, ACOS (chỉ định nghĩa, chưa có công thức) |
| Loại job | `PLANNED_ADS_SYNC_TYPES` |

Dự án đặt code nghiệp vụ dưới `src/lib/<domain>` (không có `src/modules`), nên Ads nằm cạnh các provider Shopee khác: `src/lib/channels/shopee/ads/` — dùng lại `ShopeeClient`, token source, metering, snapshot.

Thực thể dự kiến (thiết kế ở SHOPEE-ADS-1 khi có payload thật): `ads_campaigns`, `ads_products` / entities, `ads_daily_performance`; trạng thái sync dùng lại `channel_sync_states / jobs / logs`; payload thô dùng lại `channel_api_snapshots` (`entity_type = 'ads'`).

## 6. Biến môi trường

Giữ nguyên tất cả: `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_API_BASE_URL`, `APP_URL` / `SHOPEE_REDIRECT_URL`, `APP_ENCRYPTION_KEY`, `SHOPEE_PROVIDER_MODE`, `SHOPEE_SYNC_INTERNAL_SECRET`, các `SHOPEE_SYNC_*` (cấu hình queue — Ads dùng lại). Không gỡ biến nào. Thêm: `SHOPEE_LEGACY_MODULES_ENABLED`, `SHOPEE_ADS_ENABLED`, `SHOPEE_TOKEN_KEEPALIVE_HOURS`.

## 7. Bật lại module cũ (nếu cần)

`SHOPEE_LEGACY_MODULES_ENABLED=true` + redeploy: route / API / job / thông báo hoạt động lại (menu cũ đã bỏ — vào bằng URL). Dữ liệu tiếp tục từ chỗ dừng.

## 8. Tài liệu cũ

Đã chuyển vào `docs/archive/shopee-legacy/` (trả hàng, payout, phân tích, hàng hoàn, đối chiếu tài chính). Vẫn hiệu lực: `docs/shopee-auth-runbook.md`, `docs/shopee-sync-operations.md`, `docs/shopee-production-runbook.md` (queue / scheduler / token), `docs/shopee-financial-core.md` (lược đồ).

## 9. Điều kiện cho phase tiếp theo

**SHOPEE-ADS-UI-1** (giao diện Ads):
- Thiết kế màn hình (danh sách chiến dịch, hiệu quả theo ngày, so sánh shop) + bộ lọc mong muốn.
- Có thể làm trên dữ liệu fixture trước, không cần API thật.

**SHOPEE-ADS-1** (đồng bộ Ads thật):
- Tài liệu chính thức Shopee Ads API (endpoint, tham số, phân trang, giới hạn tần suất, độ trễ số liệu, múi giờ báo cáo).
- App Shopee được cấp quyền Ads (scope / permission) — nếu phải ủy quyền lại, các shop bấm "Kết nối lại" ở Cài đặt → Tích hợp Shopee.
- Payload thật (đọc bằng tool chỉ-đọc như `scripts/shopee/live-readonly.ts`) để chốt mapping + thiết kế bảng.
- Migration thêm `sync_type` Ads vào ràng buộc `channel_sync_jobs` + handler + đưa vào `activeSyncTypes`.
