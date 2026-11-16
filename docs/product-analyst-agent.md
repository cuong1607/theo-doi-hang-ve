# Product Analyst Agent (PRODUCT-ANALYTICS-4)

**SQL owns truth. Claude owns interpretation. Zalo is transport.** The analyst answers questions about Shopee products and Ads using read-only, aggregated tool results. It never computes truth from raw rows, never changes anything, and never sees PII, SQL or tokens.

Everything is **off by default**:

| Env | Default | Effect |
| --- | --- | --- |
| `AI_PRODUCT_ANALYST_ENABLED` | `false` | Master switch. On its own it enables no channel. |
| `AI_PRODUCT_ANALYST_ZALO_ENABLED` | `false` | Zalo answers with the analyst (needs the master switch). |
| `AI_PRODUCT_ANALYST_WEB_ENABLED` | `false` | Enables `/apps/shopee/ai` (needs the master switch). |
| `AI_PRODUCT_ANALYST_PROVIDER` | `anthropic` | `anthropic`, or `fake` (deterministic, no network: tests and demos). |
| `AI_PRODUCT_ANALYST_MODEL` | `claude-sonnet-5-5` | The only place the default model id is written is `config.ts`. |
| `AI_PRODUCT_ANALYST_EFFORT` | `medium` | `low` / `medium` / `high`. |
| `AI_PRODUCT_ANALYST_ALLOWED_USER_IDS` | empty | Optional allowlist of internal user ids for the pilot. |
| `AI_PRODUCT_ANALYST_MAX_TOOL_CALLS` / `_MAX_MODEL_TURNS` / `_TIMEOUT_MS` | 8 / 6 / 75000 | Per-request budget. |
| `AI_PRODUCT_ANALYST_MAX_CALLS_PER_MINUTE` / `_MAX_DAILY_CALLS_PER_USER` / `_MAX_DAILY_COST_USD` | 4 / 60 / 5 | Limits, checked against `ai_usage_logs`. |
| `AI_PRODUCT_ANALYST_PRICING_JSON` | — | Price override (`{"model":{"input":…,"output":…}}`); no migration needed. |
| `AI_PRODUCT_ANALYST_CACHE` / `_FALLBACKS` | on / on | Turn off with `off` / `false`. |
| `ANTHROPIC_API_KEY` | — | **Server only.** Read by the SDK. Never `NEXT_PUBLIC_*`, never logged. |

Rollout: the role must be in `CONVERSATION_ALLOWED_ROLES` (admin today), have Shopee app access (`app:shopee` + `channel:view`), and have explicit shop grants (`ai_user_shop_access`, managed at `/settings/zalo-agent`). The grants apply to both Zalo and web.

## Architecture

```
Zalo webhook ─► conversation service (service.ts) ─┐
Web /apps/shopee/ai ─► askWeb (web.ts) ────────────┤  ProductAnalyst.analyze(request)
                                                   ▼
                     ProductAnalystOrchestrator (orchestrator.ts)
                       1. authorize: user active, role, app:shopee + channel:view, shop grant, product ∈ shop
                       2. limits: 1 running / user, per minute, per day, daily cost
                       3. cache (AFTER authorization)
                       4. provider.run(): bounded tool loop ──► executeAnalystTool (tools.ts)
                                                               └ re-authorizes EVERY call (agent-tools.ts)
                       5. check: schema → policy guards → data guards → numeric grounding (1 repair turn)
                       6. ai_usage_logs + observability log
                                                   ▼
                     formatter.ts → Zalo (≤ 3 messages) / web card
```

| Piece | File |
| --- | --- |
| Config, model, limits, prices | `src/lib/product-analyst/config.ts` |
| Contracts (request / response / output schema / cache key) | `contracts.ts` |
| System prompt, `PRODUCT_ANALYST_PROMPT_VERSION = "pa4-v1"` | `prompt.ts` |
| Model tools (allowlist) + executor + raw-data guard + 6 KB budget | `tools.ts` |
| Backend tool functions (read only, authorized) | `src/lib/product-analytics/agent-tools.ts` |
| Claude provider (official SDK, manual loop) | `claude-provider.ts` |
| Fake provider (deterministic) | `fake-provider.ts` |
| Orchestrator | `orchestrator.ts` |
| Guards | `guard.ts` |
| Usage / cache store | `analyst-store.ts` (tables of migration 00072) |
| Wiring (channel flags) | `server.ts`, `access.ts` |
| Zalo / web channels | `src/lib/conversation/service.ts`, `web.ts` |

