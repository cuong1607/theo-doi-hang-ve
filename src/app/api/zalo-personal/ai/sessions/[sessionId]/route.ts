// ZALO PERSONAL Phase 04 — one OWN session; each answer is re-checked against the CURRENT
// scope (an answer resting on a conversation the user can no longer read is hidden).
import { getSession } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { guarded, parseInput } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  return guarded("ai:session", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).sessionId);
    if (!id.ok) return id.response;
    return respondAi(await getSession(gate.deps, gate.actor, id.data));
  });
}
