// ============================================================
// PRODUCT-ANALYTICS-4: AnalystStore on Supabase (service-role client; tables
// of migration 00072). No "server-only" marker so integration tests can
// import it; server wiring is in ./server.ts.
// Usage rows carry counts / timings / tool NAMES only — never text.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadShopFreshness } from "../product-analytics/read-model.ts";
import type { AnalystOutput } from "./contracts.ts";
import type { AnalystStore, ProductIdentity, UsageRunFinish, UsageRunStart } from "./orchestrator.ts";

function check(error: { message: string; code?: string } | null, what: string): void {
  if (error) throw new Error(`analyst store: ${what} failed (${error.code ?? "?"})`);
}

const RUN_STATUSES = ["running", "completed", "failed"];

export class SupabaseAnalystStore implements AnalystStore {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async startRun(row: UsageRunStart): Promise<string> {
    const final = row.status !== "running";
    const { data, error } = await this.db
      .from("ai_usage_logs")
      .insert({
        provider: row.provider,
        model: row.model,
        prompt_version: row.promptVersion,
        channel: row.channel,
        conversation_id: row.conversationId,
        internal_user_id: row.internalUserId,
        shop_id: row.shopId,
        product_id: row.productId,
        analysis_type: row.analysisType,
        status: row.status,
        error_category: row.errorCategory ?? null,
        cache_key: row.cacheKey ?? null,
        tool_trace: row.toolTrace ?? [],
        finished_at: final ? new Date().toISOString() : null,
        duration_ms: final ? 0 : null,
      })
      .select("id")
      .single<{ id: string }>();
    check(error, "startRun");
    return data!.id;
  }

  async finishRun(id: string, p: UsageRunFinish): Promise<void> {
    const n = (v: number) => Math.max(0, Math.round(v));
    const { error } = await this.db
      .from("ai_usage_logs")
      .update({
        status: p.status,
        error_category: p.errorCategory,
        input_tokens: n(p.usage.inputTokens),
        output_tokens: n(p.usage.outputTokens),
        cached_input_tokens: n(p.usage.cacheReadTokens),
        cache_write_tokens: n(p.usage.cacheWriteTokens),
        estimated_cost: p.estimatedCost,
        tool_calls: n(p.toolCalls),
        tool_trace: p.toolTrace,
        model_turns: n(p.modelTurns),
        duration_ms: n(p.durationMs),
        model_ms: n(p.modelMs),
        tool_ms: n(p.toolMs),
        finished_at: new Date().toISOString(),
      })
      .eq("id", id);
    check(error, "finishRun");
  }

  async countRuns(internalUserId: string, sinceIso: string): Promise<number> {
    const { count, error } = await this.db.from("ai_usage_logs").select("id", { count: "exact", head: true }).eq("internal_user_id", internalUserId).gte("created_at", sinceIso).in("status", RUN_STATUSES);
    check(error, "countRuns");
    return count ?? 0;
  }

  async countRunning(internalUserId: string, sinceIso: string): Promise<number> {
    const { count, error } = await this.db.from("ai_usage_logs").select("id", { count: "exact", head: true }).eq("internal_user_id", internalUserId).eq("status", "running").gte("created_at", sinceIso);
    check(error, "countRunning");
    return count ?? 0;
  }

  async costSince(sinceIso: string): Promise<number> {
    let total = 0;
    // bounded: a day of analyses is far below this; paged under the 1000-row cap
    for (let page = 0; page < 20; page++) {
      const { data, error } = await this.db.from("ai_usage_logs").select("estimated_cost").gte("created_at", sinceIso).not("estimated_cost", "is", null).order("created_at").range(page * 1000, page * 1000 + 999);
      check(error, "costSince");
      const rows = (data ?? []) as Array<{ estimated_cost: number | string }>;
      total += rows.reduce((s, r) => s + Number(r.estimated_cost), 0);
      if (rows.length < 1000) break;
    }
    return total;
  }

  async cacheGet(key: string, now: Date): Promise<{ output: AnalystOutput; toolTrace: string[] } | null> {
    const { data, error } = await this.db.from("ai_analysis_cache").select("output, tool_trace").eq("cache_key", key).gt("expires_at", now.toISOString()).maybeSingle<{ output: AnalystOutput; tool_trace: string[] }>();
    check(error, "cacheGet");
    return data ? { output: data.output, toolTrace: data.tool_trace ?? [] } : null;
  }

  async cachePut(row: { key: string; shopId: string; productId: string | null; promptVersion: string; model: string; dataVersion: string; output: AnalystOutput; toolTrace: string[]; expiresAt: Date }): Promise<void> {
    const { error } = await this.db.from("ai_analysis_cache").upsert(
      { cache_key: row.key, shop_id: row.shopId, product_id: row.productId, prompt_version: row.promptVersion, model: row.model, data_version: row.dataVersion.slice(0, 200), output: row.output, tool_trace: row.toolTrace, created_at: new Date().toISOString(), expires_at: row.expiresAt.toISOString() },
      { onConflict: "cache_key" },
    );
    check(error, "cachePut");
  }

  async shopName(shopId: string): Promise<string | null> {
    const { data, error } = await this.db.from("shops").select("shop_name").eq("id", shopId).maybeSingle<{ shop_name: string }>();
    check(error, "shopName");
    return data?.shop_name ?? null;
  }

  async product(productId: string): Promise<ProductIdentity | null> {
    const { data, error } = await this.db.from("shopee_products").select("id, shop_id, provider_item_id, name, sku").eq("id", productId).maybeSingle<{ id: string; shop_id: string; provider_item_id: string; name: string | null; sku: string | null }>();
    check(error, "product");
    return data ? { id: data.id, shopId: data.shop_id, itemId: data.provider_item_id, name: data.name, sku: data.sku } : null;
  }

  async dataVersion(shopId: string): Promise<string> {
    const f = (await loadShopFreshness(this.db, [shopId])).get(shopId);
    return `${f?.sales_last_success_at ?? "-"}|${f?.ads_campaign_today_at ?? "-"}`;
  }
}
