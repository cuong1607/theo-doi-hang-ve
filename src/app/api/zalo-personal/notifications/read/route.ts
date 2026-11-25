// PHASE 06 — POST mark own notifications read ({ ids } or { all: true }). Only rows of the session user.
import { markReadBody } from "@/lib/ai-tasks/contracts";
import { authorizeTasksApi, respondTasks } from "@/lib/ai-tasks/server";
import { markNotificationsRead } from "@/lib/ai-tasks/service";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guarded("notifications:read", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(markReadBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondTasks(await markNotificationsRead(gate.deps, gate.actor, "ids" in body.data ? body.data.ids : null));
  });
}
