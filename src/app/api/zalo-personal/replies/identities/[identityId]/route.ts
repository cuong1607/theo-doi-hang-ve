// PHASE 04.5 — DELETE (revoke) one of the caller's OWN Zalo Personal identity links.
import { idParam } from "@/lib/zalo-reply/contracts";
import { authorizeReplyApi, respondReply } from "@/lib/zalo-reply/server";
import { revokeIdentity } from "@/lib/zalo-reply/service";
import { guarded, parseInput } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ identityId: string }> }) {
  return guarded("replies:identity_revoke", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).identityId);
    if (!id.ok) return id.response;
    return respondReply(await revokeIdentity(gate.deps, gate.actor, id.data));
  });
}
