# Phase 05 — Central AI System Assistant

> Đọc kèm [phase-04-ai-memory.md](phase-04-ai-memory.md) (Gemini provider, budget, data policy), [self-service.md](self-service.md) và [phase-03-dashboard.md](phase-03-dashboard.md).
> Code: `src/lib/ai-system/**`, migration `00077_ai_system_assistant.sql`, API `src/app/api/ai/system/**`, trang `/apps/accounting/assistant`.
> Trạng thái: **chạy được ở local, mặc định TẮT** (`AI_SYSTEM_ASSISTANT_ENABLED=false`). Chưa deploy, chưa áp 00077 lên cloud.

Người dùng hỏi bằng tiếng Việt về dữ liệu nghiệp vụ thật (hàng về, công nợ NCC, Shopee). Trợ lý chỉ **đọc**, theo đúng quyền của người hỏi **và** của người sẽ đọc câu trả lời. Mỗi câu trả lời ghi nguồn, phạm vi và thời điểm dữ liệu. Không có công cụ ghi dữ liệu nghiệp vụ, và không kênh nào tự gửi tin.

## 1. Kiến trúc

```
Kênh (web / Zalo OA / Zalo Personal)
  └─ AIChannelAdapter        channels.ts     danh tính kênh → user nội bộ; audience; ràng buộc đầu ra
       └─ CentralAIAssistant  assistant.ts   pipeline 12 bước (mục 6)
            ├─ UserIdentityResolver   identity.ts     web session / zalo_user_links / ai_channel_identities → profiles
            ├─ PermissionPolicy       policy.ts       default deny; vai trò + quyền màn hình + audience
            ├─ SystemToolRegistry     registry.ts     tool được khai báo đầy đủ; Zod strict
            ├─ planner (rules)        planner.ts      chặn yêu cầu thay đổi / chủ đề không có dữ liệu; định tuyến dự phòng
            ├─ GeminiToolCallingAdapter gemini-adapter.ts  plan + synthesis qua provider Phase 04 (JSON schema)
            ├─ ToolExecutionService   assistant.ts    executeTool(): kiểm quyền lại, timeout, lỗi → thông điệp an toàn
            ├─ AIResponseValidator    validator.ts    nhãn nguồn + mọi con số phải có trong dữ liệu
            └─ ToolResultFormatter    validator.ts    câu trả lời xác định từ dòng của chính tool
BusinessContextBuilder = planSystemPrompt / synthesisUserPrompt (thời gian VN do server cấp, danh mục tool đã lọc quyền, DATA có nhãn)
```

Dùng lại, không xây lại:

| Thành phần | Dùng lại từ |
|---|---|
| Gemini provider, retry, phân loại lỗi, fake provider | `src/lib/ai-assistant/*` (Phase 04) |
| Hạn mức / budget | `zp_ai_reserve` + bảng `ai_request_usage` (00075). `ai_system_reserve` gọi chính hàm này, nên Hỏi AI Zalo và Trợ lý hệ thống dùng **chung một** hạn mức Gemini |
| Chính sách dữ liệu | `sharingDecision()` (AI_DATA_SHARING_POLICY, GEMINI_TIER, AI_FREE_TIER_DATA_APPROVED) |
| Kỳ thời gian VN | `ai-assistant/time-range.ts` |
| Xác thực | `getAuthContext()` (Supabase Auth + `profiles`), ma trận `permissions.ts` |
| Quyền shop AI | `authorizeShopTool()` + `ai_user_shop_access` (PA-4) |
| Liên kết Zalo OA | `zalo_user_links`, mã `LINK <mã>` (00069) |
| Mã liên kết | `generateLinkCode` / `hashLinkCode` (cùng bảng chữ cái, hạn 10 phút) |

Không có Gemini provider thứ hai, hệ thống xác thực thứ hai hay database riêng.

## 2. System Tool Registry

Mỗi tool (`SystemToolDefinition`, `types.ts`) khai báo: `name`, `title`, `description`, `module`, `sensitivity` (knowledge / operational / financial), `requiredPermissions` (tất cả đều bắt buộc, cộng thêm `ai_system:use`), `input` (Zod strict: key lạ bị từ chối), `timeoutMs`, `maxRows`, `freshness`, `examples` và `run()` trả `ToolResult`. `ToolResult` gồm: outcome, data gọn, `lines` (câu tiếng Việt xác định), `source` (nhãn, view/RPC gốc, màn hình đối chiếu, thời điểm đọc, thời điểm dữ liệu, độ tươi, phạm vi), `caveats` và `scope` dùng cho audit.

