# Kiểm chứng escrow Shopee (SHOPEE-5)

Tài liệu kiểm chứng ý nghĩa từng trường tiền của `v2.payment.get_escrow_detail`
trên **payload thật của shop Việt Nam**. Chỉ khi đã kiểm chứng ở đây, một trường
mới được cộng vào `calculated_settlement`.

## Trạng thái — `shopee-fin-v2` (2026-10-14)

- **Mẫu:** 6 đơn COMPLETED thật của shop pilot, gồm:
  - 1 đơn hoàn toàn bộ;
  - 1 đơn người mua trả phí ship;
  - 3 đơn có AMS (affiliate);
  - các hình thức thanh toán COD, ShopeePay và thẻ.
- **Kết quả:** công thức dưới đây ra **đúng `escrow_amount` tới từng đồng trên 6/6
  đơn** (chênh lệch 0).
- **Fixture:** 3 payload thật đã ẩn danh nằm trong `tests/fixtures/shopee/escrow/realvn_*.json`.
  Test `escrow-adapter.test.ts` (nhóm "real") khẳng định công thức chạy đúng trên cả 3.
- **Còn mỏng:** các khoản bên dưới chưa từng xuất hiện khác 0 trong mẫu, nên vẫn
  `verified:false`:
  - voucher người bán, phí chiến dịch, `escrow_tax`, `reverse_shipping_fee`;
  - đền bù mất hàng, `order_adjustment[]`.

  Nếu một khoản trong số này khác 0, nó được lưu riêng nhưng **không cộng vào**
  `calculated_settlement`. Khi đó đơn sẽ hiện "Lệch đối soát", và đó chính là tín
  hiệu cần kiểm chứng thêm. Nên lấy thêm mẫu khi job escrow đã chạy hết các đơn.

## 1. Công thức đã kiểm chứng (VN)

```
escrow_amount = original_price                          (+)  sau hoàn hàng; đơn hoàn toàn bộ = 0
              − seller_discount                          (−)
              − commission_fee − service_fee             (−)
              − seller_transaction_fee                   (−)
              − order_ams_commission_fee                 (−)
              − withholding_vat_tax − withholding_pit_tax (−)  thuế khấu trừ hộ kinh doanh
              − shipping_seller_protection_fee_amount    (−)  2.700 đ / đơn
              + buyer_paid_shipping_fee                  (+)
              + final_shipping_fee                       (có dấu) = shopee_shipping_rebate − actual_shipping_fee
              − final_return_to_seller_shipping_fee      (−)  ship trả hàng về người bán
              + rsf_seller_protection_fee_claim_amount   (+)  bảo hiểm bù lại phí ship trả hàng
escrow_amount_after_adjustment = escrow_amount  (6/6 mẫu không có adjustment)
```

Ví dụ thật (`realvn_standard`):

```
192.099 = 315.000 − 122.901
119.073 = 192.099 − 36.691 − 13.565 − 11.526 − 5.663 − 960 − 1.921 − 2.700
```

## 2. Các bẫy đếm trùng phát hiện được

| Trường | Phát hiện | Xử lý |
|---|---|---|
| `credit_card_transaction_fee` | Luôn **bằng đúng** `seller_transaction_fee`, kể cả trên đơn COD → cùng một phí bị báo 2 lần | info, không cộng, không ghi cột `processing_fee` |
| `seller_return_refund` | Giá trị âm (−358.800) và **đã được trừ sẵn** trong `original_price` (đơn hoàn: original_price = 0) | info. Cột `refund_amount` vẫn lưu độ lớn để hiển thị |
| `order_original_price`, `order_seller_discount` | Giá trị *trước* hoàn hàng | info |
| `actual_shipping_fee`, `shopee_shipping_rebate` | Đã nằm trong `final_shipping_fee` | info |
| `cost_of_goods_sold`, `original_cost_of_goods_sold` | Giá bán sau giảm giá theo cách gọi của Shopee, **không phải** giá vốn nội bộ | info |
| `net_commission_fee`, `net_service_fee`, `total_adjustment_amount` | Bản dành cho BR / tổng của các dòng adjustment | info |

## 3. Lỗi tìm ra nhờ payload thật (đã sửa ở v2)

1. **Escrow âm.** Đơn hoàn toàn bộ có `escrow_amount = −2.700` (người bán bị trừ phí
   bảo hiểm). Bản v1 lưu cột này theo trị tuyệt đối → **+2.700**. Từ v2,
   `escrow_amount` và `escrow_amount_after_adjustment` là cột **có dấu**.
2. **`tax_registration_code`** (mã số thuế / CCCD của chủ shop) là chuỗi toàn chữ số.
   v1 hiểu nhầm đó là khoản tiền 34 tỷ (component "other", unverified). Từ v2, trường
   này bị bỏ qua tường minh và **xoá khỏi snapshot** (`PII_KEYS`).
