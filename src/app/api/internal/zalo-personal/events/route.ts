// ZALO PERSONAL Phase 02 — POST /api/internal/zalo-personal/events (worker → backend).
// Public in src/proxy.ts (/api/internal/ prefix) because the caller is the
// zca-js worker, not a user: it authenticates with its own HMAC signature
// (src/lib/zalo-personal/ingest.ts). CORS is NOT an authentication mechanism
// and no CORS headers are sent. Off unless ZALO_PERSONAL_INGEST_ENABLED=true.
//
// Phase 04.5 realtime: when the batch stored a message, a reply tick runs
// right after the response (after()) instead of waiting for the minute cron.
import { after, NextResponse } from "next/server";

import { handleWorkerRequest } from "@/lib/zalo-personal/ingest";
import { getZaloPersonalIngestDeps } from "@/lib/zalo-personal/server";
import { triggerFastReply } from "@/lib/zalo-reply/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// the after() reply tick (scan lag + pipeline / Gemini) runs inside this budget
export const maxDuration = 60;

function storedMessage(body: unknown): boolean {
  const results = (body as { results?: unknown })?.results;
  return Array.isArray(results) && results.some((r) => (r as { status?: unknown })?.status === "stored");
}

export async function POST(request: Request) {
  const deps = getZaloPersonalIngestDeps();
  // refuse an oversized body before reading it when the length is declared
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > deps.config.maxBodyBytes) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  try {
    const rawBody = await request.text();
    const outcome = await handleWorkerRequest("events", { method: "POST", path: new URL(request.url).pathname, header: (n) => request.headers.get(n), rawBody }, deps);
    if (outcome.status === 200 && storedMessage(outcome.body)) {
      after(async () => {
        try {
          await triggerFastReply();
        } catch (err) {
          console.error(JSON.stringify({ source: "zalo-reply", event: "fast_tick_failed", error: err instanceof Error ? err.name : "unknown" }));
        }
      });
    }
    return NextResponse.json(outcome.body, { status: outcome.status, headers: { "Cache-Control": "no-store", ...outcome.headers } });
  } catch (err) {
    console.error(JSON.stringify({ source: "zalo-personal-ingest", event: "failed", endpoint: "events", error: err instanceof Error ? err.name : "unknown" }));
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
