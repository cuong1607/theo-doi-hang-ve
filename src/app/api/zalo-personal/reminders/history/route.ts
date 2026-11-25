// PHASE 06 — GET the session user's own reminder occurrences (+ engine health: counts only).
import { historyQuery } from "@/lib/ai-tasks/contracts";
import { authorizeTasksApi, respondTasks } from "@/lib/ai-tasks/server";
import { reminderHistory } from "@/lib/ai-tasks/service";
import { guarded, parseInput, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guarded("reminders:history", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    const q = parseInput(historyQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respondTasks(await reminderHistory(gate.deps, gate.actor, q.data));
  });
}
