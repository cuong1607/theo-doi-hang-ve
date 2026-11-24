# Kiểm thử thủ công trên Windows (PowerShell)

Làm lần lượt từng bước trên máy Windows của bạn. Bước 4 trở đi dùng **tài khoản Zalo thật**, nên chỉ làm khi bạn đã chấp nhận rủi ro ghi trong README (API không chính thức, tài khoản có thể bị hạn chế).

Ghi chú:
- Nếu PowerShell chặn `npm` (lỗi *running scripts is disabled*), thay `npm` bằng `npm.cmd` ở mọi lệnh.
- Chuẩn bị **hai** cửa sổ PowerShell: cửa sổ A chạy worker, cửa sổ B để kiểm tra.
- Đường dẫn thư mục dữ liệu mặc định: `$env:LOCALAPPDATA\CongTrangBedding\zalo-personal`.

```powershell
$repo = "C:\Users\ADMIN\CODE\theo-doi-hang-ve"   # sửa nếu repo ở chỗ khác
$data = "$env:LOCALAPPDATA\CongTrangBedding\zalo-personal"
```

## 1. Cài dependencies

```powershell
cd "$repo\services\zalo-personal-worker"
node -v          # cần >= 22.18
npm ci
npm run typecheck
npm test         # kỳ vọng: pass 104, fail 0
```

## 2. Cấu hình môi trường

```powershell
Copy-Item .env.example .env
# token phát hiện nhóm: ngẫu nhiên, khó đoán
$token = "ctb-discover-" + (-join ((48..57) + (97..102) | Get-Random -Count 10 | ForEach-Object { [char]$_ }))
$token            # ghi lại chuỗi này
notepad .env
```

Trong `.env` sửa:
- `ZP_ENABLED=true`
- `ZP_DISCOVERY_TOKEN=<chuỗi $token ở trên>`
- `ZP_ALLOWED_GROUP_IDS=` để trống ở bước này

Các giá trị còn lại giữ mặc định.

Kiểm tra `.env` không bị Git theo dõi:

```powershell
git -C $repo check-ignore -v services/zalo-personal-worker/.env   # phải in ra một dòng của .gitignore
npm run status    # "enabled": true, "session": { "status": "none" }
```

## 3. Chạy worker (chưa có phiên)

```powershell
npm run dev
```

Kỳ vọng: in ra `Chưa có phiên đăng nhập. Chạy npm run login…` rồi thoát, mã thoát 3. Worker **không** tự mở QR.

## 4. Đăng nhập QR (tài khoản thật)

1. **Đóng mọi tab `chat.zalo.me`** trên trình duyệt. Mỗi tài khoản chỉ có một phiên web listener; mở Zalo Web sẽ làm worker bị ngắt (mã 3000).
2. Chạy:
   ```powershell
   npm run login
   ```
3. Ảnh QR tự mở (`$data\qr\login-qr.png`). Trên điện thoại: Zalo > biểu tượng quét QR > quét, rồi bấm **Xác nhận**.
4. Kỳ vọng:
   - in `Đăng nhập thành công. Phiên đã được mã hóa (dpapi)…`;
   - ảnh QR đã bị xóa: `Test-Path "$data\qr\login-qr.png"` trả về `False`.
5. QR hết hạn (khoảng 100 giây) thì worker tự tạo mã mới, tối đa 3 lần, rồi dừng. Bấm từ chối trên điện thoại thì worker dừng, không thử lại.

Kiểm tra phiên không lưu dạng đọc được:

```powershell
Get-Content "$data\session.json" | Select-String -Pattern "zpw|imei|Mozilla"   # phải KHÔNG có kết quả
npm run status    # "session": { "status": "active", "protection": "dpapi", … }
```

## 5. Kiểm tra kết nối

Cửa sổ A:

```powershell
npm run dev
```

Kỳ vọng thấy các log `state_changed`: `connecting` rồi `connected`.

Cửa sổ B:

```powershell
cd "$repo\services\zalo-personal-worker"
npm run status    # health.state = "connected", health.lastConnectedAt có giá trị
```

## 6. Xác định ID một nhóm thử nghiệm

