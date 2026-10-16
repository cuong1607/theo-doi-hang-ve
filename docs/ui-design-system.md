# UI design system (UIUX-1)

Tham chiếu cho mọi màn hình mới. Phong cách: business / operations, sạch, dễ
quét số liệu, ưu tiên desktop, responsive đủ dùng trên tablet/mobile.
**Rõ ràng > trang trí.** Không gradient, không glassmorphism, không animation
thừa.

Mã nguồn:

| Thứ | Ở đâu |
|---|---|
| Token màu, motion | `src/app/globals.css` |
| Định dạng tiền / số / ngày | `src/lib/ui/format.ts` |
| Trạng thái → tone | `src/lib/ui/status.ts` |
| URL state danh sách (page, size, filter) | `src/lib/ui/list-query.ts` |
| Hợp đồng async action | `src/lib/ui/action-runner.ts` |
| Component dùng chung | `src/components/patterns/*` |
| Test | `src/lib/ui/ui.test.ts` |

---

## 1. Màu ngữ nghĩa

Thương hiệu giữ nguyên (hồng CONGTRANGBEDDING, `--primary`, tiêu đề
`--heading`). Thêm 4 tone trạng thái, mỗi tone có 3 biến thể:

| Tone | Dùng cho | Solid (icon, thanh) | Nền nhạt | Chữ |
|---|---|---|---|---|
| success | xong / khỏe / có lãi | `bg-success` | `bg-success-soft` | `text-success-text` |
| warning | cần chú ý (thiếu, một phần, thử lại) | `bg-warning` | `bg-warning-soft` | `text-warning-text` |
| danger | hỏng / lỗi / lỗ / lệch đối soát | `bg-destructive` | `bg-danger-soft` | `text-danger-text` |
| info | đang chạy / thông tin | `bg-info` | `bg-info-soft` | `text-info-text` |
| neutral | chưa bắt đầu / không áp dụng | `bg-muted` | `bg-muted` | `text-muted-foreground` |

Quy tắc:

- **Không** dùng `amber-*`, `green-*`, `red-*`, `emerald-*`… trong trang
  (test `37` chặn). Chỉ dùng token trên.
- Màu **không bao giờ là tín hiệu duy nhất**: badge luôn có chữ + icon theo
  tone; callout có icon + tiêu đề.
- Tiền: **chỉ** tô màu con số có ý nghĩa trạng thái (lợi nhuận dương →
  success, lỗ → danger, 0 / chưa biết → trung tính). Không tô mọi số tiền.
- "Cần chú ý" (nợ còn lại, chênh lệch âm, chưa ghép SKU ở dòng đơn) là
  **warning**, không phải đỏ. Đỏ dành cho lỗi thật / lỗ / lệch đối soát.
- Dark mode: token có sẵn giá trị `.dark`; không mở rộng phạm vi dark mode.

## 2. Typography

| Vai trò | Class |
|---|---|
| Tiêu đề trang | `text-2xl font-semibold tracking-tight` (`PageHeader`) |
| Tiêu đề section | `text-base font-semibold` (`SectionHeader`) |
| Tiêu đề card | `CardTitle` (text-base, medium) |
| Body | `text-sm` |
| Phụ / caption | `text-sm text-muted-foreground`, nhỏ hơn: `text-xs` |
| Header bảng | `text-xs font-semibold text-muted-foreground` (mặc định của `TableHead`) |
| KPI | `text-2xl font-semibold tabular-nums` (`MetricCard`) |
| Số trong bảng | `tabular-nums` (mặc định của `Table`) |

## 3. Bố cục trang

```
<PageContainer>                 space-y-6 + fade-in 200 ms
  <PageHeader title description actions meta/>   meta = "cập nhật lần cuối", auto-refresh…
  <Callout/>                    cảnh báo cấp trang (fixture, scheduler, lỗi cấu hình)
  <Card> đồng bộ / thao tác</Card>              (trang Shopee)
  <MetricGrid><MetricCard/>…</MetricGrid>       KPI
  <Card>
    <CardHeader> CardTitle + <FilterBar/> </CardHeader>
    <CardContent> <Table/> | <EmptyState/> ; <DataTablePagination/> </CardContent>
  </Card>
</PageContainer>
```

Khoảng cách: giữa các khối `space-y-6`, lưới KPI `gap-3`, trong card dùng
padding của `Card` (không thêm `pt-6` tự chế).

## 4. Loading

