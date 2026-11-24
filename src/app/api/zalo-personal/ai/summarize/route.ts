// ZALO PERSONAL Phase 04 — on-demand summary of ONE conversation the user may read.
// Reuses an identical fresh summary (same source messages) instead of calling the model again.
import { summarizeBody } from "@/lib/zalo-personal/ai/contracts";
import { summarize } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return guarded("ai:summarize", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(summarizeBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondAi(await summarize(gate.deps, gate.actor, body.data));
  });
}
