// PHASE 04.5 — /api/internal/zalo-personal/reply/tick
//
// Called every minute by pg_cron → pg_net (migration 00079,
// public.zp_reply_cron_tick; dormant until the Vault secret 'zp_reply_tick_url'
// exists). Bearer = the existing internal secret. One bounded tick: recover →
// scan → drafts. It never sends a Zalo message (the worker does, after approval).
import { NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { runReplyTick } from "@/lib/zalo-reply/engine";
import { getReplyEngineDeps, replyEnabled } from "@/lib/zalo-reply/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers.get("authorization"), process.env)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!replyEnabled()) return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 503 });
  const region = (process.env.VERCEL_REGION ?? "local").toLowerCase().replace(/[^a-z0-9]/g, "");
  const workerId = `reply-${region}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const r = await runReplyTick(getReplyEngineDeps(workerId, request.signal));
    return NextResponse.json({ ok: r.status !== "error", status: r.status, stats: r.stats }, { status: r.status === "error" ? 500 : 200 });
  } catch (err) {
    console.error(JSON.stringify({ source: "zalo-reply", event: "tick_failed", error: err instanceof Error ? err.name : "unknown" }));
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
