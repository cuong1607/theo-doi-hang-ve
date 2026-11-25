// PHASE 06 — POST an action on a task (confirm, dismiss, edit, start, progress, complete,
// cancel, reopen, accept / reject a deadline proposal). The per-task role comes from the
// server-side scope; the revision makes concurrent edits fail cleanly (409).
import { actionBody, idParam } from "@/lib/ai-tasks/contracts";
import { authorizeTasksApi, respondTasks } from "@/lib/ai-tasks/server";
import { actOnTask, type ActionInput } from "@/lib/ai-tasks/service";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return guarded("tasks:action", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).taskId);
    if (!id.ok) return id.response;
    const body = parseInput(actionBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondTasks(await actOnTask(gate.deps, gate.actor, id.data, body.data as ActionInput));
  });
}
