// ZALO PERSONAL Phase 03 — GET one conversation's messages, newest first, keyset "load more"
// (beforeAt + beforeId). Never the whole history at once (limit ≤ 100).
import { idParam, listMessagesQuery } from "@/lib/zalo-personal/dashboard/contracts";
import { listMessages } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, respond, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  return guarded("messages", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).conversationId);
    if (!id.ok) return id.response;
    const q = parseInput(listMessagesQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respond(await listMessages(gate.deps, gate.actor, id.data, q.data));
  });
}
