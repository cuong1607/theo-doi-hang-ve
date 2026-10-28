# Quảng cáo Shopee — giao diện (SHOPEE-ADS-UI-1)

Trang `/shopee/ads` là dashboard Ads mới, **chạy trên dữ liệu mẫu (fixture)**.
Chưa gọi Shopee Ads API, chưa có bảng Ads, chưa có job Ads.
Module cũ vẫn tắt (xem [shopee-ads-migration.md](shopee-ads-migration.md)).

## 1. Luồng dữ liệu

```
URL (?period&from&to&shop&status&type&q&sort&dir&page&size)
  → parseAdsFilters / parseAdsTableQuery      (filters.ts — kiểm tra hợp lệ)
  → AdsDashboardSource.load(filters)          (source.ts)
       hôm nay: FixtureAdsDashboardSource → buildFixtureDashboard (fixtures.ts)
       ADS-1:   nguồn đọc bảng Ads đã đồng bộ → CÙNG AdsDashboardData
  → AdsDashboardData                          (view-models.ts)
  → page.tsx + src/components/ads/*
```

Giao diện chỉ biết `AdsDashboardData`, không biết DTO của provider (`provider.ts`).
Phase ADS-1 thêm mapper DTO → bảng chuẩn hoá → view model, trang không phải sửa.

| File | Nội dung |
|---|---|
| `src/lib/channels/shopee/ads/view-models.ts` | `AdsOverviewMetrics`, `AdsTrendPoint`, `AdsCampaignRow`, `AdsInsight`, `AdsSyncStatus`, `AdsDashboardData` |
| `…/ads/metrics.ts` | định nghĩa chỉ số, chiều "tốt" (ROAS ↑ tốt; ACOS / CPC ↑ xấu; chi tiêu ↑ trung tính, cảnh báo nếu doanh thu không theo kịp), định dạng vi-VN, mục tiêu tham khảo |
| `…/ads/filters.ts` | preset ngày (dùng lại `analytics/periods.ts`, giờ VN), bộ lọc, truy vấn bảng (tìm kiếm không dấu, sắp xếp, phân trang) |
| `…/ads/fixtures.ts` | dữ liệu mẫu tất định (PRNG có seed), 2 shop mẫu, 14 chiến dịch |
| `…/ads/source.ts` | `AdsDashboardSource`, `FixtureAdsDashboardSource`, `AdsDataUnavailableError` (thông báo thân thiện, không lộ lỗi gốc) |

## 2. Fixture

- Các dạng chiến dịch: hiệu quả cao, ROAS cao, kém hiệu quả, chi tiêu lớn, tiêu tiền nhưng 0 đơn, tạm dừng, đã kết thúc, CTR giảm dần. Tên chung chung ("Search - Best Sellers"…), không dùng tên thật.
- Số liệu là hàm thuần của (chiến dịch, ngày, giờ): cùng URL thì cùng dashboard.
  - Có hiệu ứng cuối tuần, ngày đôi (10/10…) và ngày 15/25.
  - Chi tiêu bị giới hạn bởi ngân sách ngày.
- Độ chi tiết của trend:
  - 1 ngày: theo giờ ("Hôm nay" chỉ đến giờ hiện tại).
  - ≤ 92 ngày: theo ngày.
  - Dài hơn: theo tuần.
- So sánh kỳ trước: "Hôm nay" được so với hôm qua **cùng giờ**.
- `?demo=` (chỉ để QA):
  - `empty`: không có dữ liệu.
  - `unsynced`: "Chưa đồng bộ Ads".
  - `error`: thẻ lỗi + nút Thử lại.
  - `large`: 120 chiến dịch.
  - `slow`: trễ 1,5 s để xem skeleton.

## 3. Giao diện

- **Token màu** (`src/app/globals.css`, có biến thể `.dark`):
  - `ads-primary` (coral), `ads-secondary` (tím), `ads-accent` (cyan).
  - `ads-surface` / `ads-surface-strong` / `ads-border` / `ads-muted`.
  - Mỗi chỉ số có hai token: `metric-*` (màu đậm) và `metric-*-text` (chữ đọc được trên nền nhạt).
  - Gradient chỉ dùng ở `ads-gradient-hero`, `ads-gradient-primary` (thẻ ROAS, vạch chỉ báo đang chọn, nút chính).
