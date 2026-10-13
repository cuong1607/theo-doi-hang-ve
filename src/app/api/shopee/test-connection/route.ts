// SHOPEE-1 — POST /api/shopee/test-connection { shopId }: one read-only
// Shopee call (get_shop_info) to prove the stored connection works.
//
// Admin only. shopId is our internal shops.id, validated server-side; the
// response never contains tokens — only ok/requestId/latency/error code.
import { NextResponse, type NextRequest } from "next/server";

import { authorizeRoute } from "@/lib/auth/session";
import { ShopeeConfigError } from "@/lib/channels/shopee/config";
import { getShopee } from "@/lib/channels/shopee/server";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const authz = await authorizeRoute("channel:manage");
  if (!authz.ok) return authz.response;

  let shopId: unknown;
  try {
    ({ shopId } = (await request.json()) as { shopId?: unknown });
  } catch {
    shopId = undefined;
  }
  if (typeof shopId !== "string" || !UUID.test(shopId)) {
    return NextResponse.json({ success: false, errorMessage: "shopId không hợp lệ." }, { status: 400 });
  }

  try {
    const result = await getShopee().service.testConnection(shopId);
    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 502 });
  } catch (err) {
    const message = err instanceof ShopeeConfigError ? err.message : "Không thể kiểm tra kết nối Shopee.";
    return NextResponse.json({ success: false, errorMessage: message }, { status: 500 });
  }
}
