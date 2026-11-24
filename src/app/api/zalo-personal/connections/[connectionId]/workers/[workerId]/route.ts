// ZALO PERSONAL — the OWNER revokes a worker: its requests are refused (403) from now on. Audited.
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { revokeWorker } from "@/lib/zalo-personal/dashboard/self-service";
import { authorizeZaloApi, getSelfServiceDeps, guarded, parseInput, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ connectionId: string; workerId: string }> }) {
  return guarded("worker:revoke", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const p = await params;
    const id = parseInput(idParam, p.connectionId);
    if (!id.ok) return id.response;
    const worker = parseInput(idParam, p.workerId);
    if (!worker.ok) return worker.response;
    return respond(await revokeWorker(getSelfServiceDeps(), gate.actor, id.data, worker.data));
  });
}
