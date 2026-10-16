// PHASE SHOPEE-PERF-2 — /api/internal/shopee/latency-probe (region benchmark)
//
// Measures, from wherever this function runs (VERCEL_REGION), the two round
// trips every sync step is made of:
//   supabase  N × a one-row PostgREST select (the shape of a sync DB call)
//   shopee    N × v2.order.get_order_list over the last minute (read-only,
//             usually empty) for the first live shop
// Read-only, secret-protected, no payload in the response. Call it before
// and after changing "regions" in vercel.json; the job metadata
// (latencyMs per api) gives the same numbers for real sync traffic.
import { NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { getShopee } from "@/lib/channels/shopee/server";
import { RealShopeeOrderProvider } from "@/lib/channels/shopee/order-provider";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUNDS = 5;

function summarize(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const p50 = s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  return { n: s.length, p50, min: s[0] ?? null, max: s.at(-1) ?? null, avg: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null, samples };
}

export async function GET(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers.get("authorization"), process.env)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const supabase: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t = performance.now();
    const { error } = await db.from("shops").select("id").limit(1);
    if (error) return NextResponse.json({ ok: false, error: "supabase_failed" }, { status: 500 });
    supabase.push(Math.round(performance.now() - t));
  }

  const shopee: number[] = [];
  let shopeeError: string | null = null;
  const { data: shop } = await db.from("shops").select("id, external_shop_id").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true).limit(1).maybeSingle();
  if (shop) {
    try {
      const { client, service } = getShopee();
      const provider = new RealShopeeOrderProvider({ client, connections: service });
      const ctx = { shopId: shop.id as string, externalShopId: shop.external_shop_id as string };
      await service.getValidAccessToken(ctx.shopId); // token lookup outside the timed calls
      const to = Math.floor(Date.now() / 1000);
      for (let i = 0; i < ROUNDS; i++) {
        const t = performance.now();
        await provider.listOrders(ctx, { timeRangeField: "update_time", timeFrom: to - 60, timeTo: to, pageSize: 1, cursor: "" });
        shopee.push(Math.round(performance.now() - t));
      }
    } catch (err) {
      shopeeError = err instanceof Error ? err.message.slice(0, 200) : "failed";
    }
  } else {
    shopeeError = "no_live_shop";
  }

  return NextResponse.json({
    ok: true,
    region: process.env.VERCEL_REGION ?? "local",
    measuredAt: new Date().toISOString(),
    supabaseSelectMs: summarize(supabase),
    shopeeGetOrderListMs: summarize(shopee),
    shopeeError,
  });
}
