"use server";

// SHOPEE-2 server actions for the product mapping screen. Every action
// authorizes server-side (hidden buttons are UX only) and re-validates ids;
// nothing about products is taken from the browser except the two ids.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { searchInternalProducts, type InternalProductOption } from "@/lib/channels/core/product-queries";
import {
  autoMapChannelModels,
  changeChannelModelMappingControlled,
  mapChannelModelToProduct,
  unmapChannelModel,
  type AutoMapResult,
} from "@/lib/channels/core/sku-mapping";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { createAdminClient } from "@/lib/supabase/admin";

// Mapping changes also change order readiness → revalidate every /shopee screen.
const PATH = "/shopee";
const uuid = z.string().uuid();

export type ActionResult<T = undefined> = { ok: true; message: string; data?: T } | { ok: false; message: string };

// SHOPEE-PERF-1: product sync is no longer run from a request — the screen
// enqueues a job (../sync/actions.ts) and the background worker syncs.

export async function autoMapShopeeProductsAction(shopId: string): Promise<ActionResult<AutoMapResult>> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(shopId).success) return { ok: false, message: "Shop không hợp lệ." };
  const db = createAdminClient();
  const { data: shop } = await db.from("shops").select("id").eq("id", shopId).eq("channel", "shopee").maybeSingle();
  if (!shop) return { ok: false, message: "Không tìm thấy shop." };
  const result = await autoMapChannelModels(db, shopId);
  revalidatePath(PATH, "layout");
  return {
    ok: true,
    message: `Đã quét ${result.scanned}: ghép ${result.mapped}, chưa ghép ${result.unmapped}, xung đột ${result.conflicts}.`,
    data: result,
  };
}

export async function mapChannelModelAction(input: { channelModelId: string; internalProductId: string }): Promise<ActionResult> {
  const authz = await authorizeAction("channel:map");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(input?.channelModelId).success || !uuid.safeParse(input?.internalProductId).success) {
    return { ok: false, message: "Dữ liệu không hợp lệ." };
  }
  const result = await mapChannelModelToProduct(createAdminClient(), {
    channelModelId: input.channelModelId,
    internalProductId: input.internalProductId,
    mappedBy: authz.auth.user.id,
  });
  if (!result.ok) return result;
  revalidatePath(PATH, "layout");
  return { ok: true, message: "Đã ghép SKU." };
}

/**
 * Controlled remap of a unit already used by orders (admin only): requires a
 * reason, audited, affects future order lines only (history keeps its snapshot).
 */
export async function changeUsedChannelModelMappingAction(input: { channelModelId: string; internalProductId: string; reason: string }): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(input?.channelModelId).success || !uuid.safeParse(input?.internalProductId).success || typeof input?.reason !== "string") {
    return { ok: false, message: "Dữ liệu không hợp lệ." };
  }
  const result = await changeChannelModelMappingControlled(createAdminClient(), {
    channelModelId: input.channelModelId,
    internalProductId: input.internalProductId,
    reason: input.reason.slice(0, 500),
    changedBy: authz.auth.user.id,
  });
  if (!result.ok) return result;
  revalidatePath(PATH, "layout");
  return { ok: true, message: "Đã điều chỉnh mapping (áp dụng cho đơn hàng mới; đơn cũ giữ nguyên)." };
}

export async function unmapChannelModelAction(channelModelId: string): Promise<ActionResult> {
  const authz = await authorizeAction("channel:map");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(channelModelId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const result = await unmapChannelModel(createAdminClient(), { channelModelId });
  if (!result.ok) return result;
  revalidatePath(PATH, "layout");
  return { ok: true, message: "Đã bỏ ghép." };
}

export async function searchInternalProductsAction(term: string): Promise<InternalProductOption[]> {
  const authz = await authorizeAction("channel:map");
  if (!authz.ok || typeof term !== "string") return [];
  return searchInternalProducts(term.slice(0, 100));
}

/** Development-only helper: a clearly-labelled fixture shop (never in production unless explicitly enabled). */
export async function createFixtureShopAction(): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!getShopeeProviderMode().fixtureAllowed) return { ok: false, message: "Fixture mode không được bật trên môi trường này." };
  const { error } = await createAdminClient()
    .from("shops")
    .upsert(
      { channel: "shopee", external_shop_id: "FIXTURE_SHOP_001", shop_name: "[FIXTURE] Shop thử nghiệm", currency: "VND", region: "VN", data_source: "fixture" },
      { onConflict: "channel,external_shop_id", ignoreDuplicates: true },
    );
  if (error) return { ok: false, message: "Không tạo được shop fixture." };
  revalidatePath(PATH, "layout");
  return { ok: true, message: "Đã tạo shop fixture FIXTURE_SHOP_001." };
}