| Tình huống | Hiển thị |
|---|---|
| Lần tải đầu một route | `loading.tsx` dùng skeleton có **đúng hình bố cục thật** (`PageHeaderSkeleton`, `MetricSkeleton`, `FilterBarSkeleton`, `TableSkeleton` 5–8 dòng, `CardSkeleton`, `FormSkeleton`, `PageSkeleton`) |
| Route chưa có loading riêng | `(authenticated)/loading.tsx` → `PageSkeleton` (không bao giờ trắng trang) |
| Phần chậm trong trang | `<Suspense fallback={<CardSkeleton/>}>` cho riêng phần đó (vd. tài chính chi tiết đơn, KPI Shopee ở dashboard) |
| Đổi bộ lọc / phân trang | **giữ** bảng cũ, `FilterBar` hiện "Đang cập nhật…" (transition) |
| Đang đồng bộ | `AutoRefresh` làm mới trang mỗi 10 s, giữ dữ liệu, hiện "Đang cập nhật…" |
| Việc nhỏ trong dòng | `InlineSpinner` (có chữ cho screen reader) |

Skeleton: `animate-skeleton` (1,8 s, nhẹ), `aria-hidden`; khối bao ngoài có
`role="status"` + chữ `sr-only`.

## 5. Async action

Mọi nút gọi server action đi qua `useAsyncAction` + `LoadingButton`:

```tsx
const { run, pending } = useAsyncAction({ errorMessage: "Không gửi được yêu cầu đồng bộ." });
<LoadingButton loading={pending} loadingText="Đang gửi yêu cầu…" icon={<RefreshCw />} onClick={() => run(() => requestSyncNowAction(shopId, "order"))}>
  Đồng bộ ngay
</LoadingButton>
```

- `idle → loading → success | error`.
- Không double-submit (bấm lần 2 khi đang chạy bị bỏ qua — test `11`).
- Lỗi throw → thông báo thân thiện, **không** hiện lỗi thô / SQL / stack.
- Kết quả → toast. Server action có `revalidatePath` tự làm mới trang; action
  không revalidate thì truyền `{ refresh: true }`.
- **Không optimistic** cho đồng bộ, ghép SKU, tiền: chỉ báo thành công sau khi
  server xác nhận.

## 6. Toast

`toast.success | error | warning | info(message)` — `src/components/patterns/toast.tsx`,
`<Toaster/>` gắn một lần ở layout đã đăng nhập. Ngắn, rõ:

- success: "Đã tạo yêu cầu đồng bộ."
- error: "Không thể đồng bộ sản phẩm."
- warning: "Đồng bộ xong, có 3 bản ghi lỗi."

Tự tắt sau 4 s (warning 6 s, error 7 s), tối đa 4 cái, có nút đóng,
`aria-live` (error: assertive).

Lỗi **validate form** hiện ngay cạnh ô / trong dialog (`role="alert"`), không
chỉ bằng toast.

## 7. Empty / error state

- `EmptyState variant="no-data"`: chưa có gì — nói rõ lý do + CTA (vd. "Chưa
  có dữ liệu đồng bộ." → "Xem trạng thái đồng bộ").
- `EmptyState variant="no-results"`: có dữ liệu nhưng bộ lọc không khớp —
  "Không tìm thấy … phù hợp." (FilterBar có "Xóa bộ lọc").
- `ErrorState`: thông điệp thân thiện + "Thử lại" (`retry` của Next 16) + mã
  tham chiếu (digest) — không lộ stack / token / SQL. Mọi `error.tsx` dùng nó.

## 8. Badge trạng thái

`<StatusBadge tone={toneOf(MAP, status)}>Nhãn</StatusBadge>` — map trong
`src/lib/ui/status.ts`. Trạng thái lạ → neutral.

| Nhóm | success | warning | danger | info | neutral |
|---|---|---|---|---|---|
| Đồng bộ | Đã đồng bộ | Đang thử lại | Đồng bộ thất bại | Đang đồng bộ (icon quay) | Chưa đồng bộ, Đang chờ |
| Job | Thành công | Chờ thử lại | Thất bại | Đang chạy | Đang chờ, Đã hủy |
| Ghép SKU | Tự động / thủ công | (dòng đang bán hoặc dòng đơn chưa ghép) | Xung đột | — | Chưa ghép |
| Đối soát | Khớp | Lệch nhỏ | Lệch đối soát | — | — |
| Tài chính đơn | Có settlement, Đã giải ngân | Điều chỉnh hoàn trả | Lệch đối soát | Đã ước tính | Chờ dữ liệu |
| Hàng còn phải về | Đã đủ | Cần xuất bù | — | Sắp hết | Bình thường |
| Thanh toán NCC | Đã thanh toán | Chưa thanh toán | — | Một phần | — |

"Chưa ghép" chỉ nổi lên warning khi nó chặn việc gì (biến thể đang bán, dòng
đơn) — không tô đỏ mọi dòng chưa ghép.

## 9. Bảng dữ liệu

- `Table` mặc định: `tabular-nums`, mật độ vừa (`px-3 py-2.5`), header nền
  muted chữ nhỏ, hover dòng nhẹ, viền mỏng; `stickyHeader` cho bảng dài (cuộn
  trong khung `max-h-[70vh]`, header dính).
- Số / tiền căn phải. Chữ dài: `truncate` + `title`. Mã (SKU, mã đơn):
  `font-mono text-xs`.
- Ít cột trên bảng chính; chi tiết đưa vào trang chi tiết / dialog. Cột shop
  chỉ hiện khi có > 1 shop.
- Mobile: bảng cuộn ngang trong khung (không ép chữ nhỏ).
- Phân trang `DataTablePagination`: "Hiển thị 26–50 / 1.234", số dòng
  25 / 50 / 100, Trước / Sau — **phân trang phía server**, không tải hết.
- Bộ lọc `FilterBar` + `SearchInput` (debounce 400 ms, nút xóa, Enter để tìm
  ngay) + `FilterSelect` + `FilterDate`; mọi giá trị nằm trong URL (refresh,
  back, chia sẻ giữ nguyên); mobile thu gọn sau nút "Bộ lọc (n)".

## 10. Đồng bộ

- `SyncStatusCell`: badge trạng thái, `SyncProgress`, "Đã chạy 38 giây · 3
  lượt", "Thành công gần nhất", lần chạy gần nhất, lỗi gần nhất (chi tiết chỉ
  admin), nút "Đồng bộ ngay".
