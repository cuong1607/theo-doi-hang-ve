// ZALO PERSONAL Phase 03 — GET conversations in the reader's scope (server-side paging, newest first).
import { listConversationsQuery } from "@/lib/zalo-personal/dashboard/contracts";
import { listConversations } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, respond, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guarded("conversations", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const q = parseInput(listConversationsQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respond(await listConversations(gate.deps, gate.actor, q.data));
  });
}
