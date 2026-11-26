// PHASE 04.5 — POST a review action (approve, edit, reject, cancel, confirm_sent,
// confirm_not_sent). Reviewer rights come from the server-side scope; the version
// makes a concurrent change fail cleanly (409). Approving only QUEUES the reply:
// the worker sends it after the database re-checks every gate.
import { actionBody, idParam } from "@/lib/zalo-reply/contracts";
import { authorizeReplyApi, respondReply } from "@/lib/zalo-reply/server";
import { actOnDraft } from "@/lib/zalo-reply/service";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  return guarded("replies:action", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).draftId);
    if (!id.ok) return id.response;
    const body = parseInput(actionBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondReply(await actOnDraft(gate.deps, gate.actor, id.data, body.data));
  });
}
