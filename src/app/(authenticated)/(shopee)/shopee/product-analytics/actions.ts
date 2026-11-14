"use server";

// PRODUCT-ANALYTICS-2: admin controls of the isolated product analytics reads.
//   * per-shop switches (sales facts / extra-info snapshots) — rollout pilot
//   * "Làm mới" = QUEUE one read-only job; the browser never calls Shopee
// Admin only (channel:manage). Never touches the legacy order / product jobs.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { enqueueProductAnalyticsJob, PRODUCT_EXTRA_INFO_SYNC_TYPE, PRODUCT_SALES_SYNC_TYPE } from "@/lib/channels/shopee/product-analytics/sales-sync";
import { createAdminClient } from "@/lib/supabase/admin";

const PATH = "/shopee/product-analytics";

export async function setProductAnalyticsShopSwitch(formData: FormData): Promise<void> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return;
  const parsed = z
    .object({ shopId: z.string().uuid(), field: z.enum(["sales_sync_enabled", "extra_info_enabled"]), value: z.enum(["true", "false"]) })
    .safeParse({ shopId: formData.get("shopId"), field: formData.get("field"), value: formData.get("value") });
  if (!parsed.success) return;
  const db = createAdminClient();
  const { data: shop } = await db.from("shops").select("id").eq("id", parsed.data.shopId).eq("channel", "shopee").maybeSingle();
  if (!shop) return;
  const on = parsed.data.value === "true";
  const { error } = await db
    .from("product_analytics_shop_settings")
    .upsert({ shop_id: parsed.data.shopId, [parsed.data.field]: on, ...(on ? { enabled_at: new Date().toISOString() } : {}), updated_by: authz.auth.user.id }, { onConflict: "shop_id" });
  if (error) console.error(JSON.stringify({ source: "product-analytics", event: "switch_failed", shopId: parsed.data.shopId, message: error.message.slice(0, 160) }));
  else console.info(JSON.stringify({ source: "product-analytics", event: "switch_changed", shopId: parsed.data.shopId, field: parsed.data.field, value: on, by: authz.auth.user.id }));
  revalidatePath(PATH);
}

export async function queueProductAnalyticsRefresh(formData: FormData): Promise<void> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return;
  const parsed = z.object({ shopId: z.string().uuid(), kind: z.enum(["sales", "backfill", "extra"]) }).safeParse({ shopId: formData.get("shopId"), kind: formData.get("kind") });
  if (!parsed.success) return;
  const db = createAdminClient();
  const { data: shop } = await db.from("shops").select("id").eq("id", parsed.data.shopId).eq("channel", "shopee").eq("is_active", true).maybeSingle();
  if (!shop) return;
  const r = await enqueueProductAnalyticsJob(db, {
    shopId: parsed.data.shopId,
    syncType: parsed.data.kind === "extra" ? PRODUCT_EXTRA_INFO_SYNC_TYPE : PRODUCT_SALES_SYNC_TYPE,
    strategy: parsed.data.kind === "backfill" ? "backfill" : parsed.data.kind === "extra" ? "extra" : "manual",
    createdBy: authz.auth.user.id,
  }).catch((e: unknown) => {
    console.error(JSON.stringify({ source: "product-analytics", event: "refresh_enqueue_failed", shopId: parsed.data.shopId, message: e instanceof Error ? e.message.slice(0, 160) : "unknown" }));
    return null;
  });
  if (r) console.info(JSON.stringify({ source: "product-analytics", event: "refresh_queued", shopId: parsed.data.shopId, kind: parsed.data.kind, jobId: r.jobId, created: r.created, by: authz.auth.user.id }));
  revalidatePath(PATH);
}
