// ZALO PERSONAL Phase 03 — POST message search. Criteria travel in the body (search text never in the URL);
// scope checked before the query, time window ≤ 92 days, ≤ 100 results.
import { searchBody } from "@/lib/zalo-personal/dashboard/contracts";
import { searchMessages } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, readJson, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guarded("search", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(searchBody, await readJson(request));
    if (!body.ok) return body.response;
    return respond(await searchMessages(gate.deps, gate.actor, body.data));
  });
}
