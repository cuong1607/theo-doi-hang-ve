// ZALO PERSONAL Phase 04 — Ask AI. Question + filters in the POST body (never the URL).
// Scope, period, budget, data policy and citations are all decided on the server.
import { askBody } from "@/lib/zalo-personal/ai/contracts";
import { ask } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return guarded("ai:ask", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(askBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondAi(await ask(gate.deps, gate.actor, body.data));
  });
}