3. **Trường của thị trường khác** (≈36 trường như `pix_discount`, `sales_tax_on_lvg`…)
   luôn bằng 0 trên đơn VN. Từ v2, trường lạ chỉ được báo cáo khi **khác 0**.

## 4. Tính lại sau khi đổi phiên bản

Fingerprint của payload có kèm `FINANCIAL_CALCULATION_VERSION`.
`get_orders_needing_escrow_sync(p_calculation_version)` (migration 00049) coi mọi
đơn đã sync bằng phiên bản cũ là ứng viên (`reason = 'version_changed'`). Job escrow
sẽ tự lấy lại và tính lại theo từng lô có giới hạn, không cần bấm repair.

## 5. Bảng từng trường

| Trường | Cột | Tác động | Kết luận | Bằng chứng |
|---|---|---|---|---|
| escrow_amount / escrow_amount_after_adjustment | cùng tên (**có dấu**) | kết quả | thu nhập thực tế | 6/6 |
| original_price | gross_original_value | + | formula ✔ | 6/6 |
| seller_discount | seller_discount | − | formula ✔ | 5/6 khác 0 |
| commission_fee, service_fee, seller_transaction_fee | commission/service/transaction_fee | − | formula ✔ | 5/6 |
| order_ams_commission_fee | affiliate_fee | − | formula ✔ | 3/6 |
| withholding_vat_tax, withholding_pit_tax | cùng tên | − | formula ✔ | 5/6 (VAT 1%, PIT 0,5% của giá bán) |
| shipping_seller_protection_fee_amount | — | − | formula ✔ | 6/6 (2.700) |
| buyer_paid_shipping_fee | buyer_paid_shipping | + | formula ✔ | 1/6 |
| final_shipping_fee | — | có dấu | formula ✔ | 1/6 (−6.000 = 54.700 − 60.700) |
| final_return_to_seller_shipping_fee | return_shipping_fee | − | formula ✔ | 1/6 |
| rsf_seller_protection_fee_claim_amount | — | + | formula ✔ | 1/6 |
| credit_card_transaction_fee | — | info | **trùng** seller_transaction_fee | 5/6 bằng nhau |
| seller_return_refund | refund_amount | info | **đã trừ sẵn** | 1/6 |
| voucher_from_shopee, buyer_total_amount, order_selling_price, order_discounted_price, cost_of_goods_sold, original_cost_of_goods_sold, order_original_price, order_seller_discount, actual_shipping_fee, shopee_shipping_rebate, estimated_shipping_fee | — | info | info ✔ | 6/6 |
| voucher_from_seller, seller_coin_cash_back, campaign_fee, fbs_fee, reverse_shipping_fee, escrow_tax, withholding_cit_tax, withholding_tax, seller_lost_compensation, delivery_seller_protection_fee_premium_amount, order_adjustment[] | — | − / + | formula, **chưa kiểm chứng** (không cộng) | luôn 0 trong mẫu |
| tax_registration_code | — | — | bỏ qua + xoá khỏi snapshot | 6/6 |
| `*_pri`, order_chargeable_weight, instalment_plan | — | — | bỏ qua | |

## 6. Dung sai đối soát

`financial_settlement_tolerance()`: VND matched ≤ 10 đ, warning ≤ 1.000 đ, lớn hơn
nữa là mismatch. Mẫu thật lệch đúng 0 đ, nên giữ nguyên các mức này. Khoảng 10 đ chỉ
để hấp thụ sai số làm tròn.

## 7. "Chưa có escrow"

Chưa quan sát được: 6/6 đơn COMPLETED đều có escrow. Job chỉ tự lấy đơn
`COMPLETED`. Lỗi khớp `isEscrowNotReady` được ghi lại và chờ hết back-off mới thử
lại. Mã lỗi thật sẽ được bổ sung khi gặp.

## 8. Lợi nhuận

- `profit_after_cogs = actual_shopee_income − internal_cogs`, chỉ tính khi **có cả
  hai** giá trị. Có thể âm: đơn hoàn hàng có escrow âm.
- `contribution_profit` và `actual_margin` = NULL (chưa định nghĩa).
- Hoàn tiền không đảo giá vốn (để dành cho SHOPEE-6).

## 9. Thông tin cá nhân

- Snapshot bỏ `buyer_user_name` và `tax_registration_code`.
- `buyer_payment_info` chỉ chứa số tiền và phương thức thanh toán, không có danh tính.
- `items` chỉ chứa tên / SKU sản phẩm của shop.
- Snapshot ghi bởi v1 (trước bản sửa) còn mã số thuế. Xoá bằng lệnh sau:

  ```sql
  update public.channel_api_snapshots
  set payload = payload #- '{response,order_income,tax_registration_code}'
  where entity_type = 'escrow' and payload #> '{response,order_income}' ? 'tax_registration_code';
  ```