1. Chọn một nhóm thử nghiệm mà các thành viên **đã đồng ý** cho theo dõi.
2. Từ **chính tài khoản của bạn** (điện thoại), gửi vào nhóm đó đúng chuỗi token ở bước 2, không thêm chữ nào.
3. Cửa sổ A in `>>> Đã phát hiện nhóm. ID nhóm: 1234567890…`. Có thể xem lại:
   ```powershell
   Get-Content "$data\discovered-groups.jsonl"
   ```
4. Có thể thu hồi tin nhắn token trong nhóm.

Một thành viên khác gửi token thì **không** có gì được in ra; xem bộ đếm `dropped.discovery_not_self` trong `npm run status`.

## 7. Thêm nhóm vào allowlist

1. Dừng worker ở cửa sổ A bằng `Ctrl+C`. Kỳ vọng thấy `Worker đã dừng.`
2. Chạy `notepad .env` và đặt `ZP_ALLOWED_GROUP_IDS=<ID nhóm>`. Nhiều nhóm thì ngăn cách bằng dấu phẩy.
3. Chạy lại `npm run dev`. Kỳ vọng log `worker_started` có `allowedGroups: 1`.

## 8. Nhận một tin nhắn thử nghiệm

- Gửi một tin văn bản vào **nhóm đã cho phép**, có thể kèm mention tài khoản của bạn.
- Gửi một tin vào một **nhóm khác**, không nằm trong allowlist.
- (Tùy chọn) nhắn riêng 1-1 cho tài khoản.

## 9. Kiểm tra log metadata

```powershell
Get-ChildItem "$data\logs"
Get-Content (Get-ChildItem "$data\logs\events-*.jsonl" | Sort-Object Name | Select-Object -Last 1) -Tail 5
npm run status
```

Kỳ vọng:
- Tin của nhóm được phép có **một dòng**: `conversationRef` = ID nhóm, `messageType`, `textLength`, `mentionCount`, `mentionsSelf`, `isSelf`. **Không có nội dung tin, không có tên.**
- Nhóm không được phép **không có dòng nào**; `counters.dropped.group_not_allowed` tăng.
- Tin 1-1 có dòng với `conversationRef` dạng `h:<hash>`.
- Kiểm tra không lộ nội dung. Thay `<một từ trong tin bạn vừa gửi>` bằng từ thật; lệnh phải không có kết quả:
  ```powershell
  Select-String -Path "$data\logs\*.jsonl","$data\health.json" -Pattern "<một từ trong tin bạn vừa gửi>"
  ```

## 10. Ngắt kết nối và khởi động lại

1. **Dừng thường:** `Ctrl+C` ở cửa sổ A, rồi `npm run dev` lại. Kỳ vọng worker kết nối lại bằng phiên đã lưu, **không** cần QR.
2. **Dừng khẩn cấp:** ở cửa sổ B chạy `npm run stop`.
   - Cửa sổ A dừng trong khoảng 2 giây.
   - `npm run dev` lúc này bị từ chối (mã 4).
   - Chạy `npm run resume` để gỡ.
3. **Chạy 2 worker:** chạy `npm run dev` ở cả hai cửa sổ. Cửa sổ thứ hai phải báo `Worker khác đang chạy… (PID …)` và thoát.
4. **Mất mạng (tùy chọn):** tắt Wi-Fi khoảng 1 phút. Kỳ vọng `reconnecting` với các log `reconnect_scheduled` có thời gian chờ tăng dần, rồi `connected` khi có mạng lại.
5. **(Tùy chọn) Bị đá:** mở `chat.zalo.me` và đăng nhập. Kỳ vọng worker chuyển `error`, báo bị ngắt do mở Zalo Web, và **không** tự kết nối lại.

## Kết thúc thử nghiệm

```powershell
npm run logout    # đăng xuất phía Zalo + xóa phiên cục bộ
```

Kiểm tra thêm trên điện thoại: Zalo > Cá nhân > Cài đặt > Tài khoản và bảo mật > thiết bị đăng nhập.

Xóa toàn bộ dữ liệu cục bộ (tùy chọn):

```powershell
Remove-Item -Recurse -Force $data
```

## Ghi kết quả

Với mỗi bước, ghi lại: đạt / không đạt, và các dòng log liên quan. **Trước khi gửi log cho ai, kiểm tra lại không có ID cá nhân.**
