// PHASE 04.5 — GET AI Reply Inbox / Outbound History (drafts the reader may review).
import { listQuery } from "@/lib/zalo-reply/contracts";
import { authorizeReplyApi, respondReply } from "@/lib/zalo-reply/server";
import { listDrafts } from "@/lib/zalo-reply/service";
import { guarded, parseInput, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guarded("replies:list", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    const q = parseInput(listQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respondReply(await listDrafts(gate.deps, gate.actor, q.data));
  });
}
