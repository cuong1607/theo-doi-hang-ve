// ZALO PERSONAL Phase 04 — the caller's OWN Ask AI sessions (never anybody else's).
import { sessionsQuery } from "@/lib/zalo-personal/ai/contracts";
import { listSessions } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { guarded, parseInput, searchParamsObject } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guarded("ai:sessions", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    const q = parseInput(sessionsQuery, searchParamsObject(request.url));
    if (!q.ok) return q.response;
    return respondAi(await listSessions(gate.deps, gate.actor, q.data.limit));
  });
}