`register()` từ chối tên sai định dạng, tên trùng, timeout ngoài khoảng 0,5–30 giây và `maxRows` ngoài khoảng 1–100. JSON schema đưa cho model được sinh từ chính schema Zod (`z.toJSONSchema`), nên chỉ có một nguồn sự thật.

Model **không bao giờ** đưa SQL, URL, lệnh hay ID. Tên NCC, shop hay số hóa đơn được truyền dạng **chữ**, rồi server tra cứu xác định trong phạm vi người dùng được xem (khớp mã, rồi tên, rồi đủ mọi từ; không đoán). Nếu không thấy thì trả `not_found`. Nếu nhiều kết quả khớp thì trả `ambiguous` kèm danh sách. Chuỗi lọc được escape ký tự đại diện LIKE, và schema chặn `% _ \ * ; < > { }`.

## 3. Business tools

### Đã triển khai (dữ liệu thật)

| Tool | Module | Nhạy cảm | Quyền | Nguồn (giống màn hình) |
|---|---|---|---|---|
| `get_receiving_status` | Hàng về | operational | `receipt:view` | RPC `get_receipt_daily_groups` → /receipts |
| `get_outstanding_goods` | Hàng về | operational | `outstanding:view` | view `v_outstanding` + nhãn trạng thái hệ thống → /outstanding |
| `get_supplier_payables` | Công nợ | financial | `debt:view` | `v_supplier_debt_summary` + RPC `get_debt_overview` → /debts |
| `get_invoices` | Công nợ | financial | `invoice:view` + `debt:view` | `v_invoice_debt` + `get_debt_overview` |
| `get_payment_summary` | Công nợ | financial | `payment:view` | `v_payment_summary` → /payments |
| `get_shopee_overview` | Shopee | financial | `app:shopee` + `channel:view` + quyền shop AI | RPC `product_intelligence_list` → /shopee/product-analytics |
| `get_shopee_revenue` | Shopee | financial | như trên | như trên; định nghĩa `PRODUCT_METRIC_META.sales_gmv` |
| `get_top_selling_products` | Shopee | financial | như trên | như trên (sort gmv / orders / units, tối đa 10) |
| `get_shopee_ads_performance` | Shopee | financial | như trên + `SHOPEE_ADS_DATA_SOURCE=real` | `shopee_ads_shop_daily_performance` + `totalsOf` / `deriveMetrics` → /shopee/ads |
| `explain_business_term` | Kiến thức | knowledge | (chỉ `ai_system:use`) | định nghĩa soạn từ view / metric meta |

Quy tắc chung:
- **Không tính lại nghiệp vụ.** Mọi số tiền, công nợ, trạng thái và tỷ lệ đều lấy từ cùng view/RPC/hàm mà màn hình đang dùng. Tool chỉ định dạng (vi-VN) và gắn nhãn.
- **Thiếu dữ liệu không phải 0.** Shop chưa đồng bộ doanh số trả về `empty` với câu "chưa có dữ liệu", không bao giờ là "0 ₫". Kỳ chưa đồng bộ đủ được ghi là "mức tối thiểu".
- **Hôm nay là số tạm tính.** Shopee so sánh cùng khung giờ (theo read model PA). Ads ghi thời điểm đọc gần nhất và cảnh báo khi quá 25 phút.
- **Shopee dùng nguồn đang chạy.** Đó là read model Phân tích sản phẩm (PA-1/PA-2). Module `channel_orders` / `/shopee/analytics` đã ngừng (`SHOPEE_LEGACY_MODULES_ENABLED=false`, không còn job đồng bộ), nên không tool nào đọc nó.

### Chưa thể triển khai (và lý do)