## Provider and model

- **Provider:** `ClaudeProductAnalystProvider` uses `client.beta.messages.create` from `@anthropic-ai/sdk`.
  - **Model:** Sonnet-class by default; set through config only.
  - **Thinking:** adaptive (the model default). `output_config.effort` comes from config.
  - **Output format:** `output_config.format` is the `AnalystOutput` JSON schema.
  - **Tools:** strict schemas, tool choice `auto` (forced choice is rejected by current models).
  - **Prompt caching:** a cache breakpoint on the frozen system prompt. Tools and system are stable, so the prefix is cacheable.
  - **Refusals:** server-side refusal fallback (`fallbacks: "default"`) on models that accept it. A final refusal is answered with the controlled error message.
- **Loop budget:** at most 8 tool executions and 6 model turns. A model that keeps asking for tools gets one "answer now" result, then the loop stops with `tool_budget_exceeded`. A deadline is set and an `AbortSignal` cancels the in-flight request.
- **Routing:** no model routing in v1. `config.model` is the single place to change it later; the cache key includes the model family.

## Tools (only these)

Every tool takes **only an enum period** (`context` / `today` / `yesterday` / `7d` / `30d`) or, for the baseline, an enum `days`. The shop, product and user always come from the trusted request. A model cannot name an id, a date, SQL or a URL. Unknown tools, extra keys and out-of-enum values are rejected before any read.

| Tool | Use |
| --- | --- |
| `get_product_overview` | Identity, health, sales / Ads summary, top signals, current snapshot, data quality. |
| `compare_product_periods` | Current vs previous period with absolute and % deltas, computed in SQL. |
| `get_product_sales_summary` | GMV / orders / units / cancelled, with semantics and coverage. |
| `get_product_ads_performance` | Spend, impressions, clicks, CTR, CPC, direct / broad orders and GMV, ROAS, CVR, and the attribution indicator. |
| `get_product_baseline` | The product's own 7–90 day history: median, mean, CV. |
| `get_product_signals` | Factual signals, health rule, attention priority, data-quality signals, shop context. |
| `get_shop_product_attention_summary` | Shop level: health distribution, the top 10 attention products, shop totals, data quality. |

**Measured on the production replica** (5 products, 30d):

| Tool | Max size |
| --- | --- |
| `get_product_overview` | 2.5 KB |
| `compare_product_periods` | 3.2 KB |
| `get_product_sales_summary` | 2.2 KB |
| `get_product_ads_performance` | 2.9 KB |
| `get_product_baseline` | 1.8 KB |
| `get_product_signals` | 3.2 KB |
| `get_shop_product_attention_summary` | 5.8 KB |
| Typical diagnosis (overview + signals + compare + ads) | 11.9 KB |

**Raw-data guard:** keys such as buyer / phone / address / order_sn / payload / token / sql, and SQL-looking strings, block the result.

There are no mutation tools. Mutation requests ("tăng budget…") are answered in the channel layer without any analysis.

## Output (validated)

The fields are `summary` · `data_quality_note` · `evidence[{id,text}]` · `findings[{title,description,severity,evidence_refs}]` · `hypotheses[{statement,confidence,supporting_evidence,counter_evidence,missing_data}]` · `confidence` · `missing_data` · `suggested_checks` · `follow_up_context{topic}`.

`validateAnalystOutput` rejects:
- unknown keys at any level (`actions`…);
- unbounded sizes;
- findings without evidence, or with evidence ids that do not exist;
- hypotheses without support.

**Guards** (`guard.ts`), applied after validation:

| Guard | Catches |
| --- | --- |
| `organic_subtraction` | "doanh số organic/tự nhiên", "doanh số − Ads GMV" |
| `ads_revenue_share` | "Ads tạo ra X% doanh thu", "X% doanh số đến từ Ads" |
| `profit_claim` | lãi / lỗ / lợi nhuận / margin. A statement of absence is allowed. |
| `market_claim` | thị trường / đối thủ |
| `certain_causation` | "chắc chắn là do…" |
| `mutation_promise` | "sẽ tăng ngân sách…" |
| `internal_leak` | tool / table names, SQL, "system prompt" |
| `null_as_zero` | "doanh số bằng 0" while the data is null / lower bound |
| `partial_today_confidence` | HIGH confidence while today is unfinished |
| Numeric grounding | Every number in the answer must match a number the tools returned (including numbers inside product names) or the user wrote, within its display precision. `100%` is allowed for the mandatory attribution caveat. |

A failed check gets **one repair turn** with the reason. A second failure becomes `OUTPUT_INVALID` and the user gets the safe message. Raw model output is never rendered.

## Authorization

- **Before the analysis:** the orchestrator calls `authorizeProductTool` / `authorizeShopTool`.
- **On every tool call:** `agent-tools.ts` authorizes again:
  - profile active;
  - role in the rollout;
  - `app:shopee` + `channel:view`;
  - `ai_user_shop_access` grant;
  - the product belongs to that shop (identity = shop + item).
- Conversation context (remembered shop / product) is convenience only and is re-checked every time.
- A tool returning `AUTH_DENIED` aborts the answer.

## Limits, cost, cache

- **`ai_usage_logs`**, one row per request, `running` → `completed` / `failed`, or `cache_hit` / `rejected`:
  - provider, model, prompt version, channel, user, shop, product, analysis type;
  - tokens as reported by the API (input / output / cache read / cache write);
  - estimated cost: NULL if the price is unknown;
  - tool calls and tool trace (names only);
  - model turns, total / model / tool ms, error category.
  - **No prompt or answer text.**
- **Limits:** the same table drives one running analysis per user, per-minute and per-day counts, and the daily cost cap, each with a friendly message.
- **`ai_analysis_cache`:**
  - **Key:** prompt version + model family + shop + product + period + data version + question hash. The data version is the freshness of the sales and Ads facts, so a new sync invalidates the cache.
  - **TTL:** 15 min for periods that include today, 6 h otherwise.
  - Only first questions of a thread are cached; answers that used history are not.
  - The user is not in the key: authorization runs **before** the cache is read, so a revoked grant gets `AUTH_DENIED`, not a cached answer.
- **No automatic runs:** never all products on a schedule (`ANALYSIS_RUN_POLICY`). PA-4 runs only on a user question or an explicit UI request.

## Channels

### Zalo

The flow, data protection and linking are in [zalo-ai-agent-architecture.md](zalo-ai-agent-architecture.md). In short:
- **Unlinked users** never reach the model.
- **Mutation requests** are refused without analysis.
- **Product phrases:** resolved deterministically in the current shop. An item id or SKU must match exactly; a name must contain all the words. Several matches → a short list to choose from. None → "không tìm thấy".
- **Follow-ups:** "còn hôm qua?" and free-form follow-ups reuse the shop / product for 2 h.
- **History:** at most the 8 most recent turns are sent.
- **Answers:** Kết luận / Bằng chứng (≤ 5) / Khả năng / Độ tin cậy / Nên kiểm tra (≤ 3) / Chưa có dữ liệu, in at most 3 messages.

### Web

`/apps/shopee/ai` lives in the Shopee shell.
- **Context:** shop, product and period live in the URL and are re-validated on the server.
- **Opening the page** makes no model call.
- **Entry from a product:** the "Phân tích với AI" button on the product detail page preselects the shop, product and period.
- **Chat:** suggested questions are sent only when clicked. One analysis runs at a time; Enter sends and Shift+Enter adds a new line.
- **Thread:** one per user, separate from Zalo. Answers are re-rendered from `ai_messages.analysis`.
- Works at 390 px and in dark mode.

