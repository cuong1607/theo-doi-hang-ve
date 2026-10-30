# Zalo OA conversation gateway (SHOPEE-PRODUCT-ANALYTICS-1, part B)

**ZALO IS TRANSPORT.** The OA receives a question and delivers an answer. Authorization, context and (later) analysis live behind the conversation service. In this phase every analytical question gets the controlled reply **"Hệ thống phân tích sản phẩm đang được chuẩn bị."**, prefixed with what was understood (intent, product phrase, shop, period). Nothing is ever invented.

Off by default: `ZALO_CONVERSATION_ENABLED=false`.

## 1. Flow

```
Zalo OA ── POST /api/zalo/webhook ──► verify X-ZEvent-Signature (fail closed)
                                      parse (user_send_text only) · own OA · per-sender rate limit
                                      acceptIncomingMessage(): upsert conversation, INSERT inbound message
                                      (UNIQUE channel + provider msg id → duplicate = no-op)
                                  ◄── 200 { ok, accepted } (fast)
         after():  processAcceptedMessage()
                   1. "LINK <code>" → one-time code → zalo_user_links
                   2. unlinked → one notice / 24 h, otherwise silent
                   3. linked profile must be ACTIVE + role allowed (admin in this rollout)
                   4. route (deterministic) + context ("còn hôm qua?")
                   5. shop = mention ∩ grants | remembered shop ∩ grants | the single grant
                      (mention of a non-granted shop → "Bạn không có quyền xem shop này.")
                   6. ProductAnalystProvider.analyze(request)   ← disabled provider: placeholder
                   7. OutboundSender.sendText() → ai_messages (outbound) → inbound status replied / failed
```

Code:

| Concern | File |
|---|---|
| Signature + event parsing (pure) | `src/lib/zalo/webhook.ts` |
| Request handling (flag → verify → parse → OA → rate limit → accept) | `src/lib/zalo/webhook-handler.ts` |
| Route (answers, then processes in `after()`) | `src/app/api/zalo/webhook/route.ts` (public in `src/proxy.ts`, with its own signature check) |
| Conversation service (channel-agnostic) | `src/lib/conversation/service.ts` |
| Router (no LLM) | `src/lib/conversation/router.ts` |
| Supabase store | `src/lib/conversation/supabase-store.ts` |
| Wiring + Zalo `sendText` adapter | `src/lib/conversation/server.ts` |
| Analyst interface / disabled provider | `src/lib/product-analyst/` |
| Admin self-service (link code, revoke, shop grants) | `/settings/zalo-agent` |

The webhook never imports an analyst implementation (static guard). The analyst never calls Zalo: it returns content, and the service sends it.

## 2. Tables (migration 00069)

| Table | Purpose | Notes |
|---|---|---|
| `zalo_user_links` | Zalo user id → internal profile | Created only by a valid one-time code. Status `active` / `revoked`. |
| `zalo_link_codes` | One-time link codes | **sha256 hash only.** 10-minute TTL. Consumed by a single conditional UPDATE (two deliveries cannot both win). |
| `ai_user_shop_access` | Explicit shop grants for the agent | **Deny by default**, whatever the app role (the app itself has no per-shop scoping). |
| `ai_conversations` | One per (channel, external user) | `current_shop_id`, `current_product_id` (future, resolved product), `last_intent`, `context` (`productQuery`, `period`, notice / brute-force counters). A link change clears the remembered shop. |
| `ai_messages` | Inbound / outbound text | Partial UNIQUE (`channel`, `provider_message_id`) for inbound. Status pending → replied / ignored / failed; outbound sent / failed. |

There is no raw webhook payload column. Link codes are stored as `[mã liên kết]`, and an unlinked follower's text is stored as `[người dùng chưa liên kết]`. No analytics facts are stored here. RLS is on, nothing is granted to anon / authenticated, and service_role has explicit grants (cloud has no default grants).

## 3. Identity, linking, access