| Đề xuất trong spec | Lý do | Trợ lý trả lời gì |
|---|---|---|
| `get_inbound_shipments`, `get_overdue_shipments` (lô sắp về / đang chậm) | Schema không có ngày dự kiến về, lô hàng hay trạng thái vận chuyển. Chỉ có phiếu nhận thực tế (`receipts`) và số còn thiếu theo hóa đơn (`v_outstanding`) | `unsupported` kèm giải thích; gợi ý xem hàng đã về / còn phải về |
| `get_shipments_by_supplier` | Gộp vào `get_outstanding_goods` (theo NCC) và `get_receiving_status` (lọc NCC) | — |
| `get_inventory_status` | `v_product_cost_overview.quantity_on_hand` là sổ giá vốn. Sổ này giảm theo giá vốn đơn Shopee của module đã ngừng, nên chưa xác minh được là tồn kho đúng | `unsupported` (inventory) |
| `get_overdue_payables` | Không có hạn thanh toán. `get_invoices` có "tuổi hóa đơn" (số ngày từ ngày HĐ), được ghi rõ **không phải** quá hạn | `unsupported` (overdue_payables) |
| `get_shopee_orders` (danh sách đơn) | Luồng đơn chi tiết đã ngừng đồng bộ. Read model mới chỉ có số đơn theo sản phẩm / kỳ | `unsupported` (order_list); số đơn có trong `get_shopee_revenue` |

## 4. Phân quyền

Vai trò giữ nguyên: `admin`, `staff`, `viewer`. Không tạo vai trò mới. "Owner" trong spec tương ứng `admin`. Hệ thống không có vai trò khách hàng.

- Quyền mới `ai_system:use` = admin + staff. Viewer không dùng được trợ lý.
- Mỗi tool **còn** yêu cầu đúng quyền màn hình của nó, nên trợ lý không bao giờ thấy nhiều hơn màn hình.
- Shopee: dùng lại nguyên quy tắc AI hiện có, `authorizeShopTool()` (tài khoản active, vai trò thuộc `CONVERSATION_ALLOWED_ROLES` = admin, `app:shopee` + `channel:view`, có dòng `ai_user_shop_access`). Quy tắc này được kiểm cho **từng shop ở từng lần gọi**. Staff có grant vẫn bị từ chối, vì đợt triển khai AI Shopee hiện chỉ dành cho admin; Phase 05 không nới quy tắc này.
- **Audience:** `group` (nhóm Zalo nhiều người) chỉ nhận tool `knowledge`, kể cả khi người hỏi là admin. Câu trả lời được xét theo **người đọc**, không chỉ người hỏi (`AUDIENCE_ALLOWS`, `policy.ts`).
- **Default deny:** không resolve được danh tính, profile inactive, vai trò lạ, thiếu quyền, hoặc audience không cho phép đều dẫn tới từ chối.
- Profile được **đọc lại từ DB** ở đầu request và **trước mỗi lần gọi tool**. Khóa user hoặc đổi vai trò có hiệu lực ngay ở lần gọi tool kế tiếp.
- Không tin frontend (danh tính lấy từ session server), không tin model (tên tool, tham số, quyền đều kiểm lại), không tin nội dung tin nhắn ("tôi là chủ").

## 5. Identity mapping

| Kênh | Bằng chứng danh tính | Bảng |
|---|---|---|
| Web | Supabase session (`auth.getUser`) | `profiles` |
| Zalo OA | Follower đã gửi `LINK <mã>`; mã do admin tạo khi đăng nhập (luồng sẵn có của OA) | `zalo_user_links` (00069), dùng lại |
| Zalo Personal | Người gửi (Zalo id, theo từng kết nối) đã gửi `LINK <mã>` trong chat 1-1; mã do chính user tạo khi đăng nhập | `ai_channel_identities` + `ai_identity_link_codes` (00077) |

Luồng Zalo Personal:
1. User đăng nhập, gọi `issuePersonalLinkCode()`. Server tạo mã 8 ký tự, hạn 10 phút; chỉ hiển thị một lần, DB chỉ lưu SHA-256.
2. Worker nhận tin `LINK <mã>` từ người gửi. Gọi `linkPersonalIdentity({ connectionId, senderId, code })`, hàm này gọi RPC `ai_identity_consume_code`, chạy nguyên tử: mã chưa dùng, còn hạn, profile active. Mapping cũ của cùng người gửi bị thu hồi.
3. Thu hồi: `revokePersonalIdentity()` (chỉ chủ mapping). Khóa user thì mapping ngừng tác dụng ngay vì mỗi lần đều đọc lại profile.

