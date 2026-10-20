// ============================================================
// PHASE SHOPEE-6B: return-logistics sync (operational only — never moves
// stock, never touches COGS / money).
//
//   return_logistics  Hoàn Trả: get_reverse_tracking_info per return
//   failed_delivery   Hoàn Hủy: get_tracking_number (once) + get_tracking_info
//                     per cancelled-after-pickup order
//
// Candidates come from SQL (return_logistics_candidates /
// failed_delivery_candidates): not delivered yet → polled when older than
// the open TTL; delivered within 2 days → re-polled (provider corrections)
// when older than the delivered TTL. A manual / pre-notification job
// (mode manual) refreshes everything not touched since the job started, plus
// the operations of the focused business date. Each candidate's outcome is
// its own: one broken return never blocks the others.
// Every observation goes through apply_return_operation (one transaction:
// operation + item snapshot + events + attention).
// ============================================================
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { saveMeaningfulOrderSnapshot } from "../core/snapshots.ts";
import { continuation, firstFailureSummary, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../core/sync-runner.ts";
import { mapWithConcurrency } from "../core/time-windows.ts";
import { ShopeePayloadError } from "./product-adapter.ts";
import { parseFailedDeliveryTracking, parseReverseTrackingInfo, parseTrackingNumber, RETURN_LOGISTICS_API, toApplyOperationEvents, type ReturnLogisticsFacts } from "./return-logistics-adapter.ts";
import type { ReturnLogisticsProviderContext, ShopeeReturnLogisticsProvider } from "./return-logistics-provider.ts";
import { errorInfo, isJobLevelProviderError, JobRefusedError } from "./sync-errors.ts";

export const RETURN_LOGISTICS_SYNC_TYPE = "return_logistics";
export const FAILED_DELIVERY_SYNC_TYPE = "failed_delivery";

const DEFAULT_LOOKBACK_DAYS = 45;
const MAX_FAILED_TRACKED = 200;

type Shop = { id: string; channel: string; external_shop_id: string; data_source: string };

export interface CustomerReturnCandidate {
  return_id: string;
  external_return_sn: string;
  order_id: string;
  operation_id: string | null;
}

export interface FailedDeliveryCandidate {
  order_id: string;
  external_order_sn: string;
  package_number: string | null;
  operation_id: string | null;
  tracking_number: string | null;
}

export type ReturnLogisticsOutcome =
  | { status: "stored"; created: boolean; delivered: boolean; deliveredChanged: boolean; canonicalStatus: string }
  | { status: "failed"; code: string; message: string };

const logEvent = (event: Record<string, unknown>) => console.info(JSON.stringify({ source: "shopee-return-logistics", ...event }));

function factsFingerprint(f: ReturnLogisticsFacts): string {
  const ev = f.events.map((e) => `${e.segment}:${e.eventTime}:${e.providerStatus ?? "-"}`).join(",");
  return createHash("sha256").update(`${f.segment}|${f.providerStatus}|${f.deliveredToSellerAt}|${f.trackingNumber}|${f.rtsTrackingNumber}|${ev}`).digest("hex").slice(0, 32);
}

export class ShopeeReturnLogisticsSyncService {
  private readonly db: SupabaseClient;
  private readonly provider: ShopeeReturnLogisticsProvider;
  private readonly now: () => Date;

  constructor(deps: { db: SupabaseClient; provider: ShopeeReturnLogisticsProvider; now?: () => Date }) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.now = deps.now ?? (() => new Date());
  }

  get mode() {
    return this.provider.mode;
  }

  /** Hoàn Trả: one return's reverse / post-return logistics → canonical operation. */
  async syncCustomerReturn(target: { shopId: string; ctx: ReturnLogisticsProviderContext }, c: CustomerReturnCandidate): Promise<ReturnLogisticsOutcome> {
    let facts: ReturnLogisticsFacts;
    let raw: unknown;
    try {
      const payload = await this.provider.getReverseTrackingInfo(target.ctx, { returnSn: c.external_return_sn });
      raw = payload.raw;
      facts = parseReverseTrackingInfo(raw);
    } catch (err) {
      if (isJobLevelProviderError(err)) throw err;
      const info = err instanceof ShopeePayloadError ? { code: "provider_error", message: err.message } : errorInfo(err);
      // first sighting: still create the operation (visible as "chờ vận chuyển") so nothing is invisible
      if (!c.operation_id) {
        await this.apply(target.shopId, { operation_type: "customer_return", channel_order_id: c.order_id, return_id: c.return_id, return_sn: c.external_return_sn, canonical_status: "pending", sync_notes: [`reverse_tracking_error:${info.code}`] }, []);
      }
      return { status: "failed", code: info.code, message: info.message };
    }
    const syncedAt = this.now().toISOString();
    await this.snapshot(target.shopId, c.external_return_sn, RETURN_LOGISTICS_API.reverse, raw, factsFingerprint(facts), syncedAt);
    const fallbackTracking = facts.trackingNumber ?? (await this.returnTracking(c.return_id));
    const r = await this.apply(
      target.shopId,
      {
        operation_type: "customer_return",
        channel_order_id: c.order_id,
        return_id: c.return_id,
        return_sn: c.external_return_sn,
        provider_return_id: c.external_return_sn,
        tracking_number: fallbackTracking,
        rts_tracking_number: facts.rtsTrackingNumber,
        logistics_provider: facts.logisticsProvider,
        provider_status: facts.providerStatus,
        canonical_status: facts.canonicalStatus,
        source_segment: facts.segment,
        delivered_to_seller_at: facts.deliveredToSellerAt,
        delivered_at_source: facts.deliveredAtSource,
        last_status_at: facts.lastStatusAt,
        sync_notes: facts.notes,
      },
      toApplyOperationEvents(facts),
      syncedAt,
    );
    logEvent({ event: "customer_return_logistics_synced", returnSn: c.external_return_sn, status: facts.canonicalStatus, delivered: facts.deliveredToSellerAt, source: facts.deliveredAtSource, notes: facts.notes });
    return { status: "stored", created: r.created, delivered: !!facts.deliveredToSellerAt, deliveredChanged: r.delivered_changed, canonicalStatus: facts.canonicalStatus };
  }

  /** Hoàn Hủy: one cancelled-after-pickup order's RTS tracking → canonical operation. */
  async syncFailedDelivery(target: { shopId: string; ctx: ReturnLogisticsProviderContext }, c: FailedDeliveryCandidate): Promise<ReturnLogisticsOutcome> {
    let tracking = c.tracking_number;
    let facts: ReturnLogisticsFacts;
    let raw: unknown;
    try {
      if (!tracking) {
        const tn = await this.provider.getTrackingNumber(target.ctx, { orderSn: c.external_order_sn, packageNumber: c.package_number });
        tracking = parseTrackingNumber(tn.raw);
      }
      const payload = await this.provider.getTrackingInfo(target.ctx, { orderSn: c.external_order_sn, packageNumber: c.package_number });
      raw = payload.raw;
      facts = parseFailedDeliveryTracking(raw, tracking);
    } catch (err) {
      if (isJobLevelProviderError(err)) throw err;
      const info = err instanceof ShopeePayloadError ? { code: "provider_error", message: err.message } : errorInfo(err);
      if (!c.operation_id) {
        await this.apply(target.shopId, { operation_type: "failed_delivery_return", channel_order_id: c.order_id, tracking_number: tracking, canonical_status: "pending", sync_notes: [`tracking_error:${info.code}`] }, []);
      }
      return { status: "failed", code: info.code, message: info.message };
    }
    const syncedAt = this.now().toISOString();
    await this.snapshot(target.shopId, c.external_order_sn, RETURN_LOGISTICS_API.trackingInfo, raw, factsFingerprint(facts), syncedAt);
    const r = await this.apply(
      target.shopId,
      {
        operation_type: "failed_delivery_return",
        channel_order_id: c.order_id,
        tracking_number: tracking,
        provider_status: facts.providerStatus,
        canonical_status: facts.canonicalStatus,
        source_segment: facts.segment,
        delivered_to_seller_at: facts.deliveredToSellerAt,
        delivered_at_source: facts.deliveredAtSource,
        last_status_at: facts.lastStatusAt,
        sync_notes: facts.notes,
      },
      toApplyOperationEvents(facts),
      syncedAt,
    );
    logEvent({ event: "failed_delivery_logistics_synced", orderSn: c.external_order_sn, status: facts.canonicalStatus, delivered: facts.deliveredToSellerAt });
    return { status: "stored", created: r.created, delivered: !!facts.deliveredToSellerAt, deliveredChanged: r.delivered_changed, canonicalStatus: facts.canonicalStatus };
  }

  private async apply(shopId: string, op: Record<string, unknown>, events: unknown[], syncedAt = this.now().toISOString()) {
    const { data, error } = await this.db.rpc("apply_return_operation", { p_shop_id: shopId, p_op: op, p_events: events, p_synced_at: syncedAt });
    if (error) throw new Error(`Không lưu được đơn hoàn: ${error.message} [${error.code ?? ""}]`);
    return data as { id: string; created: boolean; delivered_changed: boolean };
  }

  private async returnTracking(returnId: string): Promise<string | null> {
    const { data } = await this.db.from("channel_returns").select("tracking_number").eq("id", returnId).maybeSingle<{ tracking_number: string | null }>();
    return data?.tracking_number ?? null;
  }

  private async snapshot(shopId: string, key: string, apiName: string, raw: unknown, fingerprint: string, syncedAt: string) {
    const response = raw && typeof raw === "object" && "response" in raw ? (raw as { response: unknown }).response : raw;
    await saveMeaningfulOrderSnapshot(this.db, { shopId, orderSn: key, entityType: "return_logistics", apiName, payload: response, fingerprint, sourceMode: this.provider.mode, syncedAt });
  }
}

