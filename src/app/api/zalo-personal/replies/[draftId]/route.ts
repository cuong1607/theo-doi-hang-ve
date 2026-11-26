// PHASE 04.5 — GET one draft (source, proposed answer, citations, audit). Out of scope → 404.
import { idParam } from "@/lib/zalo-reply/contracts";
import { authorizeReplyApi, respondReply } from "@/lib/zalo-reply/server";
import { getDraft } from "@/lib/zalo-reply/service";
import { guarded, parseInput } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  return guarded("replies:get", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).draftId);
    if (!id.ok) return id.response;
    return respondReply(await getDraft(gate.deps, gate.actor, id.data));
  });
}