External id ở các kênh **không** được coi là cùng một người. Một Zalo id chỉ map trong phạm vi kết nối của nó.

**Chưa nối dây:** worker hiện không gửi nội dung tin 1-1 về server (`ZP_DIRECT_MESSAGES=metadata` mặc định), và chưa có giao diện tạo mã. Bước 2 mới có service, DB, RPC và test; **chưa xác minh với tài khoản Zalo thật**.

## 6. Gemini tool calling

Không dùng function calling gốc, và không tạo provider thứ hai. Provider Phase 04 đã sinh JSON theo schema, nên "tool calling" gồm **2 lần sinh JSON có giới hạn**:

1. **Plan.** System prompt chứa giờ VN do server cấp, kênh, audience, và **chỉ các tool người này được phép** (tên, mô tả, JSON schema, ví dụ). Schema trả lời giới hạn `tool` bằng `enum` các tên đó và `calls ≤ AI_SYSTEM_MAX_TOOL_CALLS`. Model trả `call_tools`, `unsupported`, `refuse_change` hoặc `clarify`.
2. Backend kiểm lại từng call: tool có tồn tại, vẫn được phép, tham số qua Zod strict, không trùng (cùng call chạy một lần), không quá N call.
3. **Synthesis.** Model nhận câu hỏi và kết quả có nhãn `[T1]…` trong khối `<<DATA-T1>> … <<END-T1>>` (đánh dấu là dữ liệu, không phải chỉ dẫn), kèm "tóm tắt chuẩn" để chép số nguyên văn. Model trả `status / answer / points[sourceIds] / caveats`.

Mỗi lần gọi model đều qua `ai_system_reserve` (ngân sách chung, khóa advisory), dùng `generateWithRetry` (chỉ retry lỗi mạng hoặc 5xx; không retry 429, quota, timeout), rồi ghi `zp_ai_finish`. Giới hạn: số call tool, 2 lần gọi model mỗi câu hỏi, timeout model (`AI_REQUEST_TIMEOUT_MS`) và tool (`AI_SYSTEM_TOOL_TIMEOUT_MS`), số dòng (`AI_SYSTEM_MAX_ROWS`), token (`AI_MAX_INPUT_TOKENS` / `AI_MAX_OUTPUT_TOKENS`), kỳ tối đa 92 ngày, và `AI_SYSTEM_REQUESTS_PER_MINUTE` câu hỏi mỗi người mỗi phút. Không có vòng lặp: plan một lần, chạy tuần tự, synthesis một lần.

**Khi không gọi model** (AI tắt, thiếu key, chính sách dữ liệu, hết hạn mức, model lỗi hoặc trả sai), trợ lý vẫn trả lời: dùng planner quy tắc và formatter xác định, kèm `meta.notice` giải thích. Business data chỉ được gửi tới Gemini khi `sharingDecision` cho phép **và** không ở chế độ `redacted`. Với `redacted`, câu hỏi được che trước khi plan, còn số liệu không được gửi đi.

## 7. API contracts

| Method | Route | Body / Query | Kết quả |
|---|---|---|---|
| POST | `/api/ai/system/ask` | `{ question: string(2..500) }` (strict) | `{ success: true, data: AssistantResponse }` |
| GET | `/api/ai/system/status` | — | `{ success: true, data: SystemAssistantStatus }` (model, chính sách dữ liệu, lượt gọi hôm nay, giới hạn, tool user được dùng) |

Lỗi: 404 `not_enabled` (cờ tắt), 401 `unauthenticated`, 403 `inactive` / `forbidden`, 400 `invalid_input`, 500 `server_error`. Thông điệp an toàn, không có stack hay lỗi DB. Header `Cache-Control: no-store`.

`AssistantResponse` (`types.ts`):

```
{ requestId, status: answered|insufficient|denied|unsupported|clarify|refused|error|rate_limited,
  answer, points: [{ text, sourceIds: ["T1"] }],
  sources: [{ id: "T1", tool, label, origin, href, readAt, dataUpdatedAt, freshness, coverage }],
  caveats: [], tools: [{ name, title, outcome }],
  meta: { planner: gemini|rules|none, synthesis: gemini|formatter|none, model, generatedAt, notice } }
```

## 8. Dashboard

