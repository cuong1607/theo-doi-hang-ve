// ZALO PERSONAL Phase 03 — GET groups (server-side paging) of the connections the reader may see.
import { listGroupsQuery } from "@/lib/zalo-personal/dashboard/contracts";
import { listGroups } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, respond, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guarded("groups", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const q = parseInput(listGroupsQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respond(await listGroups(gate.deps, gate.actor, q.data));
  });
}
