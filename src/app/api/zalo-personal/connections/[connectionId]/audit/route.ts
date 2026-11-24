// ZALO PERSONAL Phase 03 — GET the audit log of one connection (owner or manage grant).
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { listAudit } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  return guarded("audit", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).connectionId);
    if (!id.ok) return id.response;
    return respond(await listAudit(gate.deps, gate.actor, id.data));
  });
}
