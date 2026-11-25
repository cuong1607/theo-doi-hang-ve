// PHASE 06 — GET the tasks the reader may see (server-side paging inside the Phase 03 scope).
import { listTasksQuery } from "@/lib/ai-tasks/contracts";
import { authorizeTasksApi, respondTasks } from "@/lib/ai-tasks/server";
import { listTasks } from "@/lib/ai-tasks/service";
import { guarded, parseInput, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guarded("tasks:list", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    const q = parseInput(listTasksQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    const { conversation, ...rest } = q.data;
    return respondTasks(await listTasks(gate.deps, gate.actor, { ...rest, conversationId: conversation } as Parameters<typeof listTasks>[2]));
  });
}
