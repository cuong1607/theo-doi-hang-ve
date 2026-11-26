// PHASE 04.5 — POST /api/internal/zalo-personal/outbound/result (worker → backend).
// HMAC-authenticated like /events. Records the delivery outcome of a claimed
// reply (sent / not_sent / failed / unknown); idempotent per claim token.
import { NextResponse } from "next/server";

import { handleOutbound } from "@/lib/zalo-reply/outbound";
import { getOutboundDeps } from "@/lib/zalo-reply/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const deps = getOutboundDeps();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 16 * 1024) return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  try {
    const rawBody = await request.text();
    const outcome = await handleOutbound("result", { method: "POST", path: new URL(request.url).pathname, header: (n) => request.headers.get(n), rawBody }, deps);
    return NextResponse.json(outcome.body, { status: outcome.status, headers: { "Cache-Control": "no-store", ...outcome.headers } });
  } catch (err) {
    console.error(JSON.stringify({ source: "zalo-reply-outbound", event: "failed", kind: "result", error: err instanceof Error ? err.name : "unknown" }));
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