export interface ReturnLogisticsCheckpoint {
  /** Manual jobs: refresh everything not polled since this instant. */
  since: string;
  focusDate: string | null;
  /** Candidates that failed in THIS job (not re-tried within it). */
  failed: string[];
}

export class ReturnLogisticsJobRunner implements SyncJobRunner {
  private readonly db: SupabaseClient;
  private readonly sync: ShopeeReturnLogisticsSyncService;
  private readonly providerMode: string;
  private readonly kind: "customer_return" | "failed_delivery_return";

  constructor(deps: { db: SupabaseClient; sync: ShopeeReturnLogisticsSyncService; providerMode: string; kind: "customer_return" | "failed_delivery_return" }) {
    this.db = deps.db;
    this.sync = deps.sync;
    this.providerMode = deps.providerMode;
    this.kind = deps.kind;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, config, now } = input;
    const progress = input.progress as SliceInput<ReturnLogisticsCheckpoint>["progress"];
    const shop = await this.loadShop(job.shop_id);
    const ctx: ReturnLogisticsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    if (!progress.checkpoint) {
      const scope = progress.meta.scope as { focusDate?: unknown } | undefined;
      progress.checkpoint = { since: now().toISOString(), focusDate: typeof scope?.focusDate === "string" ? scope.focusDate : null, failed: [] };
      progress.meta.providerMode = this.providerMode;
      if ((await lease.checkpoint(progress.toPatch({ windowFrom: null, windowTo: progress.checkpoint.since }))).cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint!;
    const lookback = await this.lookbackDays();
    const manual = job.mode === "manual" || job.mode === "repair";
    const openSince = manual ? cp.since : new Date(now().getTime() - config.returnLogisticsOpenTtlMinutes * 60_000).toISOString();
    const deliveredSince = manual ? cp.since : new Date(now().getTime() - config.returnLogisticsDeliveredTtlHours * 3_600_000).toISOString();
    const callsPer = this.kind === "customer_return" ? 1 : 2;

    for (;;) {
      if (budget.expired || !budget.canSpend(callsPer)) return continuation(budget, "more_records");
      const want = Math.max(1, Math.min(config.returnDetailConcurrency * 2, Math.floor(budget.apiCallsLeft / callsPer)));
      const failed = new Set(cp.failed);
      const batch = (await this.candidates(shop.id, openSince, deliveredSince, lookback, want + failed.size, cp.focusDate)).filter((c) => !failed.has(this.keyOf(c))).slice(0, want);
      if (batch.length === 0) break;
      progress.counters.fetched += batch.length;
      await mapWithConcurrency(batch, config.returnDetailConcurrency, async (c) => {
        const outcome =
          this.kind === "customer_return"
            ? await this.sync.syncCustomerReturn({ shopId: shop.id, ctx }, c as CustomerReturnCandidate)
            : await this.sync.syncFailedDelivery({ shopId: shop.id, ctx }, c as FailedDeliveryCandidate);
        progress.incrIn("outcomes", outcome.status);
        if (outcome.status === "stored") {
          if (outcome.created) progress.counters.created++;
          else progress.counters.updated++;
          progress.incrIn("statuses", outcome.canonicalStatus);
          if (outcome.deliveredChanged) progress.incr("deliveredCorrected");
        } else {
          cp.failed = [...cp.failed, this.keyOf(c)].slice(-MAX_FAILED_TRACKED);
          progress.addFailure({ externalId: this.keyOf(c), reason: `${outcome.code}: ${outcome.message}` });
        }
      });
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }

    const { error } = await this.db.rpc("refresh_return_operation_attention", { p_shop_id: shop.id, p_operation_id: null });
    if (error) progress.addFailure({ externalId: null, reason: `attention: ${error.message}` });
    const failureCount = progress.failureCount;
    const summary = firstFailureSummary(progress.failures, failureCount);
    const logStatus = failureCount === 0 ? "success" : "partial";
    return {
      kind: "done",
      logStatus,
      advanceCheckpoint: logStatus === "success",
      windowFrom: null,
      windowTo: cp.since,
      errorCode: summary?.code ?? null,
      errorMessage: summary?.message ?? null,
    };
  }

  private keyOf(c: CustomerReturnCandidate | FailedDeliveryCandidate): string {
    return "external_return_sn" in c ? c.external_return_sn : c.external_order_sn;
  }

  private async candidates(shopId: string, openSince: string, deliveredSince: string, lookback: number, limit: number, focusDate: string | null) {
    const rpc = this.kind === "customer_return" ? "return_logistics_candidates" : "failed_delivery_candidates";
    const { data, error } = await this.db.rpc(rpc, {
      p_shop_id: shopId,
      p_open_since: openSince,
      p_delivered_since: deliveredSince,
      p_lookback_days: lookback,
      p_limit: limit,
      p_focus_date: focusDate,
    });
    if (error) throw new Error(`Không đọc được danh sách cần theo dõi vận chuyển hoàn: ${error.message}`);
    return (data ?? []) as Array<CustomerReturnCandidate | FailedDeliveryCandidate>;
  }

  private async lookbackDays(): Promise<number> {
    const { data } = await this.db.from("return_operation_settings").select("tracking_lookback_days").eq("id", true).maybeSingle<{ tracking_lookback_days: number }>();
    return data?.tracking_lookback_days ?? DEFAULT_LOOKBACK_DAYS;
  }

  private async loadShop(shopId: string): Promise<Shop> {
    const { data, error } = await this.db.from("shops").select("id, channel, external_shop_id, data_source").eq("id", shopId).maybeSingle<Shop>();
    if (error) throw new Error(`Không đọc được shop: ${error.message}`);
    if (!data) throw new JobRefusedError("shop_not_found", "Không tìm thấy shop.");
    if (data.channel !== "shopee") throw new JobRefusedError("not_shopee", "Shop không thuộc kênh Shopee.");
    if (data.data_source !== this.providerMode) {
      throw new JobRefusedError("source_mismatch", data.data_source === "fixture" ? "Shop fixture chỉ được đồng bộ bằng fixture provider." : "Không được đồng bộ dữ liệu fixture vào shop thật.");
    }
    return data;
  }
}
