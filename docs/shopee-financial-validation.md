# Kiểm chứng escrow Shopee (SHOPEE-5)

Tài liệu kiểm chứng ý nghĩa từng trường tiền của `v2.payment.get_escrow_detail`
trên **payload thật của shop Việt Nam**, trước khi một trường được cộng vào
`calculated_settlement`.

> **Trạng thái hiện tại: CHƯA KIỂM CHỨNG.** Chưa capture được payload thật
> (các biến Shopee trên Vercel là loại *Sensitive* nên `vercel env pull` không
> trả giá trị). Mọi trường trong `financial-dictionary.ts` đang `verified:false`.
> Hệ quả an toàn:
> - Thu nhập thực tế vẫn đúng: `actual_shopee_income = escrow_amount_after_adjustment ?? escrow_amount`
>   (số của chính Shopee, không tự cộng lại).
> - `calculated_settlement`, `settlement_variance`, `reconciliation_status` = **NULL**
>   (chưa đối soát được thì không hiển thị "Khớp").
> - Từng khoản vẫn được lưu đầy đủ trong `order_financial_components`, khoản thuộc
>   công thức nhưng chưa kiểm chứng được cộng riêng vào `unverified_component_amount`.

## 1. Quy trình kiểm chứng

1. Lấy credentials Shopee + `APP_ENCRYPTION_KEY` thật vào `.env.production.local`
   (không commit). Giá trị Sensitive không đọc lại được từ Vercel → lấy từ nơi lưu
   gốc (Shopee Open Platform console, password manager).
2. Chạy script capture chỉ-đọc (gọi `get_escrow_detail`, lưu payload vào thư mục
   tạm, đã bỏ `buyer_user_name`): ~40 đơn `COMPLETED`, đơn `TO_RETURN`, 2
   `SHIPPED` + 2 `CANCELLED` (để biết Shopee trả lời "chưa có escrow" thế nào).
   Cách khác: deploy SHOPEE-5 rồi chạy job escrow trên production — snapshot
   `channel_api_snapshots` (`entity_type = 'escrow'`) chính là payload đã ẩn
   danh, đọc bằng service role.
3. Với mỗi đơn, giải: tập trường nào cộng (theo dấu tác động tới người bán) ra
   đúng `escrow_amount`. Một trường chỉ được `verified:true, settlement:true` khi
   công thức khớp trên **toàn bộ** mẫu (trong dung sai).
4. Ghi kết quả vào bảng mục 3, sửa `financial-dictionary.ts`, tăng
   `FINANCIAL_CALCULATION_VERSION` (ví dụ `shopee-fin-v2`) nếu công thức đổi,
   rồi chạy repair escrow cho các đơn cũ.
5. Thêm 2–3 payload thật đã ẩn danh vào `tests/fixtures/shopee/escrow/`
   (đổi `order_sn`, bỏ mọi thông tin người mua) và viết test khớp công thức.

## 2. Giả thuyết công thức (chưa kiểm chứng)

```
escrow_amount ≈ original_price
              − seller_discount − voucher_from_seller − seller_coin_cash_back
              − commission_fee − service_fee − seller_transaction_fee
              − credit_card_transaction_fee − campaign_fee − order_ams_commission_fee − fbs_fee
              + final_shipping_fee            (có dấu: âm = người bán chịu)
              − reverse_shipping_fee − các phí bảo hiểm vận chuyển
              − escrow_tax − withholding_*_tax
              − seller_return_refund
              + seller_lost_compensation + rsf_seller_protection_fee_claim_amount
escrow_amount_after_adjustment ≈ escrow_amount + Σ order_adjustment[].amount
```

Không cộng (tránh đếm trùng): `net_commission_fee`, `net_service_fee` (bản BR),
`total_adjustment_amount` (= tổng các dòng adjustment), các thành phần của
`final_shipping_fee` (`actual_shipping_fee`, `shopee_shipping_rebate`,
`buyer_paid_shipping_fee`, `shipping_fee_discount_from_3pl`), khoản Shopee tài
trợ (`shopee_discount`, `voucher_from_shopee`, `coins`), `buyer_total_amount`,
và `cost_of_goods_sold` của Shopee (**không phải** giá vốn nội bộ).

## 3. Bảng kiểm chứng từng trường

Cột "Có trong payload VN": điền sau khi capture. "Kết luận": `formula` (cộng vào
calculated_settlement) / `info` (lưu, không cộng) / `ignore`.

