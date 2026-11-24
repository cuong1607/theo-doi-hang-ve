// ZALO PERSONAL Phase 04 — whether Ask AI can call the provider (switches, data policy, model).
// Never returns the API key or whether a particular value of it is set beyond "configured".
import { aiStatus } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { guarded } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guarded("ai:status", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    return respondAi(await aiStatus(gate.deps, gate.actor));
  });
}
