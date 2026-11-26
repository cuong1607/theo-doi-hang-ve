// PHASE 04.5 — POST control actions: pause / resume sending (owner), auto-reply
// allowlist (owner, consent note required), block list (owner), global
// emergency stop (any module user) / resume (admin only). Audited.
import { controlBody } from "@/lib/zalo-reply/contracts";
import { authorizeReplyApi, respondReply } from "@/lib/zalo-reply/server";
import { control } from "@/lib/zalo-reply/service";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guarded("replies:control", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(controlBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondReply(await control(gate.deps, gate.actor, body.data));
  });
}