| Trường | Cột order_financials | Tác động người bán | Giả thuyết | Có trong payload VN | Dấu thật | Kết luận |
|---|---|---|---|---|---|---|
| escrow_amount | escrow_amount | kết quả | thu nhập trước điều chỉnh | ? | | kết quả |
| escrow_amount_after_adjustment | escrow_amount_after_adjustment | kết quả | thu nhập cuối | ? | | kết quả |
| original_price | gross_original_value | + | gốc công thức | ? | | ? |
| order_selling_price | gross_selling_value | info | | ? | | info |
| seller_discount | seller_discount | − | formula | ? | | ? |
| voucher_from_seller | seller_voucher | − | formula | ? | | ? |
| seller_coin_cash_back | — | − | formula | ? | | ? |
| shopee_discount / voucher_from_shopee / coins | shopee_discount / shopee_voucher | info | Shopee tài trợ | ? | | info |
| commission_fee | commission_fee | − | formula (phí cố định) | ? | | ? |
| service_fee | service_fee | − | formula (phí dịch vụ) | ? | | ? |
| seller_transaction_fee | transaction_fee | − | formula (phí thanh toán) | ? | | ? |
| credit_card_transaction_fee | processing_fee | − | formula | ? | | ? |
| campaign_fee | campaign_fee | − | formula | ? | | ? |
| order_ams_commission_fee | affiliate_fee | − | formula | ? | | ? |
| fbs_fee | other_platform_fee | − | formula | ? | | ? |
| net_commission_fee / net_service_fee | — | info | bản BR, không cộng | ? | | info |
| final_shipping_fee | — | có dấu | formula | ? | | ? |
| actual_shipping_fee / shopee_shipping_rebate / buyer_paid_shipping_fee / shipping_fee_discount_from_3pl | các cột shipping | info | thành phần của final_shipping_fee | ? | | info |
| reverse_shipping_fee | reverse_shipping_fee | − | formula | ? | | ? |
| shipping_seller_protection_fee_amount, delivery_seller_protection_fee_premium_amount | — | − | formula | ? | | ? |
| escrow_tax | escrow_tax | − | formula | ? | | ? |
| withholding_vat_tax / withholding_pit_tax / withholding_cit_tax / withholding_tax | các cột thuế | − | formula (hộ kinh doanh VN) | ? | | ? |
| seller_return_refund | refund_amount | − | formula | ? | | ? |
| seller_lost_compensation | seller_compensation_amount | + | formula | ? | | ? |
| rsf_seller_protection_fee_claim_amount | — | + | formula | ? | | ? |
| order_adjustment[] | (component từng dòng) | có dấu | formula cho after_adjustment | ? | | ? |
| total_adjustment_amount | total_adjustment_amount (có dấu) | info | tổng adjustment | ? | | info |
| cost_of_goods_sold / original_cost_of_goods_sold | — | info | **không phải COGS nội bộ** | ? | | info |
| buyer_total_amount | — | info | người mua trả | ? | | info |
| `*_pri`, order_chargeable_weight, instalment_plan | — | — | bỏ qua tường minh | ? | | ignore |

Trường số không có trong từ điển → component `other`, `unverified`, không cộng;
tên trường được đếm ở `metadata.stats.unknownFields` của job escrow để bổ sung.

## 4. Dung sai đối soát

`financial_settlement_tolerance(currency, level)` (migration 00047):

| Tiền tệ | matched (Khớp) | warning (Lệch nhỏ) | trên mức warning |
|---|---|---|---|
| VND | ≤ 10 đ | ≤ 1.000 đ | mismatch (Lệch đối soát) |
| khác | ≤ 0,01 | ≤ 1 | mismatch |

VND không có phần lẻ; 10 đ chỉ để hấp thụ làm tròn từng dòng của Shopee. **Cần
chốt lại** theo độ lệch thực tế khi đã có payload.

## 5. "Chưa có escrow"

Đơn chỉ tự động lấy escrow khi `order_status = COMPLETED`
(`ESCROW_ELIGIBLE_STATUSES`); trạng thái khác chỉ qua repair. Lỗi provider khớp
`isEscrowNotReady` (not found / not exist / not ready / order status …) → ghi
`escrow_last_error_*` trên đơn, chờ `SHOPEE_SYNC_ESCROW_ERROR_BACKOFF_HOURS`
rồi mới thử lại — không lặp. **Cần chốt** mã lỗi thật (đơn SHIPPED/CANCELLED
trong mẫu capture).

## 6. Lợi nhuận

- `profit_after_cogs = actual_shopee_income − internal_cogs`, chỉ khi **cả hai**
  có giá trị. COGS do cost engine (SHOPEE-4) ghi; escrow không bao giờ ghi
  `internal_cogs`. Hoàn tiền không đảo COGS (để SHOPEE-6 returns).
- `actual_profit = profit_after_cogs`; `contribution_profit = NULL` (quà tặng,
  đóng gói, quảng cáo… chưa có → không biết ≠ 0).
- `actual_margin = NULL` cho tới khi chốt mẫu số (doanh thu gộp
  `original_price`? giá người mua trả? thu nhập Shopee?).

## 7. PII

Snapshot escrow bỏ `buyer_user_name`. Khi có payload thật: rà toàn bộ khoá
(địa chỉ, số điện thoại, `buyer_user_id`…) và bổ sung vào `PII_KEYS` trong
`escrow-adapter.ts`. Snapshot chỉ đọc được bằng service role (admin/server).
