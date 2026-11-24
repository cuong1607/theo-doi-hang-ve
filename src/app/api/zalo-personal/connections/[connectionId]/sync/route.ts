// ZALO PERSONAL Phase 03 — GET sync status + errors of one connection (worker state, status history,
// ingestion outcomes, recent ingestion events). Needs view_sync on that connection, else 404.
import { idParam, syncEventsQuery } from "@/lib/zalo-personal/dashboard/contracts";
import { getSync } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, respond, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  return guarded("sync", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).connectionId);
    if (!id.ok) return id.response;
    const q = parseInput(syncEventsQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respond(await getSync(gate.deps, gate.actor, id.data, q.data));
  });
}
