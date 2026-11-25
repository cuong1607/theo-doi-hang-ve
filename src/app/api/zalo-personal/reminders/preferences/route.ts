// PHASE 06 — GET / PATCH (full set) the session user's own reminder preferences. External channels are a
// stored preference only: nothing is sent while the global flags / kill switch keep them off.
import { preferencesBody } from "@/lib/ai-tasks/contracts";
import { authorizeTasksApi, respondTasks } from "@/lib/ai-tasks/server";
import { getPreferences, savePreferences } from "@/lib/ai-tasks/service";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guarded("reminders:prefs:get", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    return respondTasks(await getPreferences(gate.deps, gate.actor));
  });
}

export async function PATCH(request: Request) {
  return guarded("reminders:prefs:put", async () => {
    const gate = await authorizeTasksApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(preferencesBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondTasks(await savePreferences(gate.deps, gate.actor, body.data));
  });
}
