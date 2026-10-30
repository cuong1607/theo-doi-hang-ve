// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part B): Zalo OA webhook.
//
// Verify (fail closed) → parse → dedupe + store → answer 200 quickly.
// Linking / authorization / context / agent / reply run in after(), so a
// slow step never makes Zalo time out and redeliver. No model is called
// from here (the conversation service talks to the analyst interface).
// Off unless ZALO_CONVERSATION_ENABLED=true.
// ============================================================
import { after, NextResponse } from "next/server";

import { getConversationDeps } from "@/lib/conversation/server";
import { acceptIncomingMessage, processAcceptedMessage } from "@/lib/conversation/service";
import { getZaloWebhookConfig, handleZaloWebhookRequest, SenderRateLimiter } from "@/lib/zalo/webhook-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const limiter = new SenderRateLimiter();

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 64_000) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const config = getZaloWebhookConfig();
  const deps = config.enabled ? getConversationDeps() : null;
  try {
    const outcome = await handleZaloWebhookRequest(
      { rawBody, signatureHeader: request.headers.get("x-zevent-signature"), config, now: new Date() },
      { accept: (message) => acceptIncomingMessage(deps!, message), limiter },
    );
    if ("accepted" in outcome) {
      const accepted = outcome.accepted;
      after(async () => {
        try {
          const result = await processAcceptedMessage(deps!, accepted);
          console.info(JSON.stringify({ source: "zalo-webhook", event: "processed", outcome: result }));
        } catch (err) {
          console.error(JSON.stringify({ source: "zalo-webhook", event: "process_failed", error: err instanceof Error ? err.name : "unknown" }));
          await deps!.store.setInboundStatus(accepted.messageId, "failed", "process_error").catch(() => {});
        }
      });
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (err) {
    console.error(JSON.stringify({ source: "zalo-webhook", event: "accept_failed", error: err instanceof Error ? err.name : "unknown" }));
    // 500 → Zalo may redeliver; idempotency makes that safe
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