Trang `/apps/accounting/assistant`, mục menu **"Trợ lý AI"** trong app "Theo dõi hàng về". Mục này **ẩn** khi cờ tắt hoặc user thiếu `ai_system:use`. Trang có: ô hỏi (Enter để gửi), câu hỏi gợi ý theo tool user được dùng, câu trả lời kèm nhãn nguồn, danh sách nguồn (phạm vi, thời điểm đọc, thời điểm dữ liệu, độ tươi, link màn hình), lưu ý, tool đã dùng và kết quả, cách diễn đạt (AI đã đối chiếu số hoặc nguyên văn), thông báo khi thiếu quyền, AI lỗi hay hết hạn mức, trạng thái đang tải và lỗi, thanh hạn mức.

Web Conversation hiện có (`/apps/shopee/ai`, Product Analyst / Claude) và "Hỏi AI" Zalo Personal **không đổi**. Trợ lý hệ thống không lưu hội thoại (lịch sử chỉ nằm trong trang) và không nhập lịch sử OA hay Zalo Personal.

## 9. Channel adapters

`AIChannelAdapter { channel, enabled(deps), resolve(store, input) → { identity, context }, render(response, context) }`. `context` gồm channel, audience, conversationRef (chỉ dùng cho log) và constraints (`maxChars`, `canSend: false`).

| Adapter | Cờ (mặc định tắt) | Audience | Đầu ra |
|---|---|---|---|
| `webAdapter` | `AI_SYSTEM_ASSISTANT_ENABLED` | private | `AssistantResponse` |
| `oaAdapter` | `AI_SYSTEM_OA_ENABLED` | private (OA luôn 1-1) | `{ kind: "text_parts", parts ≤ 3 × 1900 ký tự, send: false }` |
| `personalAdapter` | `AI_SYSTEM_PERSONAL_DRAFTS_ENABLED` | group nếu hội thoại nhóm, ngược lại private | `{ kind: "draft", text, send: false }` |

**Zalo OA:** OAuth, webhook, token refresh và quy tắc gửi tin **không đổi**. Adapter **không** được nối vào webhook trong Phase 05 (webhook vẫn chỉ phục vụ Product Analyst + công nợ NCC như trước). Không có auto-reply.
**Zalo Personal:** không gửi tin. Chỉ tạo bản nháp để kiểm thử. Gửi tự động thuộc Phase 04.5 / 07.

## 10. Security

| Rủi ro | Biện pháp |
|---|---|
| Prompt injection (câu hỏi, dữ liệu DB, tài liệu) | Prompt đánh dấu DATA là dữ liệu. Model không có công cụ trong bước synthesis. Plan chỉ chọn trong enum tool đã lọc. Mọi call kiểm lại ở backend. Yêu cầu thay đổi bị chặn bằng quy tắc **trước** model |
| Gọi tool trái phép / role spoofing | Registry đóng, quyền vai trò + quyền màn hình + audience, profile đọc lại trước mỗi tool, danh tính chỉ từ session hoặc liên kết đã xác minh |
| SQL injection | Không có SQL động. PostgREST tham số hóa. Tên được tra trong app. Escape LIKE. Zod chặn ký tự đặc biệt |
| IDOR / cross-tenant / cross-shop | Model không đưa ID. Shop: grant AI theo từng shop, từng lần gọi. NCC / hóa đơn: theo quyền màn hình (dữ liệu dùng chung toàn công ty, như màn hình) |
| Cross-channel / nhóm A sang nhóm B | Lịch sử kênh không được trộn. Nhóm chỉ nhận định nghĩa. Tool hệ thống không đọc nội dung Zalo |
| Lộ số liệu tài chính | Audience group bị chặn. Chính sách dữ liệu Phase 04 áp cho cả bước gửi số liệu tới Gemini. Log và audit không chứa câu hỏi, câu trả lời hay số liệu |
| Hallucination | Synthesis bị loại nếu nhãn nguồn sai hoặc có số không có trong dữ liệu (`ungroundedNumbers`); khi đó dùng formatter. Thiếu dữ liệu không thành 0 |
| Gọi quá nhiều / truy vấn không giới hạn | ≤ N tool / câu, tool trùng chạy một lần, `maxRows`, kỳ ≤ 92 ngày, timeout từng tool, rate limit mỗi người, budget DB nguyên tử |
| Lỗi lộ thông tin | Lỗi tool thành "không đọc được dữ liệu lúc này". Lỗi DB và lỗi provider chỉ ghi tên hoặc mã |

