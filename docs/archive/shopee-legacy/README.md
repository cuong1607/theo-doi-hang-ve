# ARCHIVED — Shopee legacy modules

Các tài liệu trong thư mục này mô tả các module Shopee **đã ngừng** từ SHOPEE-ADS-0 (`SHOPEE_LEGACY_MODULES_ENABLED=false`): trả hàng (SHOPEE-6), hàng hoàn đã giao (SHOPEE-6B), giải ngân & payout (SHOPEE-7), dashboard / phân tích (SHOPEE-8), đối chiếu tài chính (SHOPEE-5).

Giữ lại vì:
- dữ liệu lịch sử của các module này vẫn nằm nguyên trong DB (không bảng nào bị xoá);
- các hàm SQL / quy tắc nghiệp vụ được mô tả ở đây vẫn tồn tại và có test;
- có thể bật lại bằng `SHOPEE_LEGACY_MODULES_ENABLED=true` (code chưa bị xoá).

Không còn được cập nhật. Hiện trạng: xem [docs/shopee-ads-migration.md](../../shopee-ads-migration.md).