## Errors (user-facing copy)

| Category | Message (short) |
| --- | --- |
| `AUTH_DENIED` | Bạn không có quyền xem dữ liệu này. |
| `PRODUCT_NOT_FOUND` | Không tìm thấy sản phẩm này trong shop bạn đang chọn. |
| `AMBIGUOUS_PRODUCT` | Có nhiều sản phẩm khớp… (with the list) |
| `DATA_UNAVAILABLE` | Chưa đọc được dữ liệu cho kỳ này… |
| `AI_PROVIDER_ERROR` / `TOOL_ERROR` / `OUTPUT_INVALID` | Mình chưa phân tích được dữ liệu lúc này. Bạn thử lại sau hoặc xem trực tiếp trong Phân tích Shopee. |
| `AI_RATE_LIMIT` | Trợ lý đang bận… |
| `TIMEOUT` | Phân tích mất quá nhiều thời gian… |
| `LIMIT_REACHED` | Per-minute / concurrent / daily / cost wording, or "cần quá nhiều bước". |

No stack trace or provider error text ever reaches a user. Logs carry only event, category, tool names, token counts and timings.

## Known data gaps (stated to users as missing data)

- Visitors, add-to-cart and full-product traffic sources: only Ads impressions and clicks exist.
- Search ranking.
- Competitor / market data.
- COGS / profit.
- **Snapshot counters** (views, sale, likes, rating, comments) are a current snapshot only, never a trend.
- **Sales vs Broad / Direct Ads GMV:** these are not disjoint. There is no organic remainder, and the attribution indicator can exceed 100%.

## Tests

- **`src/lib/product-analyst/product-analyst.test.ts`** (unit, no network). Covers:
  - config and cost;
  - secrets and client bundle;
  - prompt and injection fencing;
  - contract;
  - attribution / organic / causation / profit / market / mutation / leak guards;
  - null-as-zero and partial today;
  - numeric grounding;
  - tool allowlist and schemas;
  - raw-data guard and size;
  - period mapping;
  - Zalo formatting;
  - the Claude loop against a scripted SDK client (tool budget, repair, refusal, truncation, timeout).
- **`product-analyst.integration.test.ts`** (local DB + production replica; skipped with a reason when the replica is missing). Covers:
  - real tools: size and raw data;
  - the authorization matrix;
  - the usage log and cache, and that the cache respects authorization;
  - limits;
  - invalid answers blocked;
  - provider errors;
  - the Zalo E2E through a signed webhook: unknown user, LINK, analysis, duplicate, follow-up, ambiguous / unknown product, other shop, mutation, provider error;
  - the web channel.
- **`scripts/e2e/product-analyst-web.ts`** (Playwright, dev server with the fake provider).
- **`scripts/e2e/hydration-check.ts`.**
- **Live pilot (opt-in):** `RUN_AI_LIVE_TESTS=true ANTHROPIC_API_KEY=… node --env-file=.env.local scripts/ai/product-analyst-pilot.ts <outDir>`. It runs the 10-question set (spec §117) on the local replica with the real Claude provider and reports tokens, cost and latency (p50 / p95 / max), plus cache hits. It never runs in `npm test`.

## Enabling (in order; user decision)

1. Run `supabase db push` (00072), then `NOTIFY pgrst, 'reload schema'`.
2. Set `ANTHROPIC_API_KEY` (server only) and `AI_PRODUCT_ANALYST_ENABLED=true`. No channel is on yet.
3. Run the live pilot locally. Review numeric accuracy, grounding, causality wording, missing-data disclosure, permission behaviour, cost and latency.
4. Set `AI_PRODUCT_ANALYST_WEB_ENABLED=true`. This gives admin-only web access with your own shop grants.
5. Set `AI_PRODUCT_ANALYST_ZALO_ENABLED=true`, optionally with `AI_PRODUCT_ANALYST_ALLOWED_USER_IDS`. Zalo signature, linking and outbound were already verified on production (PA-1P).