Audit: `ai_system_requests` (user, kênh, audience, status, planner, synthesis, lý do, danh sách tool, thời lượng) và `ai_system_tool_calls` (tool, độ nhạy, outcome, scope đã resolve như kỳ / id / cờ, số dòng, thời lượng). Không có nội dung. RLS bật, chỉ `service_role`.

## 11. Test results (local, 2026-11-25)

Xem báo cáo cuối phase trong hội thoại triển khai. Các lệnh:

```
node --test src/lib/ai-system/ai-system.test.ts                                    # unit (không DB, không mạng)
node --env-file=.env.local --test src/lib/ai-system/ai-system.integration.test.ts  # Supabase local
npm test                                                                            # toàn bộ hồi quy
```

Gemini thật **không** dùng trong test. Mọi test dùng `FakeAiProvider`.

## 12. Rollback

| Mức | Cách làm | Mất dữ liệu? |
|---|---|---|
| 1. Tắt | `AI_SYSTEM_ASSISTANT_ENABLED=false` (mặc định); `AI_SYSTEM_OA_ENABLED` / `AI_SYSTEM_PERSONAL_DRAFTS_ENABLED` vẫn tắt | Không |
| 2. Gỡ code | `git revert` commit Phase 05 (thư mục `src/lib/ai-system`, API, trang, mục menu, quyền `ai_system:use`) | Không |
| 3. Gỡ schema 00077 (**chỉ khi chủ dự án duyệt**) | SQL dưới đây | Có: audit + identity Zalo Personal + usage có channel/feature mới |

```sql
-- KHÔNG tự động chạy. Backup trước.
BEGIN;
DROP FUNCTION IF EXISTS public.ai_identity_consume_code(text, text, uuid, text);
DROP FUNCTION IF EXISTS public.ai_system_reserve(uuid, text, text, text, text, integer, timestamptz, integer, integer, integer, integer);
DROP TABLE IF EXISTS public.ai_identity_link_codes, public.ai_channel_identities, public.ai_system_tool_calls, public.ai_system_requests;
DELETE FROM public.ai_request_usage WHERE channel <> 'zalo_personal' OR feature IN ('system_plan', 'system_answer');
ALTER TABLE public.ai_request_usage DROP CONSTRAINT IF EXISTS ai_request_usage_channel_check;
ALTER TABLE public.ai_request_usage ADD CONSTRAINT ai_request_usage_channel_check CHECK (channel = 'zalo_personal');
ALTER TABLE public.ai_request_usage DROP CONSTRAINT IF EXISTS ai_request_usage_feature_check;
ALTER TABLE public.ai_request_usage ADD CONSTRAINT ai_request_usage_feature_check CHECK (feature IN ('ask', 'summarize'));
DELETE FROM supabase_migrations.schema_migrations WHERE version = '00077';
COMMIT;
NOTIFY pgrst, 'reload schema';
```

## Cấu hình

```
AI_SYSTEM_ASSISTANT_ENABLED=false        # trang + API web
AI_SYSTEM_OA_ENABLED=false               # adapter OA (chưa nối webhook)
AI_SYSTEM_PERSONAL_DRAFTS_ENABLED=false  # adapter Zalo Personal (chỉ nháp)
AI_SYSTEM_MAX_TOOL_CALLS=3               # 1–5
AI_SYSTEM_TOOL_TIMEOUT_MS=8000
AI_SYSTEM_MAX_ROWS=20                    # 5–50
AI_SYSTEM_REQUESTS_PER_MINUTE=6
# Model / key / chính sách dữ liệu / hạn mức: dùng chung Phase 04
# (AI_ENABLED, AI_PROVIDER, GEMINI_*, AI_DATA_SHARING_POLICY, AI_FREE_TIER_DATA_APPROVED, AI_MAX_*)
```

Triển khai production (chưa làm, cần chủ dự án duyệt): áp 00077 lên cloud, `NOTIFY pgrst, 'reload schema'`, thêm biến trên Vercel, cấp `ai_user_shop_access` cho admin cần hỏi Shopee, và quyết định chính sách gửi dữ liệu nghiệp vụ tới Gemini (mặc định `none`, nghĩa là trả lời không qua AI).
