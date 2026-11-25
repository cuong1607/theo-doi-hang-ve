// PHASE 06 — /api/internal/ai-tasks/tick
//
// Called every minute by Supabase pg_cron → pg_net (migration 00078,
// public.ai_tasks_cron_tick; dormant until the Vault secret 'ai_tasks_tick_url'
// exists). Bearer = the existing internal secret (SHOPEE_SYNC_INTERNAL_SECRET /
// SYNC_WORKER_SECRET / CRON_SECRET). One bounded tick: scan → extract → overdue
// → morning → reminders. Safe to run twice at once (leases + SKIP LOCKED +
// unique keys). The request's abort signal stops it between steps (graceful).
import { NextResponse } from "next/server";

import { runTick } from "@/lib/ai-tasks/engine";
import { getEngineDeps, tasksEnabled } from "@/lib/ai-tasks/server";
import { isAuthorizedInternalRequest } from "@/lib/cron/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers.get("authorization"), process.env)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!tasksEnabled()) return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 503 });
  const region = (process.env.VERCEL_REGION ?? "local").toLowerCase().replace(/[^a-z0-9]/g, "");
  const workerId = `tick-${region}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const r = await runTick(getEngineDeps(workerId, request.signal));
    return NextResponse.json({ ok: r.status !== "error", status: r.status, stats: r.stats }, { status: r.status === "error" ? 500 : 200 });
  } catch (err) {
    console.error(JSON.stringify({ source: "ai-tasks", event: "tick_failed", error: err instanceof Error ? err.name : "unknown" }));
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
