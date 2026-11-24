// ZALO PERSONAL Phase 04 — summaries + structured memory of ONE readable conversation
// (validated lazily: memory whose sources were deleted / consent withdrawn shows as stale).
import { getMemory } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { guarded, parseInput } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  return guarded("ai:memory", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).conversationId);
    if (!id.ok) return id.response;
    return respondAi(await getMemory(gate.deps, gate.actor, id.data));
  });
}