- **Chuyển động** (CSS thuần, repo cấm thư viện animation):
  - Token `--ads-dur-fast` 140 ms, `--ads-dur-normal` 200 ms, `--ads-dur-slow` 300 ms, ease-out `--ads-ease`.
  - Hiệu ứng vào trang chạy một lần, có stagger nhỏ (`--ads-delay`).
  - Số đếm chỉ chạy khi giá trị **đổi** (không chạy lúc tải trang).
  - Biểu đồ hiện dần từ trái sang phải lần đầu; đổi dữ liệu chỉ crossfade.
  - Không có vòng lặp nào, trừ shimmer khi đang tải và icon quay khi đang làm mới.
- **Giảm chuyển động**: rule toàn cục đưa thời lượng về ~0. Riêng Ads còn bỏ thêm delay và hiệu ứng nâng thẻ khi hover; hook `useReducedMotion` tắt count-up.
- **Truy cập**:
  - Màu không bao giờ là tín hiệu duy nhất: delta luôn có mũi tên + dấu + chữ, trạng thái có icon riêng + nhãn, gauge có chữ "Đạt / Chưa đạt".
  - Phím:
    - Bộ preset và chế độ biểu đồ là radiogroup (←/→/Home/End).
    - Biểu đồ có thể focus, ←/→ để xem từng mốc.
    - Hàng mở rộng có `aria-expanded` / `aria-controls`; khi đóng thì `inert`.
- **Responsive**:
  - Desktop: lưới KPI 4 cột, thẻ ROAS 2×2.
  - Tablet: 2 cột.
  - Mobile: thẻ KPI vuốt ngang có snap; bảng cuộn ngang trong khung; biểu đồ thấp hơn (220 px).

## 4. Giả định chờ API thật (ADS-1 phải xác nhận)

- **Loại chiến dịch** `search / discovery / shop / auto` chỉ là nhóm cho UI; enum thật của Shopee map sau.
- **Trạng thái** `active / paused / ended / warning`:
  - "Cần chú ý" (`warning`) là trạng thái **suy ra** (0 đơn, ROAS thấp…), Shopee không có trạng thái này.
  - Ở ADS-1, rule này nên chuyển sang lớp mapper.
- **Doanh thu Ads**:
  - Doanh thu quy cho quảng cáo theo cửa sổ nào (trực tiếp hay gián tiếp, 7 ngày…)?
  - Độ trễ số liệu, múi giờ báo cáo, có số theo giờ hay không.
- **Ngân sách**: ngân sách ngày hay tổng; chiến dịch không giới hạn ngân sách.
- **Sản phẩm được quảng cáo** của mỗi chiến dịch, và doanh thu tách theo sản phẩm.
- **Mục tiêu** (ROAS ≥ 4x, ACOS ≤ 25 %, CTR ≥ 2,5 %, CPC ≤ 2.000 ₫, CR ≥ 3 %) là giá trị tham khảo cho UI. Có thể làm thành cài đặt theo shop sau này.
- **Gợi ý** là quy tắc mẫu đơn giản, chưa phải hệ thống khuyến nghị.

## 5. Kiểm thử

- `node --test src/lib/channels/shopee/ads/ads-ui.test.ts` (đã có trong `npm test`).
  - Kiểm tra: định dạng, ý nghĩa delta, preset, bộ lọc, fixture, bảng.
  - Kịch bản 120 chiến dịch.
  - Các trạng thái demo.
  - Guard tĩnh: không gọi API, không đoán endpoint Ads, không có migration bảng `ads_*`.
- `node --env-file=.env.local scripts/e2e/shopee-ads-ui.ts [baseUrl]`: Playwright trên app đang chạy.
  - Tự tạo admin tạm và xoá sau khi chạy.
  - Chụp màn hình ở 1440 / 1366 / tablet / mobile / dark.