- **No trust in display name or phone.** The only proof is a code that an admin generated while signed in, sent from the Zalo account that should be linked.
- **Early rollout (spec §35):** `CONVERSATION_ALLOWED_ROLES = ["admin"]`. This is checked when a code is consumed and on every message, so deactivating or demoting a profile cuts access immediately.
- **Brute force:** at most 5 failed codes per conversation per day. Codes are 8 characters from a 32-character alphabet (~10¹²) with a 10-minute life.
- **Authorization on every message:** grants are re-read each time. The context remembers which shop was discussed but never grants it: if the grant is revoked, the remembered shop is dropped. The request handed to the analyst is checked once more just before the call. Future tools will re-check `internal_user_id` + `shop_id` in the backend again.

Linking steps for an admin:
1. Open `/settings/zalo-agent` and click "Tạo mã liên kết".
2. Send `LINK <code>` to the OA.
3. Tick the shops and click "Lưu quyền shop".

## 4. Security of the webhook

- **Signature:** header `X-ZEvent-Signature: mac=<sha256_hex(app_id + raw_body + timestamp + OA_SECRET_KEY)>`, where `timestamp` is the body field. The comparison is timing-safe. `app_id` must equal `ZALO_APP_ID`, and the timestamp must be within ±15 min.
- **⚠ Formula source:** Zalo developer-community threads and third-party write-ups. The official spec page could not be fetched from this environment. **Before enabling, send one real message and confirm it is accepted.** A rejection logs `{"event":"rejected","reason":"bad_signature"}` without leaking anything. Community reports mention a millisecond mismatch between the header timestamp and the body timestamp; the code signs with the body timestamp.
- **Fail closed:** with the flag on and `ZALO_OA_SECRET_KEY` missing the webhook answers 503; with a bad signature it answers 401.
- **Never logged:** the OA access token, the secret, the signature header, the raw body. Logs carry only event / reason / outcome codes.
- Body limit 64 KB. Only `user_send_text` is processed; other events are acknowledged and ignored. Events addressed to another OA are ignored.
- Per-sender limit: 20 messages / minute (process-local).

## 5. Router (deterministic, no LLM)

Accent-folded keyword rules:

| Intent | Keywords |
|---|---|
| `HELP` | hướng dẫn, trợ giúp, help, menu |
| `ADS_ANALYSIS` | quảng cáo, ads, roas, cpc, chiến dịch |
| `PRODUCT_ANALYSIS` | sản phẩm, sp, sku, mã hàng |
| `SHOP_ANALYSIS` | shop, cửa hàng, doanh số, doanh thu |

- **Periods:** hôm nay / hôm qua / tuần này / tuần trước / 7 ngày / 30 ngày / tháng này / tháng trước.
- **Product phrase:** the text after "sản phẩm …", up to the period word.
- **Follow-ups** ("còn hôm qua?", "thế tuần trước thì sao") reuse the last analytical intent and product phrase.
- No product resolution yet: `productId` stays null and only the phrase is passed on.

## 6. Configuration

| Env | Default | Notes |
|---|---|---|
| `ZALO_CONVERSATION_ENABLED` | false | When off, the webhook answers 200 `ignored: disabled` and stores nothing. |
| `ZALO_OA_SECRET_KEY` | — | OA webhook "OA Secret Key". Server-only. |
| `ZALO_APP_ID`, `ZALO_OA_ID` | existing | App check and own-OA check. |
| `AI_PRODUCT_ANALYST_ENABLED` / `_PROVIDER` / `_MODEL` | false / anthropic / — | No effect in this phase (placeholder only). |

There are no `NEXT_PUBLIC_*` Zalo variables.

## 7. Enabling (when the user decides)

1. Run `supabase db push` (00069), then `NOTIFY pgrst, 'reload schema'`.
2. In the Zalo OA webhook settings, set the URL to `https://theo-doi-hang-ve.vercel.app/api/zalo/webhook`, subscribe to `user_send_text`, and copy the OA Secret Key into Vercel as `ZALO_OA_SECRET_KEY`.
3. Set `ZALO_CONVERSATION_ENABLED=true` and redeploy.
4. Send one message. The signature must be accepted (see the ⚠ in §4).
5. Link the admin account and grant shops at `/settings/zalo-agent`.

Known limits:
- Outbound uses the existing OA CS message API (`/v3.0/oa/message/cs`), with Zalo's own interaction-window rules.
- The rate limiter is per instance.
- Processing runs in `after()` (≤ 60 s route budget). The future long-running analysis should move to a queue.
