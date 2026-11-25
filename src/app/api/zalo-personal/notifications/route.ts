// PHASE 06 — GET the reader's Web Inbox (own rows only; bodies re-checked against the current scope).
import { notificationsQuery } from "@/lib/ai-tasks/contracts";
import { authorizeTasksApi, respondTasks } from "@/lib/ai-tasks/server";
import { listNotifications } from "@/lib/ai-tasks/service";
import { guarded, parseInput, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guarded("notifications:list", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    const q = parseInput(notificationsQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respondTasks(await listNotifications(gate.deps, gate.actor, q.data));
  });
}
