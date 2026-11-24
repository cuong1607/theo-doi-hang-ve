// ZALO PERSONAL Phase 03 — DELETE (revoke) one access grant (owner only; audited, the row is kept).
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { revokeAccess } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ connectionId: string; grantId: string }> }) {
  return guarded("access:revoke", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const p = await params;
    const connectionId = parseInput(idParam, p.connectionId);
    if (!connectionId.ok) return connectionId.response;
    const grantId = parseInput(idParam, p.grantId);
    if (!grantId.ok) return grantId.response;
    return respond(await revokeAccess(gate.deps, gate.actor, connectionId.data, grantId.data));
  });
}
