// ZALO PERSONAL Phase 04 — a person confirms / rejects an AI-inferred memory item
// (owner or manage grant). AI output never becomes "confirmed" by itself.
import { reviewFactBody } from "@/lib/zalo-personal/ai/contracts";
import { reviewFact } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ factId: string }> }) {
  return guarded("ai:fact", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).factId);
    if (!id.ok) return id.response;
    const body = parseInput(reviewFactBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondAi(await reviewFact(gate.deps, gate.actor, id.data, body.data.evidence));
  });
}
