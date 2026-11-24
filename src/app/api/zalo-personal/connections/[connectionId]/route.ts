// ZALO PERSONAL — the OWNER pauses / resumes a connection (the server then rejects / accepts
// its events). Ownership re-checked in SQL; audited.
import { connectionStatusBody, idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { setConnectionStatus } from "@/lib/zalo-personal/dashboard/self-service";
import { authorizeZaloApi, getSelfServiceDeps, guarded, parseInput, readJson, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  return guarded("connection:status", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).connectionId);
    if (!id.ok) return id.response;
    const body = parseInput(connectionStatusBody, await readJson(request));
    if (!body.ok) return body.response;
    return respond(await setConnectionStatus(getSelfServiceDeps(), gate.actor, id.data, body.data.status));
  });
}
