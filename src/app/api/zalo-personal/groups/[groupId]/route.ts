// ZALO PERSONAL Phase 03 — PATCH a group's monitoring mode / consent. Authorized on the server
// (owner or manage grant), checked again by the database (consent, interactive), audited in the same transaction.
import { idParam, updateGroupBody } from "@/lib/zalo-personal/dashboard/contracts";
import { updateGroup } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, readJson, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ groupId: string }> }) {
  return guarded("group:update", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).groupId);
    if (!id.ok) return id.response;
    const body = parseInput(updateGroupBody, await readJson(request));
    if (!body.ok) return body.response;
    return respond(await updateGroup(gate.deps, gate.actor, id.data, body.data));
  });
}