- `SyncProgress`: biết tổng → thanh + "120 / 350"; không biết tổng (đơn,
  sản phẩm đang quét) → thanh chạy vô định + số đã xử lý. **Không bịa %.**
- `LastUpdated`: "Đơn hàng cập nhật lần cuối: 16/10/2026 08:32" (lần thành
  công gần nhất, không phải "bây giờ"); "· Đang cập nhật…" khi có job chạy;
  chip "lịch tự động đang dừng" khi scheduler im lặng.
- `SchedulerWarning`: callout cho admin khi cron dừng.

## 11. Định dạng

| Hàm | Ví dụ |
|---|---|
| `formatCurrency` | `"1234567.5"` → `1.234.567,5 ₫`; số JS làm tròn tới đồng; `null` → `—` |
| `formatQuantity` | `1.500`, `2,5` |
| `formatPercent` | `0.125` → `12,5%` |
| `formatDate` | `16/10/2026` |
| `formatDateTime` | `16/10/2026 08:32` |
| `formatDuration` / `formatAge` | `850 ms`, `38 giây`, `3 phút 5 giây` |

Múi giờ hiển thị: **Asia/Ho_Chi_Minh**. Ngày thuần (`2026-10-16`) không bị
lệch múi giờ. NUMERIC từ DB định dạng bằng chuỗi — không đổi sang float.
`NULL` luôn hiện "—" / "Chưa có" / "Chưa tính", không bao giờ là 0.

## 12. Motion

- 150–250 ms, `ease-out`. Trang: fade-in 200 ms (`animate-page-in`). Toast:
  180 ms. Dialog / dropdown / sheet: animation sẵn có của shadcn (fade + scale
  nhẹ / slide).
- Không animate: bảng lớn vào từng dòng, số liệu mỗi lần refresh, layout
  nhảy; không bounce / spring / parallax.
- `prefers-reduced-motion` → tắt animation/transition.

## 13. Accessibility cơ bản

- Focus luôn thấy (`focus-visible:ring`); link tự chế cũng có ring.
- Nút chỉ có icon → `aria-label` (menu thao tác, đóng toast, xóa tìm kiếm).
- Dialog: focus trap của Base UI/shadcn.
- Loading có chữ cho screen reader (`role="status"` + `sr-only`), nút đang
  chạy `aria-busy`.
- Trạng thái luôn có chữ + icon, không chỉ màu.
- Sidebar: đúng một mục active (khớp dài nhất).

## 14. Hiệu năng

- Không thêm thư viện animation / toast (test `54`); toast + skeleton + motion
  là CSS + vài chục dòng TS.
- Giữ Server Components; client component chỉ cho filter, dialog, nút
  action, polling (`AutoRefresh`).
- Polling chỉ khi có job đang chạy, dừng khi tab ẩn, chỉ đọc DB.
