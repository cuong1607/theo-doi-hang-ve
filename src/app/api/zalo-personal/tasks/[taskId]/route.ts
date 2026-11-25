// PHASE 06 — GET one task (out of scope → 404, no existence leak). Source messages are re-loaded and re-checked.
import { idParam } from "@/lib/ai-tasks/contracts";
import { authorizeTasksApi, respondTasks } from "@/lib/ai-tasks/server";
import { getTask } from "@/lib/ai-tasks/service";
import { guarded, parseInput } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return guarded("tasks:get", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).taskId);
    if (!id.ok) return id.response;
    return respondTasks(await getTask(gate.deps, gate.actor, id.data));
  });
}
