// PHASE 04.5 — /api/internal/zalo-personal/reply/tick
//
// Called every minute by pg_cron → pg_net (migration 00079,
// public.zp_reply_cron_tick; dormant until the Vault secret 'zp_reply_tick_url'
// exists). Bearer = the existing internal secret. One bounded tick: recover →
// scan → drafts. It never sends a Zalo message (the worker does, after approval).
import { NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplyTick } from "@/lib/zalo-reply/engine";
import { runOpsCheck } from "@/lib/zalo-reply/ops";
import { getReplyEngineDeps, replyEnabled } from "@/lib/zalo-reply/server";
import { SupabaseReplyStore } from "@/lib/zalo-reply/supabase-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers.get("authorization"), process.env)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!replyEnabled()) return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 503 });
  const region = (process.env.VERCEL_REGION ?? "local").toLowerCase().replace(/[^a-z0-9]/g, "");
  const workerId = `reply-${region}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const deps = getReplyEngineDeps(workerId, request.signal);
    const r = await runReplyTick(deps);
    // PHASE 07 (OPS-07): last tick + health of every connection (alerts on state changes only)
    const store = new SupabaseReplyStore(createAdminClient());
    await store.recordTick(r.status).catch(() => {});
    const ops = await runOpsCheck(store, { now: new Date(), replyEnabled: true }).catch(() => null);
    return NextResponse.json({ ok: r.status !== "error", status: r.status, stats: r.stats, ops }, { status: r.status === "error" ? 500 : 200 });
  } catch (err) {
    console.error(JSON.stringify({ source: "zalo-reply", event: "tick_failed", error: err instanceof Error ? err.name : "unknown" }));
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
